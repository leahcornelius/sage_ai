import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { createMemoryService } from "../src/services/memory-service.js";

const logger = pino({ level: "silent" });

test("memory recall degrades to an empty list on backend failure", async () => {
  const service = createMemoryService({
    mnemosyneClient: {
      recall: async () => {
        throw new Error("qdrant unavailable");
      },
      store: async () => {},
    },
    openaiClient: {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: '{"memories":[]}' } }] }),
        },
      },
    },
    config: {
      memory: {
        topK: 5,
        extractionModel: null,
      },
    },
    logger,
  });

  const memories = await service.recallRelevantMemories("hello");
  assert.deepEqual(memories, []);
});

test("memory extraction ignores malformed JSON without throwing", async () => {
  let stored = 0;
  const service = createMemoryService({
    mnemosyneClient: {
      recall: async () => [],
      store: async () => {
        stored += 1;
      },
    },
    openaiClient: {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: "not-json" } }] }),
        },
      },
    },
    config: {
      memory: {
        topK: 5,
        extractionModel: null,
      },
    },
    logger,
  });

  const storedCount = await service.extractAndStoreMemories({
    userMessage: "Hello",
    assistantMessage: "Hi there",
    model: "gpt-5.2",
    logger,
  });

  assert.equal(storedCount, 0);
  assert.equal(stored, 0);
});
