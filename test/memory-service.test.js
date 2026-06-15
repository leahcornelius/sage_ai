import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { createMemoryService } from "../src/services/memory-service.js";

const logger = pino({ level: "silent" });

function createConfig(overrides = {}) {
  return {
    openai: {
      defaultModel: "gpt-5.2",
    },
    tools: {
      memoryWriteWhitelist: ["add_memory"],
      ...overrides.tools,
    },
    memory: {
      mode: "soft",
      mem0Enabled: false,
      zepEnabled: false,
      redisEnabled: false,
      topK: 5,
      semanticTopK: 5,
      episodicTopK: 3,
      graphMaxResults: 20,
      contextMaxTokens: 1200,
      retrievalBudgetMs: 180,
      retrievalTimeoutMs: 200,
      identityCacheTtlSec: 300,
      queryCacheTtlSec: 120,
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
      redisUrl: "redis://localhost:6379",
      mem0: {
        apiKey: null,
        baseUrl: "https://api.mem0.ai",
      },
      zep: {
        apiKey: null,
        baseUrl: null,
      },
      mnemosyne: {
        collectionName: "sage_mem_v2",
      },
      ...overrides.memory,
    },
  };
}

function createMnemosyneStub() {
  const entries = [];
  return {
    entries,
    embeddings: {
      // Deterministic stub vector; dimension is irrelevant to these unit tests.
      async embed() {
        return new Array(8).fill(0);
      },
    },
    db: {
      // storeEpisodic writes raw points via db.store (Experiment-4 merge fix),
      // bypassing fullStorePipeline's dedup/merge. Mirror the record shape the
      // assertions inspect (text + the cell fields incl. metadata).
      async store(text, _vector, cell = {}) {
        entries.push({ text, ...cell });
        return { id: `m-${entries.length}` };
      },
    },
    async store(payload) {
      entries.push(payload);
      return `m-${entries.length}`;
    },
    async recall({ query, topK, limit }) {
      const count = limit ?? topK ?? entries.length;
      const matched = entries
        .filter((entry) => String(entry.text || "").includes(String(query)))
        .slice(0, count)
        .map((entry, index) => ({
          entry: {
            id: `m-${index + 1}`,
            text: entry.text,
            memoryType: entry.category || "semantic",
            confidenceTag: null,
            decayStatus: null,
            updatedAt: null,
          },
        }));
      return matched;
    },
  };
}

test("memory service deduplicates repeated message ingestion by messageId", async () => {
  const mnemosyneClient = createMnemosyneStub();
  const service = createMemoryService({
    mnemosyneClient,
    conversationStore: null,
    config: createConfig(),
    logger,
  });

  await service.processMessage({
    conversationId: "conv-1",
    role: "user",
    turnIndex: 0,
    messageText: "I like tea",
    modelId: "gpt-5.2",
    requestId: "req-1",
    logger,
  });
  await service.processMessage({
    conversationId: "conv-1",
    role: "user",
    turnIndex: 0,
    messageText: "I like tea",
    modelId: "gpt-5.2",
    requestId: "req-2",
    logger,
  });

  assert.equal(mnemosyneClient.entries.length, 1);
  // Embedding hygiene (Exp2): the CLEAN message content is embedded; structural
  // fields like message_id live in metadata, NOT in the embedded text. (Pre-Exp2
  // this asserted /message_id:/ in the text — stale since the hygiene fix.)
  assert.equal(mnemosyneClient.entries[0].text, "I like tea");
  assert.doesNotMatch(mnemosyneClient.entries[0].text, /message_id:/);
});

test("memory service rejects memory writes from non-whitelisted tools", async () => {
  const service = createMemoryService({
    mnemosyneClient: createMnemosyneStub(),
    conversationStore: null,
    config: createConfig({
      tools: {
        memoryWriteWhitelist: ["add_memory"],
      },
    }),
    logger,
  });

  await assert.rejects(
    () =>
      service.addMemoryFromTool({
        text: "secret",
        toolName: "random_tool",
      }),
    /not allowed/
  );
});

test("memory service reports memory subsystem health shape", async () => {
  const service = createMemoryService({
    mnemosyneClient: createMnemosyneStub(),
    conversationStore: null,
    config: createConfig(),
    logger,
  });

  const health = await service.getSubsystemHealth({ logger, requestId: "req-1" });
  assert.ok(health.mem0);
  assert.ok(health.zep);
  assert.ok(health.redis);
  assert.ok(health.mnemosyne);
});
