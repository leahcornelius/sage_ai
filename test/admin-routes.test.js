import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { buildApp } from "../src/app.js";

const logger = pino({ level: "silent" });
const authHeader = { authorization: "Bearer bench-key" };

function createConfig({ adminEnabled = true, host = "127.0.0.1" } = {}) {
  return {
    auth: { apiKey: "bench-key" },
    admin: { enabled: adminEnabled },
    server: { corsOrigin: null, host },
    openai: { defaultModel: "gpt-4o-mini" },
    memory: {
      semanticTopK: 5,
      episodicTopK: 3,
      graphMaxResults: 20,
      contextMaxTokens: 1200,
    },
  };
}

function createMemoryServiceStub(overrides = {}) {
  const calls = { processMessage: [], retrieveContext: [], flushQueryCache: 0 };
  return {
    calls,
    getSubsystemHealth: async () => ({
      mem0: { status: "disabled" },
      zep: { status: "disabled" },
      redis: { status: "disabled" },
      mnemosyne: { status: "ok" },
    }),
    processMessage: async (args) => {
      calls.processMessage.push(args);
      return { skipped: false, messageId: "m-1", factsStored: 0 };
    },
    retrieveContext: async (args) => {
      calls.retrieveContext.push(args);
      return {
        contextBlock: "Memory context:\nSemantic memories:\n- marker K7QF2MAB",
        semanticMemories: [{ text: "marker K7QF2MAB" }],
        episodicSummaries: [],
        graphMemories: [],
        identityMemories: [],
        partial: false,
        cacheHit: false,
        coldStart: false,
        budgetExceeded: false,
      };
    },
    flushQueryCache: async () => {
      calls.flushQueryCache += 1;
    },
    ...overrides,
  };
}

async function buildAdminApp(configOpts) {
  const memoryService = createMemoryServiceStub();
  const app = await buildApp({
    config: createConfig(configOpts),
    logger,
    services: { memoryService, modelService: {}, chatService: {}, promptService: {} },
  });
  return { app, memoryService };
}

test("buildApp refuses to boot when admin is enabled on a non-loopback host", async () => {
  const memoryService = createMemoryServiceStub();
  await assert.rejects(
    () =>
      buildApp({
        config: createConfig({ adminEnabled: true, host: "0.0.0.0" }),
        logger,
        services: { memoryService, modelService: {}, chatService: {}, promptService: {} },
      }),
    /requires SAGE_HOST to be a loopback address/
  );
});

test("buildApp boots with admin disabled even on a non-loopback host", async () => {
  const memoryService = createMemoryServiceStub();
  const app = await buildApp({
    config: createConfig({ adminEnabled: false, host: "0.0.0.0" }),
    logger,
    services: { memoryService, modelService: {}, chatService: {}, promptService: {} },
  });
  assert.ok(app, "app builds when admin routes are not registered");
});

test("admin routes are NOT registered when admin.enabled is false", async () => {
  const { app } = await buildAdminApp({ adminEnabled: false });
  const response = await app.inject({
    method: "POST",
    url: "/admin/retrieve",
    headers: authHeader,
    payload: { query: "q", scope: "benchuser_x" },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test("admin routes require a bearer token", async () => {
  const { app } = await buildAdminApp();
  const response = await app.inject({
    method: "POST",
    url: "/admin/retrieve",
    payload: { query: "q", scope: "benchuser_x" },
  });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test("POST /admin/retrieve returns buckets + post-trim block with token count and cacheHit", async () => {
  const { app, memoryService } = await buildAdminApp();
  const response = await app.inject({
    method: "POST",
    url: "/admin/retrieve",
    headers: authHeader,
    payload: { query: "what is the marker?", scope: "benchuser_x", model: "gpt-4o-mini" },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  for (const field of [
    "semanticMemories",
    "episodicSummaries",
    "graphMemories",
    "identityMemories",
    "contextBlock",
    "contextTokenCount",
    "partial",
    "cacheHit",
  ]) {
    assert.ok(field in body, `missing field ${field}`);
  }
  assert.equal(body.cacheHit, false);
  assert.ok(body.contextTokenCount > 0);
  // scopeKey is the provided scope (user==scope)
  assert.equal(memoryService.calls.retrieveContext[0].user, "benchuser_x");
  await app.close();
});

test("POST /admin/memory-config rejects unknown/forbidden keys", async () => {
  const { app } = await buildAdminApp();
  const response = await app.inject({
    method: "POST",
    url: "/admin/memory-config",
    headers: authHeader,
    payload: { semanticTopK: 10, retrievalBudgetMs: 50 },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error.message, /retrievalBudgetMs/);
  await app.close();
});

test("POST /admin/memory-config mutates live config, flushes cache, returns effective", async () => {
  const memoryService = createMemoryServiceStub();
  const config = createConfig();
  const app = await buildApp({
    config,
    logger,
    services: { memoryService, modelService: {}, chatService: {}, promptService: {} },
  });
  const response = await app.inject({
    method: "POST",
    url: "/admin/memory-config",
    headers: authHeader,
    payload: { semanticTopK: 17, contextMaxTokens: 800 },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.effective.semanticTopK, 17);
  assert.equal(body.effective.contextMaxTokens, 800);
  // live, in-place mutation of the shared config object
  assert.equal(config.memory.semanticTopK, 17);
  assert.equal(memoryService.calls.flushQueryCache, 1);
  await app.close();
});

test("POST /admin/memory-config accepts 0 (gate-3 regressive fixture)", async () => {
  const { app } = await buildAdminApp();
  const response = await app.inject({
    method: "POST",
    url: "/admin/memory-config",
    headers: authHeader,
    payload: { semanticTopK: 0, episodicTopK: 0, contextMaxTokens: 200 },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().effective.semanticTopK, 0);
  await app.close();
});

test("POST /admin/ingest persists via processMessage with role user (no model call path)", async () => {
  const { app, memoryService } = await buildAdminApp();
  const response = await app.inject({
    method: "POST",
    url: "/admin/ingest",
    headers: authHeader,
    payload: { scope: "benchuser_x", text: "favourite marker is K7QF2MAB", turnIndex: 0 },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(memoryService.calls.processMessage.length, 1);
  const call = memoryService.calls.processMessage[0];
  assert.equal(call.role, "user");
  assert.equal(call.user, "benchuser_x");
  assert.equal(call.messageText, "favourite marker is K7QF2MAB");
  await app.close();
});
