import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { createChatService } from "../src/services/chat-service.js";

const logger = pino({ level: "silent" });

test("chat service builds upstream messages in the correct order", async () => {
  let capturedRequest;

  const service = createChatService({
    openaiClient: {
      chat: {
        completions: {
          create: async (payload) => {
            capturedRequest = payload;
            return {
              id: "chatcmpl-test",
              object: "chat.completion",
              created: 1,
              model: payload.model,
              choices: [{ index: 0, message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
            };
          },
        },
      },
    },
    memoryService: {
      recallRelevantMemories: async () => [{ entry: { text: "Known preference" } }],
      formatMemoryContext: () => "Memory context block",
      extractAndStoreMemories: async () => 1,
    },
    promptService: {
      getActiveSystemPrompt: () => "Base system prompt",
    },
    modelService: {
      assertModelAvailable: async () => {},
    },
    logger,
  });

  await service.createChatCompletion({
    requestBody: {
      model: "gpt-5.2",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
      upstreamOptions: { temperature: 0.2 },
      lastUserMessage: "Hello",
    },
    signal: AbortSignal.timeout(1000),
    logger,
  });

  assert.equal(capturedRequest.model, "gpt-5.2");
  assert.equal(capturedRequest.temperature, 0.2);
  assert.deepEqual(capturedRequest.messages.slice(0, 3), [
    { role: "system", content: "Base system prompt" },
    { role: "system", content: capturedRequest.messages[1].content },
    { role: "system", content: "Memory context block" },
  ]);
  assert.deepEqual(capturedRequest.messages[3], { role: "user", content: "Hello" });
});

test("chat service streams chunks and schedules memory extraction after completion", async () => {
  let extractionCalls = 0;

  const service = createChatService({
    openaiClient: {
      chat: {
        completions: {
          create: async () => ({
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: "Hel" } }] };
              yield { choices: [{ delta: { content: "lo" } }] };
            },
          }),
        },
      },
    },
    memoryService: {
      recallRelevantMemories: async () => [],
      formatMemoryContext: () => "Memory context block",
      extractAndStoreMemories: async () => {
        extractionCalls += 1;
      },
    },
    promptService: {
      getActiveSystemPrompt: () => "Base system prompt",
    },
    modelService: {
      assertModelAvailable: async () => {},
    },
    logger,
  });

  const chunks = [];
  for await (const chunk of service.streamChatCompletion({
    requestBody: {
      model: "gpt-5.2",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      upstreamOptions: {},
      lastUserMessage: "Hello",
    },
    signal: AbortSignal.timeout(1000),
    logger,
  })) {
    chunks.push(chunk);
  }

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(chunks.length, 2);
  assert.equal(extractionCalls, 1);
});
