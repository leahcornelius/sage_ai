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

test("chat service streams chunks without triggering memory extraction directly", async () => {
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
  assert.equal(extractionCalls, 0);
});

test("chat service executes tool calls in non-stream mode", async () => {
  const upstreamCalls = [];
  const service = createChatService({
    openaiClient: {
      chat: {
        completions: {
          create: async (payload) => {
            upstreamCalls.push(payload);
            if (upstreamCalls.length === 1) {
              return {
                id: "chatcmpl-tool-1",
                object: "chat.completion",
                created: 1,
                model: payload.model,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: "",
                      tool_calls: [
                        {
                          id: "call_1",
                          type: "function",
                          function: {
                            name: "get_memories",
                            arguments: "{\"query\":\"color\"}",
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              };
            }

            return {
              id: "chatcmpl-tool-2",
              object: "chat.completion",
              created: 1,
              model: payload.model,
              choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
            };
          },
        },
      },
    },
    memoryService: {
      recallRelevantMemories: async () => [],
      formatMemoryContext: () => "Memory context block",
      extractAndStoreMemories: async () => 0,
    },
    promptService: {
      getActiveSystemPrompt: () => "Base system prompt",
    },
    modelService: {
      assertModelAvailable: async () => {},
    },
    toolRegistry: {
      getExecutionContext: () => ({
        tools: [{ type: "function", function: { name: "get_memories", parameters: { type: "object" } } }],
        handlers: new Map([["get_memories", { source: "builtin", handler: async () => ({ memories: [] }) }]]),
      }),
    },
    toolExecutor: {
      executeToolCalls: async () => [
        {
          toolCallId: "call_1",
          toolName: "get_memories",
          handled: true,
          content: "{\"ok\":true,\"data\":{\"memories\":[]}}",
        },
      ],
    },
    config: {
      tools: {
        maxRounds: 6,
      },
    },
    logger,
  });

  const completion = await service.createChatCompletion({
    requestBody: {
      model: "gpt-5.2",
      messages: [{ role: "user", content: "What do I like?" }],
      stream: false,
      upstreamOptions: {},
      tools: [],
      toolChoice: "auto",
      lastUserMessage: "What do I like?",
    },
    signal: AbortSignal.timeout(1000),
    logger,
  });

  assert.equal(completion.id, "chatcmpl-tool-2");
  assert.equal(upstreamCalls.length, 2);
  assert.equal(upstreamCalls[1].messages.at(-1).role, "tool");
  assert.equal(upstreamCalls[1].messages.at(-1).tool_call_id, "call_1");
});

test("chat service streams tool-enabled requests using completion fallback", async () => {
  const service = createChatService({
    openaiClient: {
      chat: {
        completions: {
          create: async () => ({
            id: "chatcmpl-tool-stream",
            object: "chat.completion",
            created: 1,
            model: "gpt-5.2",
            choices: [{ index: 0, message: { role: "assistant", content: "Tool result ready." }, finish_reason: "stop" }],
          }),
        },
      },
    },
    memoryService: {
      recallRelevantMemories: async () => [],
      formatMemoryContext: () => "Memory context block",
      extractAndStoreMemories: async () => 0,
    },
    promptService: {
      getActiveSystemPrompt: () => "Base system prompt",
    },
    modelService: {
      assertModelAvailable: async () => {},
    },
    toolRegistry: {
      getExecutionContext: () => ({
        tools: [{ type: "function", function: { name: "get_memories", parameters: { type: "object" } } }],
        handlers: new Map([["get_memories", { source: "builtin", handler: async () => ({ memories: [] }) }]]),
      }),
    },
    toolExecutor: {
      executeToolCalls: async () => [],
    },
    config: {
      tools: {
        maxRounds: 6,
      },
    },
    logger,
  });

  const chunks = [];
  for await (const chunk of service.streamChatCompletion({
    requestBody: {
      model: "gpt-5.2",
      messages: [{ role: "user", content: "use tools" }],
      stream: true,
      upstreamOptions: {},
      tools: [{ type: "function", function: { name: "get_memories", parameters: { type: "object" } } }],
      toolChoice: "auto",
      lastUserMessage: "use tools",
    },
    signal: AbortSignal.timeout(1000),
    logger,
  })) {
    chunks.push(chunk);
  }

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(chunks[0].choices[0].delta.content, "Tool result ready.");
  assert.equal(chunks[1].choices[0].finish_reason, "stop");
});
