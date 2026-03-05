import crypto from "node:crypto";

import { AsyncSemaphore } from "./async-semaphore.js";
import { CircuitBreakerRegistry } from "./circuit-breaker.js";
import { buildMemoryContextBlock, mergeMemoryBuckets } from "./context-merge.js";

function createMemoryController({
  config,
  logger,
  mem0Adapter,
  zepAdapter,
  mnemosyneAdapter,
  redisCache,
}) {
  const controllerLogger = logger.child({ service: "memory-controller" });
  const memoryMode = config.memory.mode;
  const writeSemaphore = new AsyncSemaphore(config.memory.writeConcurrencyLimit);
  const circuitBreakers = new CircuitBreakerRegistry({
    failureThreshold: config.memory.circuitBreaker.failureThreshold,
    windowMs: config.memory.circuitBreaker.windowMs,
    cooldownMs: config.memory.circuitBreaker.cooldownMs,
  });
  const conversationQueues = new Map();

  async function retrieveContext({
    scopeKey,
    conversationId,
    query,
    modelId,
    requestId,
    logger: requestLogger,
  }) {
    const operationLogger = requestLogger || controllerLogger;
    if (memoryMode === "off") {
      return emptyContext({
        cacheHit: false,
        partial: false,
        coldStart: true,
      });
    }

    const startedAt = Date.now();
    const deadline = startedAt + config.memory.retrievalBudgetMs;
    const normalizedQuery = normalizeQueryForCache(query);
    const identityLookup = await runAdapter({
      adapterName: "redis",
      operationName: "getIdentityContext",
      timeoutMs: config.memory.timeouts.redisMs,
      deadline,
      requestId,
      logger: operationLogger,
      operation: () => redisCache.getIdentityContext(scopeKey),
      countResults: true,
    });

    let identityMemories = identityLookup.ok && Array.isArray(identityLookup.value)
      ? identityLookup.value
      : [];
    if (identityMemories.length === 0) {
      const fetchedIdentity = await runAdapter({
        adapterName: "mnemosyne",
        operationName: "getIdentityContext",
        timeoutMs: config.memory.timeouts.mnemosyneMs,
        deadline,
        requestId,
        logger: operationLogger,
        operation: () => mnemosyneAdapter.getIdentityContext({ scopeKey }),
        countResults: true,
      });
      identityMemories = fetchedIdentity.ok && Array.isArray(fetchedIdentity.value)
        ? fetchedIdentity.value
        : [];
      if (identityMemories.length > 0) {
        void runAdapter({
          adapterName: "redis",
          operationName: "setIdentityContext",
          timeoutMs: config.memory.timeouts.redisMs,
          deadline: Date.now() + config.memory.timeouts.redisMs,
          requestId,
          logger: operationLogger,
          operation: () => redisCache.setIdentityContext(scopeKey, identityMemories),
          countResults: false,
          skipCircuitBreaker: true,
        });
      }
    }

    const semanticProbe = await runAdapter({
      adapterName: "mnemosyne",
      operationName: "hasScopeMemories",
      timeoutMs: config.memory.timeouts.mnemosyneMs,
      deadline,
      requestId,
      logger: operationLogger,
      operation: () => mnemosyneAdapter.hasScopeMemories({ scopeKey }),
      countResults: false,
    });
    const hasSemanticAny = semanticProbe.ok ? Boolean(semanticProbe.value) : false;
    if (identityMemories.length === 0 && !hasSemanticAny) {
      operationLogger.debug(
        {
          requestId,
          scopeKey,
          retrievalLatencyMs: Date.now() - startedAt,
        },
        "Memory retrieval cold-start short-circuit returned empty context"
      );
      return emptyContext({
        cacheHit: false,
        partial: false,
        coldStart: true,
      });
    }

    const queryCache = await runAdapter({
      adapterName: "redis",
      operationName: "getQueryContext",
      timeoutMs: config.memory.timeouts.redisMs,
      deadline,
      requestId,
      logger: operationLogger,
      operation: () => redisCache.getQueryContext(scopeKey, normalizedQuery),
      countResults: false,
    });
    if (queryCache.ok && queryCache.value && typeof queryCache.value === "object") {
      const mergedFromCache = queryCache.value;
      const contextBlock = buildMemoryContextBlock({
        merged: mergedFromCache,
        modelId,
        maxTokens: config.memory.contextMaxTokens,
      });

      const response = {
        contextBlock,
        partial: false,
        cacheHit: true,
        coldStart: false,
        budgetExceeded: Date.now() > deadline,
        identityMemories: mergedFromCache.identity || [],
        graphMemories: mergedFromCache.graph || [],
        semanticMemories: mergedFromCache.semantic || [],
        episodicSummaries: mergedFromCache.episodic || [],
      };
      operationLogger.info(
        {
          requestId,
          memoryRetrieveLatencyMs: Date.now() - startedAt,
          memoryCacheHit: true,
        },
        "Memory retrieval completed from cache"
      );
      return response;
    }

    const [graphResult, semanticResult, episodicResult] = await Promise.all([
      runAdapter({
        adapterName: "zep",
        operationName: "search",
        timeoutMs: config.memory.timeouts.zepMs,
        deadline,
        requestId,
        logger: operationLogger,
        operation: () =>
          zepAdapter.search({
            scopeKey,
            query: normalizedQuery,
            limit: config.memory.graphMaxResults,
          }),
        countResults: true,
      }),
      runAdapter({
        adapterName: "mnemosyne",
        operationName: "searchSemantic",
        timeoutMs: config.memory.timeouts.mnemosyneMs,
        deadline,
        requestId,
        logger: operationLogger,
        operation: () =>
          mnemosyneAdapter.searchSemantic({
            scopeKey,
            query: normalizedQuery,
            topK: config.memory.semanticTopK,
          }),
        countResults: true,
      }),
      runAdapter({
        adapterName: "mnemosyne",
        operationName: "getEpisodicSummaries",
        timeoutMs: config.memory.timeouts.mnemosyneMs,
        deadline,
        requestId,
        logger: operationLogger,
        operation: () =>
          mnemosyneAdapter.getEpisodicSummaries({
            scopeKey,
            maxItems: config.memory.episodicTopK,
          }),
        countResults: true,
      }),
    ]);

    const merged = mergeMemoryBuckets({
      identityMemories,
      graphMemories: graphResult.ok ? graphResult.value : [],
      semanticMemories: semanticResult.ok ? semanticResult.value : [],
      episodicSummaries: episodicResult.ok ? episodicResult.value : [],
    });
    const contextBlock = buildMemoryContextBlock({
      merged,
      modelId,
      maxTokens: config.memory.contextMaxTokens,
    });

    const partial = !graphResult.ok || !semanticResult.ok || !episodicResult.ok || Date.now() > deadline;
    const budgetExceeded = Date.now() > deadline;

    if (contextBlock) {
      void runAdapter({
        adapterName: "redis",
        operationName: "setQueryContext",
        timeoutMs: config.memory.timeouts.redisMs,
        deadline: Date.now() + config.memory.timeouts.redisMs,
        requestId,
        logger: operationLogger,
        operation: () => redisCache.setQueryContext(scopeKey, normalizedQuery, merged),
        countResults: false,
        skipCircuitBreaker: true,
      });
    }

    operationLogger.info(
      {
        requestId,
        memoryRetrieveLatencyMs: Date.now() - startedAt,
        memoryCacheHit: false,
        partial,
        budgetExceeded,
        graphCount: merged.graph.length,
        semanticCount: merged.semantic.length,
        episodicCount: merged.episodic.length,
      },
      "Memory retrieval completed"
    );

    return {
      contextBlock,
      partial,
      cacheHit: false,
      coldStart: false,
      budgetExceeded,
      identityMemories: merged.identity,
      graphMemories: merged.graph,
      semanticMemories: merged.semantic,
      episodicSummaries: merged.episodic,
    };
  }

  async function processMessage({
    scopeKey,
    conversationId,
    role,
    turnIndex,
    messageText,
    timestamp = new Date().toISOString(),
    modelId,
    requestId,
    logger: requestLogger,
  }) {
    if (!scopeKey || !conversationId || !messageText || memoryMode === "off") {
      return { skipped: true, reason: "missing_context_or_memory_off" };
    }

    return enqueueByConversation(conversationId, async () => {
      const operationLogger = requestLogger || controllerLogger;
      const startedAt = Date.now();
      await writeSemaphore.acquire();
      try {
        const messageId = createMessageId({
          conversationId,
          role,
          turnIndex,
          messageText,
        });

        const duplicateLookup = await runAdapter({
          adapterName: "mnemosyne",
          operationName: "hasMessageId",
          timeoutMs: config.memory.timeouts.mnemosyneMs,
          deadline: Date.now() + config.memory.timeouts.mnemosyneMs,
          requestId,
          logger: operationLogger,
          operation: () => mnemosyneAdapter.hasMessageId(messageId),
          countResults: false,
        });
        if (duplicateLookup.ok && duplicateLookup.value === true) {
          return {
            skipped: true,
            reason: "duplicate_message_id",
            messageId,
          };
        }

        await runAdapter({
          adapterName: "mnemosyne",
          operationName: "storeEpisodic",
          timeoutMs: config.memory.timeouts.mnemosyneMs,
          deadline: Date.now() + config.memory.timeouts.mnemosyneMs,
          requestId,
          logger: operationLogger,
          operation: () =>
            mnemosyneAdapter.storeEpisodic({
              scopeKey,
              conversationId,
              role,
              turnIndex,
              messageText,
              messageId,
              timestamp,
            }),
          countResults: false,
        });

        const extractedFacts = await runAdapter({
          adapterName: "mem0",
          operationName: "extractFacts",
          timeoutMs: config.memory.timeouts.mem0Ms,
          deadline: Date.now() + config.memory.timeouts.mem0Ms,
          requestId,
          logger: operationLogger,
          operation: () =>
            mem0Adapter.extractFacts({
              scopeKey,
              conversationId,
              role,
              messageText,
              messageId,
              timestamp,
              modelId,
            }),
          countResults: true,
        });
        const facts = extractedFacts.ok && Array.isArray(extractedFacts.value)
          ? extractedFacts.value
          : [];

        if (facts.length > 0) {
          await Promise.allSettled([
            runAdapter({
              adapterName: "mnemosyne",
              operationName: "upsertSemanticFacts",
              timeoutMs: config.memory.timeouts.mnemosyneMs,
              deadline: Date.now() + config.memory.timeouts.mnemosyneMs,
              requestId,
              logger: operationLogger,
              operation: () => mnemosyneAdapter.upsertSemanticFacts({ scopeKey, facts }),
              countResults: true,
            }),
            runAdapter({
              adapterName: "zep",
              operationName: "upsertFacts",
              timeoutMs: config.memory.timeouts.zepMs,
              deadline: Date.now() + config.memory.timeouts.zepMs,
              requestId,
              logger: operationLogger,
              operation: () => zepAdapter.upsertFacts({ scopeKey, facts }),
              countResults: false,
            }),
            runAdapter({
              adapterName: "redis",
              operationName: "setIdentityContext",
              timeoutMs: config.memory.timeouts.redisMs,
              deadline: Date.now() + config.memory.timeouts.redisMs,
              requestId,
              logger: operationLogger,
              operation: async () => {
                const identityMemories = await mnemosyneAdapter.getIdentityContext({ scopeKey });
                await redisCache.setIdentityContext(scopeKey, identityMemories);
                return identityMemories;
              },
              countResults: true,
              skipCircuitBreaker: true,
            }),
          ]);
        }

        await runAdapter({
          adapterName: "redis",
          operationName: "invalidateScope",
          timeoutMs: config.memory.timeouts.redisMs,
          deadline: Date.now() + config.memory.timeouts.redisMs,
          requestId,
          logger: operationLogger,
          operation: () => redisCache.invalidateScope(scopeKey),
          countResults: false,
          skipCircuitBreaker: true,
        });

        operationLogger.info(
          {
            requestId,
            scopeKey,
            messageId,
            role,
            turnIndex,
            memoryWriteLatencyMs: Date.now() - startedAt,
            extractedFactCount: facts.length,
          },
          "Memory write pipeline completed"
        );

        return {
          skipped: false,
          messageId,
          factsStored: facts.length,
        };
      } catch (error) {
        operationLogger.warn(
          {
            err: error,
            requestId,
            scopeKey,
            role,
            turnIndex,
            memoryWriteLatencyMs: Date.now() - startedAt,
          },
          "Memory write pipeline failed"
        );
        return {
          skipped: false,
          error,
        };
      } finally {
        writeSemaphore.release();
      }
    });
  }

  async function getSubsystemHealth({ logger: requestLogger, requestId } = {}) {
    const operationLogger = requestLogger || controllerLogger;
    const checks = await Promise.allSettled([
      checkHealthAdapter("mem0", mem0Adapter?.ping),
      checkHealthAdapter("zep", zepAdapter?.ping),
      checkHealthAdapter("redis", redisCache?.ping),
      checkHealthAdapter("mnemosyne", mnemosyneAdapter?.ping),
    ]);
    const result = {
      mem0: toHealthStatus(checks[0]),
      zep: toHealthStatus(checks[1]),
      redis: toHealthStatus(checks[2]),
      mnemosyne: toHealthStatus(checks[3]),
    };

    operationLogger.debug({ requestId, memoryHealth: result }, "Resolved memory subsystem health");
    return result;
  }

  async function assertReady({ logger: requestLogger } = {}) {
    if (memoryMode === "off") {
      return;
    }
    const operationLogger = requestLogger || controllerLogger;
    const health = await getSubsystemHealth({ logger: operationLogger });
    if (memoryMode !== "hard") {
      return;
    }

    const expected = {
      mem0: config.memory.mem0Enabled,
      zep: config.memory.zepEnabled,
      redis: config.memory.redisEnabled,
      mnemosyne: true,
    };
    const failed = Object.entries(health).filter(([name, value]) => {
      if (!expected[name]) {
        return false;
      }
      return value.status !== "ok";
    });
    if (failed.length > 0) {
      const names = failed.map(([name]) => name).join(", ");
      throw new Error(`Memory backend health check failed in hard mode: ${names}`);
    }
  }

  async function close() {
    if (typeof redisCache?.close === "function") {
      await redisCache.close();
    }
  }

  function normalizeQueryForCache(raw) {
    return String(raw || "")
      .toLowerCase()
      .trim()
      .slice(0, 256);
  }

  function resolveScopeKey({ conversationId, user }) {
    if (typeof user === "string" && user.trim()) {
      return user.trim();
    }
    return conversationId;
  }

  async function runAdapter({
    adapterName,
    operationName,
    timeoutMs,
    deadline,
    requestId,
    logger: requestLogger,
    operation,
    countResults,
    skipCircuitBreaker = false,
  }) {
    const operationLogger = requestLogger || controllerLogger;
    const startedAt = Date.now();
    const adapterEnabled = isAdapterEnabled(adapterName);
    if (!adapterEnabled) {
      operationLogger.debug(
        { requestId, adapterName, operationName, outcome: "disabled" },
        "Memory adapter skipped because it is disabled"
      );
      return { ok: false, skipped: true, reason: "disabled" };
    }

    if (!skipCircuitBreaker && circuitBreakers.isOpen(adapterName)) {
      operationLogger.warn(
        { requestId, adapterName, operationName, outcome: "circuit_open" },
        "Memory adapter skipped due to circuit breaker"
      );
      return { ok: false, skipped: true, reason: "circuit_open" };
    }

    const remainingBudget = Number.isFinite(deadline) ? deadline - Date.now() : timeoutMs;
    const effectiveTimeout = Math.min(timeoutMs, remainingBudget);
    if (!Number.isFinite(effectiveTimeout) || effectiveTimeout <= 0) {
      return { ok: false, timeout: true, reason: "budget_exhausted" };
    }

    try {
      const value = await withTimeout(operation(), effectiveTimeout);
      if (!skipCircuitBreaker) {
        circuitBreakers.markSuccess(adapterName);
      }
      const durationMs = Date.now() - startedAt;
      const resultCount = countResults && Array.isArray(value) ? value.length : undefined;
      operationLogger.debug(
        {
          requestId,
          adapterName,
          operationName,
          durationMs,
          outcome: "ok",
          ...(resultCount !== undefined ? { resultCount } : {}),
        },
        "Memory adapter call completed"
      );
      return {
        ok: true,
        value,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const timeout = error?.name === "TimeoutError";
      if (!skipCircuitBreaker) {
        circuitBreakers.markFailure(adapterName);
      }
      operationLogger.warn(
        {
          err: error,
          requestId,
          adapterName,
          operationName,
          durationMs,
          outcome: timeout ? "timeout" : "error",
        },
        "Memory adapter call failed"
      );
      return {
        ok: false,
        error,
        timeout,
        durationMs,
      };
    }
  }

  function isAdapterEnabled(adapterName) {
    if (memoryMode === "off") {
      return false;
    }

    if (adapterName === "mem0") {
      return Boolean(mem0Adapter?.enabled);
    }
    if (adapterName === "zep") {
      return Boolean(zepAdapter?.enabled);
    }
    if (adapterName === "mnemosyne") {
      return Boolean(mnemosyneAdapter?.enabled);
    }
    if (adapterName === "redis") {
      return Boolean(redisCache?.enabled);
    }

    return false;
  }

  function enqueueByConversation(conversationId, task) {
    const previous = conversationQueues.get(conversationId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (conversationQueues.get(conversationId) === next) {
          conversationQueues.delete(conversationId);
        }
      });
    conversationQueues.set(conversationId, next);
    return next;
  }

  return {
    retrieveContext,
    processMessage,
    getSubsystemHealth,
    assertReady,
    close,
    normalizeQueryForCache,
    resolveScopeKey,
    createMessageId,
  };
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Operation exceeded timeout of ${timeoutMs}ms`);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createMessageId({ conversationId, role, turnIndex, messageText }) {
  const canonical = [
    String(conversationId || "").trim(),
    String(role || "").trim(),
    Number.isInteger(turnIndex) ? String(turnIndex) : "0",
    normalizeMessageText(messageText),
  ].join("|");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function normalizeMessageText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function checkHealthAdapter(name, pingFn) {
  if (typeof pingFn !== "function") {
    return Promise.resolve({ adapter: name, status: "disabled" });
  }
  return pingFn().then((result) => ({
    adapter: name,
    status: String(result || "OK").toLowerCase() === "disabled" ? "disabled" : "ok",
  }));
}

function toHealthStatus(result) {
  if (result.status === "fulfilled") {
    const value = result.value || {};
    return {
      status: value.status || "ok",
    };
  }
  return {
    status: "error",
    message: result.reason?.message || "health_check_failed",
  };
}

function emptyContext({ cacheHit, partial, coldStart }) {
  return {
    contextBlock: "Memory context:\nNo relevant long-term memories were recalled for this request.",
    cacheHit,
    partial,
    coldStart,
    budgetExceeded: false,
    identityMemories: [],
    graphMemories: [],
    semanticMemories: [],
    episodicSummaries: [],
  };
}

export { createMemoryController, createMessageId };
