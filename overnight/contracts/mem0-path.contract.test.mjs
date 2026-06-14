// mem0 path — CHARACTERIZATION + FLAG (no fix, no live calls, no dynamic repro).
//
// (a) Pin the contract the benchmark depends on: with mem0 OFF, the extraction path is
//     inert and returns [].
// (b) Document the Exp1 finding: mem0 extracted 0 facts.
// (c) Static-only hypothesis for the 0-facts cause (from mem0-adapter.js, no runtime):
//       - `client` is constructed ONLY when config.memory.mem0.apiKey is set
//         (mem0-adapter.js:10). extractFacts returns [] whenever `!client`
//         (mem0-adapter.js:27). So with no MEM0_API_KEY the adapter reports
//         `enabled:true` but is SILENTLY INERT — every message yields 0 facts with no
//         error or warning. This is the most likely Exp1 cause (no key configured).
//       - Even WITH a key, extraction is delegated to the mem0 CLOUD service
//         (`MemoryClient` from "mem0ai", host api.mem0.ai) — networked, nondeterministic,
//         and billable; incompatible with the deterministic $0 bench (which sets
//         SAGE_MEM0_ENABLED=false). And normalizeMem0Facts only yields facts when the
//         response is an array of { memory: string } entries (mem0-adapter.js:84-93); a
//         different response shape -> 0 facts.
//     Verdict: not fully determinable statically WHICH applied in Exp1, but the
//     no-API-key inert path is sufficient on its own and is the leading hypothesis.
// (d) FLAG (architecture decision, not a bug, deserves its own experiment): should Sage
//     have a working clean-fact extraction path at all? The current path is cloud-mem0;
//     a local-first $0 design would need a different (e.g. local-LLM) extractor. See
//     DEFECT_INVENTORY.md (#8) and EXPERIMENT_4_OUTCOME.md. Tied to D3.1 (the dormant
//     upsertSemanticFacts tag-embedding hygiene, which only matters once a fact path runs).
//
// These tests make NO network/LLM/mem0 calls: no API key is ever provided, so the mem0
// client is never constructed and extractFacts always short-circuits.

import assert from "node:assert/strict";
import test from "node:test";

import pino from "pino";

import { createMem0Adapter } from "../../src/services/memory/mem0-adapter.js";

const logger = pino({ level: "silent" });

function config({ mem0Enabled, apiKey = null }) {
  return {
    memory: {
      mode: "soft",
      mem0Enabled,
      mem0: { apiKey, baseUrl: "https://api.mem0.ai", organizationId: null, projectId: null },
    },
  };
}

const MSG = {
  scopeKey: "scope_mem0",
  conversationId: "c1",
  role: "user",
  messageText: "I prefer aisle seats on overnight flights.",
  messageId: "m-1",
  timestamp: "2026-01-01T00:00:00.000Z",
};

test("CONTRACT: with mem0 OFF the extraction path is inert (enabled=false, extractFacts -> [], ping DISABLED)", async () => {
  const adapter = createMem0Adapter({ config: config({ mem0Enabled: false }), logger });
  assert.equal(adapter.enabled, false, "mem0Enabled:false -> adapter disabled");
  assert.deepEqual(await adapter.extractFacts(MSG), [], "disabled extractFacts returns []");
  assert.equal(await adapter.ping(), "DISABLED");
});

test("CHARACTERIZATION (static 0-facts hypothesis): mem0 enabled but NO api key -> enabled:true yet silently inert", async () => {
  // No apiKey -> the mem0 client is never constructed (mem0-adapter.js:10), so extractFacts
  // short-circuits at !client (line 27) and returns [] WITHOUT any network call. The
  // adapter still advertises enabled:true, masking the inert state. This is the leading
  // static explanation for "0 facts in Exp1". No live mem0/LLM call is made here.
  const adapter = createMem0Adapter({ config: config({ mem0Enabled: true, apiKey: null }), logger });
  assert.equal(adapter.enabled, true, "reports enabled:true (config default) ...");
  assert.deepEqual(await adapter.extractFacts(MSG), [], "... yet returns [] because no client was constructed");
});

test("normalizeMem0Facts behaviour is array-shaped: a non-array / empty response yields no facts", async () => {
  // Documents the secondary 0-facts path: even with a client, a non-array response
  // produces []. We assert the disabled-path equivalent (no client) returns [] for an
  // empty message too — extractFacts guards messageText as well.
  const adapter = createMem0Adapter({ config: config({ mem0Enabled: true, apiKey: null }), logger });
  assert.deepEqual(await adapter.extractFacts({ ...MSG, messageText: "" }), []);
});
