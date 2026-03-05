import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { createMemoryService } from "../src/services/memory-service.js";

const logger = pino({ level: "silent" });

function createConversationStoreStub({ uaMessages, state, previousGenerations = [] }) {
  const conversationState = {
    conversationId: state.conversationId || "conv-1",
    lastExtractedUaCount: state.lastExtractedUaCount,
    summaryText: state.summaryText || "",
    summaryThroughUaIndex: state.summaryThroughUaIndex ?? -1,
  };
  let summaryState = {
    summaryText: conversationState.summaryText,
    summaryThroughUaIndex: conversationState.summaryThroughUaIndex,
  };

  return {
    getConversation: () => ({
      conversationId: conversationState.conversationId,
      lastExtractedUaCount: conversationState.lastExtractedUaCount,
      summaryText: summaryState.summaryText,
      summaryThroughUaIndex: summaryState.summaryThroughUaIndex,
    }),
    getUaMessageCount: () => uaMessages.length,
    getUaMessageByIndex: ({ uaIndex }) => uaMessages.find((message) => message.uaIndex === uaIndex) || null,
    getUaMessagesInRange: ({ startIndex, endIndex }) =>
      uaMessages.filter((message) => message.uaIndex >= startIndex && message.uaIndex <= endIndex),
    listActiveMemoryGenerationsBySourceRange: ({ windowStart, windowEnd }) =>
      previousGenerations.filter(
        (entry) => entry.sourceMessageIndex >= windowStart && entry.sourceMessageIndex <= windowEnd
      ),
    updateConversationSummary: ({ summaryText, summaryThroughUaIndex }) => {
      summaryState = {
        summaryText,
        summaryThroughUaIndex,
      };
    },
    updateConversationProgress: ({ lastExtractedUaCount, summaryThroughUaIndex }) => {
      conversationState.lastExtractedUaCount = lastExtractedUaCount;
      conversationState.summaryThroughUaIndex = summaryThroughUaIndex;
      summaryState.summaryThroughUaIndex = summaryThroughUaIndex;
    },
    createExtractionRun: () => 1,
    addMemoryGeneration: () => {},
    deactivateActiveGenerationsByMemoryId: () => {},
  };
}

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
          create: async () => ({ choices: [{ message: { content: '{"new":[],"updated":[]}' } }] }),
        },
      },
    },
    conversationStore: null,
    config: {
      memory: {
        topK: 5,
        extractionModel: null,
        summaryModel: null,
        extractEvery: 4,
        extractionHistoryMultiplier: 2,
        mnemosyne: {
          collectionName: "testing",
        },
      },
    },
    logger,
  });

  const memories = await service.recallRelevantMemories("hello");
  assert.deepEqual(memories, []);
});

test("memory extraction rejects legacy payload shape", async () => {
  let storeCalls = 0;
  const service = createMemoryService({
    mnemosyneClient: {
      recall: async () => [],
      store: async () => {
        storeCalls += 1;
        return "m1";
      },
      db: {
        getPoint: async () => null,
      },
      embeddings: {
        embed: async () => [0.1, 0.2],
      },
      config: {
        sharedCollection: "shared",
        privateCollection: "private",
      },
    },
    openaiClient: {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: '{"memories":[]}' } }] }),
        },
      },
    },
    conversationStore: createConversationStoreStub({
      uaMessages: [
        { uaIndex: 0, role: "user", content: "hello" },
        { uaIndex: 1, role: "assistant", content: "hi" },
        { uaIndex: 2, role: "user", content: "I like tea" },
        { uaIndex: 3, role: "assistant", content: "noted" },
      ],
      state: {
        conversationId: "conv-1",
        lastExtractedUaCount: 0,
        summaryText: "",
        summaryThroughUaIndex: -1,
      },
    }),
    config: {
      memory: {
        topK: 5,
        extractionModel: null,
        summaryModel: null,
        extractEvery: 4,
        extractionHistoryMultiplier: 2,
        mnemosyne: {
          collectionName: "testing",
        },
      },
    },
    logger,
  });

  const storedCount = await service.extractAndStoreMemories({
    conversationId: "conv-1",
    assistantMessage: "noted",
    model: "gpt-5.2",
    logger,
  });

  assert.equal(storedCount, 0);
  assert.equal(storeCalls, 0);
});

test("memory extraction stores new memories and normalizes importance", async () => {
  const storedMemories = [];
  const service = createMemoryService({
    mnemosyneClient: {
      recall: async () => [],
      store: async (payload) => {
        storedMemories.push(payload);
        return "memory-new-1";
      },
      db: {
        getPoint: async () => null,
      },
      embeddings: {
        embed: async () => [0.1, 0.2],
      },
      config: {
        sharedCollection: "shared",
        privateCollection: "private",
      },
    },
    openaiClient: {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content:
                    '{"new":[{"source_message_index":2,"text":"User likes tea","importance":8,"category":"preference","eventTime":null}],"updated":[]}',
                },
              },
            ],
          }),
        },
      },
    },
    conversationStore: createConversationStoreStub({
      uaMessages: [
        { uaIndex: 0, role: "user", content: "hello" },
        { uaIndex: 1, role: "assistant", content: "hi" },
        { uaIndex: 2, role: "user", content: "I like tea" },
        { uaIndex: 3, role: "assistant", content: "noted" },
      ],
      state: {
        conversationId: "conv-1",
        lastExtractedUaCount: 0,
        summaryText: "",
        summaryThroughUaIndex: -1,
      },
    }),
    config: {
      memory: {
        topK: 5,
        extractionModel: null,
        summaryModel: null,
        extractEvery: 4,
        extractionHistoryMultiplier: 2,
        mnemosyne: {
          collectionName: "testing",
        },
      },
    },
    logger,
  });

  const storedCount = await service.extractAndStoreMemories({
    conversationId: "conv-1",
    assistantMessage: "noted",
    model: "gpt-5.2",
    logger,
  });

  assert.equal(storedCount, 1);
  assert.equal(storedMemories.length, 1);
  assert.equal(storedMemories[0].importance, 0.8);
});
