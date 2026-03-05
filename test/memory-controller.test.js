import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { createMemoryController, createMessageId } from "../src/services/memory/memory-controller.js";

const logger = pino({ level: "silent" });

function createConfig(overrides = {}) {
  return {
    memory: {
      mode: "soft",
      mem0Enabled: true,
      zepEnabled: true,
      redisEnabled: true,
      retrievalBudgetMs: 180,
      contextMaxTokens: 1000,
      graphMaxResults: 20,
      semanticTopK: 5,
      episodicTopK: 3,
      writeConcurrencyLimit: 8,
      timeouts: {
        mem0Ms: 250,
        zepMs: 120,
        mnemosyneMs: 120,
        redisMs: 30,
      },
      circuitBreaker: {
        failureThreshold: 5,
        windowMs: 60_000,
        cooldownMs: 30_000,
      },
      ...overrides,
    },
  };
}

test("memory retrieval never calls mem0 adapter", async () => {
  let mem0Calls = 0;
  const controller = createMemoryController({
    config: createConfig(),
    logger,
    mem0Adapter: {
      enabled: true,
      extractFacts: async () => {
        mem0Calls += 1;
        return [];
      },
      ping: async () => "OK",
    },
    zepAdapter: {
      enabled: true,
      search: async () => [{ text: "graph fact" }],
      upsertFacts: async () => 0,
      ping: async () => "OK",
    },
    mnemosyneAdapter: {
      enabled: true,
      getIdentityContext: async () => [{ text: "identity" }],
      hasScopeMemories: async () => true,
      searchSemantic: async () => [{ text: "semantic fact" }],
      getEpisodicSummaries: async () => [{ text: "episodic" }],
      ping: async () => "OK",
    },
    redisCache: {
      enabled: true,
      getIdentityContext: async () => null,
      setIdentityContext: async () => {},
      getQueryContext: async () => null,
      setQueryContext: async () => {},
      invalidateScope: async () => {},
      ping: async () => "OK",
      close: async () => {},
    },
  });

  await controller.retrieveContext({
    scopeKey: "u-1",
    conversationId: "c-1",
    query: "hello",
    modelId: "gpt-5.2",
    requestId: "req-1",
    logger,
  });

  assert.equal(mem0Calls, 0);
});

test("cold start short-circuits graph and semantic queries", async () => {
  let zepSearchCalls = 0;
  let semanticCalls = 0;
  const controller = createMemoryController({
    config: createConfig(),
    logger,
    mem0Adapter: {
      enabled: false,
      ping: async () => "DISABLED",
    },
    zepAdapter: {
      enabled: true,
      search: async () => {
        zepSearchCalls += 1;
        return [];
      },
      upsertFacts: async () => 0,
      ping: async () => "OK",
    },
    mnemosyneAdapter: {
      enabled: true,
      getIdentityContext: async () => [],
      hasScopeMemories: async () => false,
      searchSemantic: async () => {
        semanticCalls += 1;
        return [];
      },
      getEpisodicSummaries: async () => [],
      ping: async () => "OK",
    },
    redisCache: {
      enabled: true,
      getIdentityContext: async () => null,
      setIdentityContext: async () => {},
      getQueryContext: async () => null,
      setQueryContext: async () => {},
      invalidateScope: async () => {},
      ping: async () => "OK",
      close: async () => {},
    },
  });

  const result = await controller.retrieveContext({
    scopeKey: "u-1",
    conversationId: "c-1",
    query: "hello",
    modelId: "gpt-5.2",
    requestId: "req-1",
    logger,
  });

  assert.equal(result.coldStart, true);
  assert.equal(zepSearchCalls, 0);
  assert.equal(semanticCalls, 0);
});

test("controller passes graph limit from config", async () => {
  const calls = [];
  const controller = createMemoryController({
    config: createConfig({ graphMaxResults: 11 }),
    logger,
    mem0Adapter: { enabled: false, ping: async () => "DISABLED" },
    zepAdapter: {
      enabled: true,
      search: async (args) => {
        calls.push(args);
        return [];
      },
      upsertFacts: async () => 0,
      ping: async () => "OK",
    },
    mnemosyneAdapter: {
      enabled: true,
      getIdentityContext: async () => [{ text: "identity" }],
      hasScopeMemories: async () => true,
      searchSemantic: async () => [],
      getEpisodicSummaries: async () => [],
      ping: async () => "OK",
    },
    redisCache: {
      enabled: true,
      getIdentityContext: async () => [{ text: "identity" }],
      setIdentityContext: async () => {},
      getQueryContext: async () => null,
      setQueryContext: async () => {},
      invalidateScope: async () => {},
      ping: async () => "OK",
      close: async () => {},
    },
  });

  await controller.retrieveContext({
    scopeKey: "u-1",
    conversationId: "c-1",
    query: "hello",
    modelId: "gpt-5.2",
    requestId: "req-1",
    logger,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, 11);
});

test("normalizeQueryForCache trims, lowercases, and caps at 256 chars", () => {
  const controller = createMemoryController({
    config: createConfig(),
    logger,
    mem0Adapter: { enabled: false, ping: async () => "DISABLED" },
    zepAdapter: { enabled: false, ping: async () => "DISABLED" },
    mnemosyneAdapter: { enabled: false, ping: async () => "DISABLED" },
    redisCache: { enabled: false, ping: async () => "DISABLED", close: async () => {} },
  });

  const normalized = controller.normalizeQueryForCache(`  HELLO ${"a".repeat(400)}  `);
  assert.equal(normalized.startsWith("hello"), true);
  assert.equal(normalized.length, 256);
});

test("createMessageId returns stable sha256 hex digest", () => {
  const a = createMessageId({
    conversationId: "conv-1",
    role: "user",
    turnIndex: 1,
    messageText: "I like tea",
  });
  const b = createMessageId({
    conversationId: "conv-1",
    role: "user",
    turnIndex: 1,
    messageText: "I like tea",
  });
  const c = createMessageId({
    conversationId: "conv-1",
    role: "user",
    turnIndex: 1,
    messageText: "I like coffee",
  });

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("global write semaphore enforces concurrency limit", async () => {
  let active = 0;
  let maxActive = 0;
  const controller = createMemoryController({
    config: createConfig({ writeConcurrencyLimit: 1 }),
    logger,
    mem0Adapter: {
      enabled: false,
      extractFacts: async () => [],
      ping: async () => "DISABLED",
    },
    zepAdapter: {
      enabled: false,
      upsertFacts: async () => 0,
      ping: async () => "DISABLED",
    },
    mnemosyneAdapter: {
      enabled: true,
      hasMessageId: async () => false,
      storeEpisodic: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return "m1";
      },
      upsertSemanticFacts: async () => [],
      getIdentityContext: async () => [],
      hasScopeMemories: async () => false,
      searchSemantic: async () => [],
      getEpisodicSummaries: async () => [],
      ping: async () => "OK",
    },
    redisCache: {
      enabled: false,
      invalidateScope: async () => {},
      ping: async () => "DISABLED",
      close: async () => {},
    },
  });

  await Promise.all([
    controller.processMessage({
      scopeKey: "u1",
      conversationId: "c1",
      role: "user",
      turnIndex: 0,
      messageText: "one",
    }),
    controller.processMessage({
      scopeKey: "u2",
      conversationId: "c2",
      role: "user",
      turnIndex: 0,
      messageText: "two",
    }),
  ]);

  assert.equal(maxActive, 1);
});
