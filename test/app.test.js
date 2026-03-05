import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { buildApp } from "../src/app.js";
import { AppError } from "../src/errors/app-error.js";

const logger = pino({ level: "silent" });
const authHeader = {
  authorization: "Bearer test-sage-key",
};

function createTestConfig() {
  return {
    auth: { apiKey: "test-sage-key" },
    server: { corsOrigin: null },
  };
}

async function createTestApp(services) {
  const app = await buildApp({
    config: createTestConfig(),
    logger,
    services: {
      modelService: {
        listModels: async () => [{ id: "gpt-5.2", created: 1, owned_by: "openai" }],
      },
      chatService: {
        createChatCompletion: async () => ({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 1,
          model: "gpt-5.2",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
        }),
        streamChatCompletion: async function* () {
          yield { id: "chunk-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hel" } }] };
          yield { id: "chunk-2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "lo" } }] };
        },
      },
      memoryService: {
        getSubsystemHealth: async () => ({
          mem0: { status: "disabled" },
          zep: { status: "disabled" },
          redis: { status: "disabled" },
          mnemosyne: { status: "disabled" },
        }),
      },
      promptService: {},
      ...services,
    },
  });

  return app;
}

test("GET /health is public", async () => {
  const app = await createTestApp();
  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, "ok");
  assert.equal(response.json().memory.mnemosyne.status, "disabled");
  await app.close();
});

test("GET /v1/models requires a bearer token", async () => {
  const app = await createTestApp();
  const response = await app.inject({ method: "GET", url: "/v1/models" });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "invalid_api_key");
  await app.close();
});

test("GET /v1/models returns OpenAI-style model payloads", async () => {
  const app = await createTestApp();
  const response = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: authHeader,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().object, "list");
  assert.equal(response.json().data[0].id, "gpt-5.2");
  await app.close();
});

test("POST /v1/chat/completions validates required fields", async () => {
  const app = await createTestApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: authHeader,
    payload: { messages: [{ role: "user", content: "Hello" }] },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.param, "model");
  await app.close();
});

test("POST /v1/chat/completions accepts tools for non-stream requests", async () => {
  const app = await createTestApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: authHeader,
    payload: {
      model: "gpt-5.2",
      conversation_id: "conv-1",
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ type: "function", function: { name: "get_memories", parameters: { type: "object" } } }],
    },
  });

  assert.equal(response.statusCode, 200);
  await app.close();
});

test("POST /v1/chat/completions accepts tools when stream=true", async () => {
  const app = await createTestApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: authHeader,
    payload: {
      model: "gpt-5.2",
      conversation_id: "conv-1",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      tools: [{ type: "function", function: { name: "get_memories" } }],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /data: .*chunk-1/);
  assert.match(response.body, /data: \[DONE\]/);
  await app.close();
});

test("POST /v1/chat/completions returns non-stream completions", async () => {
  const app = await createTestApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: authHeader,
    payload: {
      model: "gpt-5.2",
      conversation_id: "conv-1",
      messages: [{ role: "user", content: "Hello" }],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().object, "chat.completion");
  assert.equal(response.json().choices[0].message.content, "Hello");
  await app.close();
});

test("POST /v1/chat/completions streams SSE chunks", async () => {
  const app = await createTestApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: authHeader,
    payload: {
      model: "gpt-5.2",
      conversation_id: "conv-1",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /data: .*chunk-1/);
  assert.match(response.body, /data: \[DONE\]/);
  await app.close();
});

test("POST /v1/chat/completions does not trigger route-level memory ingestion after streaming completes", async () => {
  let processCalls = 0;
  const app = await createTestApp({
    memoryService: {
      processMessage: async () => {
        processCalls += 1;
      },
      getSubsystemHealth: async () => ({
        mem0: { status: "disabled" },
        zep: { status: "disabled" },
        redis: { status: "disabled" },
        mnemosyne: { status: "disabled" },
      }),
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: authHeader,
    payload: {
      model: "gpt-5.2",
      conversation_id: "conv-1",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    },
  });

  assert.equal(response.statusCode, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(processCalls, 0);
  await app.close();
});

test("POST /v1/chat/completions maps service errors into OpenAI error payloads", async () => {
  const app = await createTestApp({
    chatService: {
      createChatCompletion: async () => {
        throw new AppError({
          statusCode: 404,
          code: "model_not_found",
          type: "invalid_request_error",
          message: "Missing model",
        });
      },
      streamChatCompletion: async function* () {},
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: authHeader,
    payload: {
      model: "gpt-5.2",
      conversation_id: "conv-1",
      messages: [{ role: "user", content: "Hello" }],
    },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "model_not_found");
  await app.close();
});

test("POST /v1/chat/completions requires conversation id", async () => {
  const app = await createTestApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: authHeader,
    payload: {
      model: "gpt-5.2",
      messages: [{ role: "user", content: "Hello" }],
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.param, "conversation_id");
  await app.close();
});

test("POST /v1/chat/completions accepts conversationId alias", async () => {
  const app = await createTestApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: authHeader,
    payload: {
      model: "gpt-5.2",
      conversationId: "conv-camel",
      messages: [{ role: "user", content: "Hello" }],
    },
  });

  assert.equal(response.statusCode, 200);
  await app.close();
});

test("POST /v1/chat/completions rejects mismatched conversation id aliases", async () => {
  const app = await createTestApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: authHeader,
    payload: {
      model: "gpt-5.2",
      conversation_id: "conv-a",
      conversationId: "conv-b",
      messages: [{ role: "user", content: "Hello" }],
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.param, "conversation_id");
  await app.close();
});
