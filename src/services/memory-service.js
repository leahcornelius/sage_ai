import { AppError } from "../errors/app-error.js";
import { textLength } from "../logging/safe-debug.js";
import { createMemoryController } from "./memory/memory-controller.js";
import { createMem0Adapter } from "./memory/mem0-adapter.js";
import { createZepAdapter } from "./memory/zep-adapter.js";
import { createMnemosyneAdapter } from "./memory/mnemosyne-adapter.js";
import { createRedisCache } from "./memory/redis-cache.js";

function createMemoryService({
  mnemosyneClient,
  conversationStore,
  config,
  logger,
}) {
  const serviceLogger = logger.child({ service: "memory-service" });
  const mem0Adapter = createMem0Adapter({ config, logger: serviceLogger });
  const zepAdapter = createZepAdapter({ config, logger: serviceLogger });
  const mnemosyneAdapter = createMnemosyneAdapter({
    mnemosyneClient,
    config,
    logger: serviceLogger,
  });
  const redisCache = createRedisCache({
    config,
    logger: serviceLogger,
  });

  const controller = createMemoryController({
    config,
    logger: serviceLogger,
    mem0Adapter,
    zepAdapter,
    mnemosyneAdapter,
    redisCache,
  });

  async function assertReady({ logger: requestLogger } = {}) {
    await controller.assertReady({ logger: requestLogger || serviceLogger });
  }

  async function close() {
    await controller.close();
  }

  async function retrieveContext({
    conversationId,
    user,
    query,
    modelId,
    requestId,
    logger: requestLogger,
  }) {
    const scopeKey = controller.resolveScopeKey({ conversationId, user });
    return controller.retrieveContext({
      scopeKey,
      conversationId,
      query,
      modelId,
      requestId,
      logger: requestLogger || serviceLogger,
    });
  }

  async function processMessage({
    conversationId,
    user,
    role,
    turnIndex,
    messageText,
    modelId,
    requestId,
    logger: requestLogger,
  }) {
    const scopeKey = controller.resolveScopeKey({ conversationId, user });
    return controller.processMessage({
      scopeKey,
      conversationId,
      role,
      turnIndex,
      messageText,
      modelId,
      requestId,
      logger: requestLogger || serviceLogger,
    });
  }

  async function recallRelevantMemories(query, { conversationId = "global", user = null, modelId = null, requestId, logger: requestLogger } = {}) {
    const context = await retrieveContext({
      conversationId,
      user,
      query,
      modelId,
      requestId,
      logger: requestLogger,
    });
    return context.semanticMemories || [];
  }

  function formatMemoryContext(memoriesOrContext) {
    if (typeof memoriesOrContext === "string" && memoriesOrContext.trim()) {
      return memoriesOrContext;
    }
    if (!Array.isArray(memoriesOrContext) || memoriesOrContext.length === 0) {
      return "Memory context:\nNo relevant long-term memories were recalled for this request.";
    }

    const lines = memoriesOrContext.map((memory, index) => {
      const text = memory?.text || memory?.entry?.text || "";
      return `Recalled memory #${index + 1}: ${text}`;
    });

    return ["Memory context:", ...lines].join("\n");
  }

  async function extractAndStoreMemories({
    conversationId,
    assistantMessage,
    model,
    requestId,
    logger: requestLogger,
  }) {
    const turnIndex = getAssistantTurnIndex(conversationId, conversationStore);
    const result = await processMessage({
      conversationId,
      role: "assistant",
      turnIndex,
      messageText: assistantMessage,
      modelId: model,
      requestId,
      logger: requestLogger,
    });
    return result?.factsStored || 0;
  }

  async function getMemoriesForTool({
    query,
    topK,
    conversationId = "tool-memory",
    user = null,
    requestId,
    logger: requestLogger,
  }) {
    const context = await retrieveContext({
      conversationId,
      user,
      query,
      modelId: config.openai.defaultModel || "gpt-4o-mini",
      requestId,
      logger: requestLogger,
    });
    const memories = [
      ...(context.identityMemories || []),
      ...(context.graphMemories || []),
      ...(context.semanticMemories || []),
    ];

    const limit = Number.isInteger(topK) && topK > 0 ? topK : config.memory.topK;
    return memories.slice(0, limit).map((memory) => ({
      text: memory.text || "",
      confidence_tag: memory.confidenceTag || null,
      memory_type: memory.memoryType || null,
      decay_status: memory.decayStatus || null,
      updated_at: memory.updatedAt || null,
    }));
  }

  async function addMemoryFromTool({
    text,
    importance,
    category,
    eventTime,
    conversationId = "tool-memory",
    user = null,
    toolName = "add_memory",
    requestId,
    logger: requestLogger,
  }) {
    const whitelist = new Set(config.tools.memoryWriteWhitelist || ["add_memory"]);
    if (!whitelist.has(toolName)) {
      throw new AppError({
        statusCode: 403,
        code: "memory_write_not_allowed",
        type: "invalid_request_error",
        message: `Tool "${toolName}" is not allowed to write memory.`,
      });
    }

    const turnIndex = getAssistantTurnIndex(conversationId, conversationStore);
    await processMessage({
      conversationId,
      user,
      role: "user",
      turnIndex,
      messageText: text,
      modelId: config.openai.defaultModel || "gpt-4o-mini",
      requestId,
      logger: requestLogger,
    });

    serviceLogger.info(
      {
        textLength: textLength(text),
        importance,
        category,
        hasEventTime: Boolean(eventTime),
        toolName,
      },
      "Stored memory from tool call"
    );

    return {
      text,
      importance: normalizeImportanceToUnit(importance),
      category: category ?? null,
      event_time: eventTime ?? null,
    };
  }

  async function getSubsystemHealth({ logger: requestLogger, requestId } = {}) {
    return controller.getSubsystemHealth({
      logger: requestLogger || serviceLogger,
      requestId,
    });
  }

  return {
    assertReady,
    close,
    retrieveContext,
    processMessage,
    recallRelevantMemories,
    formatMemoryContext,
    extractAndStoreMemories,
    getMemoriesForTool,
    addMemoryFromTool,
    getSubsystemHealth,
  };
}

function getAssistantTurnIndex(conversationId, conversationStore) {
  if (!conversationStore || !conversationId) {
    return 0;
  }
  try {
    return conversationStore.getUaMessageCount(conversationId);
  } catch {
    return 0;
  }
}

function normalizeImportanceToUnit(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (numeric >= 0 && numeric <= 1) {
    return Number(numeric.toFixed(4));
  }
  if (numeric > 1 && numeric <= 10) {
    return Number((numeric / 10).toFixed(4));
  }
  return null;
}

export { createMemoryService };
