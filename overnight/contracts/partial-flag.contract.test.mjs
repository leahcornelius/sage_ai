// D3.2 — `partial` should reflect an ENABLED memory source FAILING, not a
// deliberately-disabled adapter being absent.
//
// Defect: memory-controller.js computed
//   partial = !graphResult.ok || !semanticResult.ok || !episodicResult.ok || pastDeadline
// so with Zep intentionally disabled (the bench/default config) EVERY result was
// flagged partial — `partial` became meaningless. runAdapter distinguishes the two
// cases: a disabled adapter returns { ok:false, skipped:true, reason:"disabled" }; a
// real failure returns { ok:false, error } (reason !== "disabled").
//
// Fix: a not-ok result only makes the context partial when reason !== "disabled".
// (A tripped circuit / timeout / error on an ENABLED source still counts as partial.)
//
// Pure controller unit test (stubbed adapters) — no backends needed.

import assert from "node:assert/strict";
import test from "node:test";

import pino from "pino";

import { createMemoryController } from "../../src/services/memory/memory-controller.js";

const logger = pino({ level: "silent" });

function baseConfig() {
  return {
    memory: {
      mode: "soft",
      mem0Enabled: false,
      zepEnabled: true,
      redisEnabled: true,
      retrievalBudgetMs: 5000,
      contextMaxTokens: 1000,
      graphMaxResults: 20,
      semanticTopK: 5,
      episodicTopK: 3,
      writeConcurrencyLimit: 8,
      timeouts: { mem0Ms: 250, zepMs: 120, mnemosyneMs: 120, redisMs: 30 },
      circuitBreaker: { failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000 },
    },
  };
}

// A working mnemosyne + redis + warm scope, so retrieveContext runs the full path and
// computes `partial`. Only the Zep adapter varies between the two halves.
function makeController(zepAdapter) {
  return createMemoryController({
    config: baseConfig(),
    logger,
    mem0Adapter: { enabled: false, ping: async () => "DISABLED" },
    zepAdapter,
    mnemosyneAdapter: {
      enabled: true,
      getIdentityContext: async () => [],
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
}

const REQ = {
  scopeKey: "u-1",
  conversationId: "c-1",
  query: "hello",
  modelId: "gpt-5.2",
  requestId: "req-1",
  logger,
};

test("partial (a): a deliberately-disabled adapter (Zep off) does NOT make the result partial", async () => {
  const controller = makeController({ enabled: false, ping: async () => "DISABLED" });
  const res = await controller.retrieveContext(REQ);
  assert.equal(res.partial, false, "disabled Zep must not flag the context partial");
});

test("partial (b): an ENABLED adapter that fails DOES make the result partial", async () => {
  const controller = makeController({
    enabled: true,
    search: async () => {
      throw new Error("zep boom");
    },
    upsertFacts: async () => 0,
    ping: async () => "OK",
  });
  const res = await controller.retrieveContext(REQ);
  assert.equal(res.partial, true, "an enabled Zep that errors must flag the context partial");
});
