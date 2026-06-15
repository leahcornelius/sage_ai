// Episodic ring buffer contract + episodicTopK=0 floor characterization.
//
// Uses the real adapter with a STUB client (db.store / embeddings.embed no-ops), so the
// in-memory ring buffer is exercised without any backend.
//
// Contract: per-scope FIFO, max 20 turns, returned most-recent-first, capped at maxItems.
// Contract (resolved Exp5 hygiene): getEpisodicSummaries honors zero — episodicTopK=0
// disables the episodic channel and returns no turns (the old Math.max(1, …) floor that
// leaked one recent turn was removed; Codex authorized the contract change).

import assert from "node:assert/strict";
import test from "node:test";

import pino from "pino";

import { createMnemosyneAdapter } from "../../src/services/memory/mnemosyne-adapter.js";

const logger = pino({ level: "silent" });

function stubClient(storeCalls) {
  return {
    embeddings: { async embed() { return [0]; } },
    db: {
      async store(text) {
        if (storeCalls) storeCalls.push(text);
        return { id: "stub" };
      },
    },
    async store() { return "stub"; },
    async recall() { return []; },
  };
}

function adapter(storeCalls) {
  return createMnemosyneAdapter({
    mnemosyneClient: stubClient(storeCalls),
    config: { memory: { mode: "soft" } },
    logger,
  });
}

async function ingest(a, scopeKey, n) {
  for (let i = 0; i < n; i++) {
    await a.storeEpisodic({
      scopeKey,
      conversationId: "c1",
      role: "user",
      messageText: `${scopeKey} turn ${i}`,
      messageId: `${scopeKey}-m${i}`,
      turnIndex: i,
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    });
  }
}

test("ring buffer caps at 20 per scope and returns the most recent turns, newest-first", async () => {
  const a = adapter();
  await ingest(a, "scopeA", 25);
  const summaries = await a.getEpisodicSummaries({ scopeKey: "scopeA", maxItems: 100 });
  assert.equal(summaries.length, 20, "buffer holds at most 20 turns");
  // Newest-first: turn 24 first, turn 5 last (turns 0..4 evicted by the FIFO cap).
  assert.ok(summaries[0].text.includes("turn 24"), summaries[0].text);
  assert.ok(summaries[19].text.includes("turn 5"), summaries[19].text);
  assert.ok(!summaries.some((s) => /turn [0-4]\b/.test(s.text)), "oldest 5 turns evicted");
});

test("maxItems caps the returned count (newest-first slice)", async () => {
  const a = adapter();
  await ingest(a, "scopeA", 10);
  const three = await a.getEpisodicSummaries({ scopeKey: "scopeA", maxItems: 3 });
  assert.equal(three.length, 3);
  assert.ok(three[0].text.includes("turn 9") && three[2].text.includes("turn 7"));
});

test("per-scope isolation: one scope's turns never leak into another", async () => {
  const a = adapter();
  await ingest(a, "scopeA", 3);
  await ingest(a, "scopeB", 2);
  const b = await a.getEpisodicSummaries({ scopeKey: "scopeB", maxItems: 100 });
  assert.equal(b.length, 2);
  // Scope-distinct payloads, so leakage is detectable: scopeB results must contain
  // only scopeB content and never scopeA's.
  assert.ok(b.every((s) => s.text.includes("scopeB")), "scopeB results only");
  assert.ok(!b.some((s) => s.text.includes("scopeA")), "no scopeA leakage");
});

test("SECRET GUARD: raw episodic/semantic store drops secret-classified text", async () => {
  // The raw db.store path bypasses mnemosy-ai's fullStorePipeline, which refuses
  // secret-classified text. The adapter re-applies that classifier (fail closed),
  // so a turn/fact containing a password/token/key is never persisted.
  const storeCalls = [];
  const a = adapter(storeCalls);

  const secretId = await a.storeEpisodic({
    scopeKey: "scopeA", conversationId: "c1", role: "user",
    messageText: "my password is hunter2", messageId: "s1", turnIndex: 0,
    timestamp: new Date(1_700_000_000_000).toISOString(),
  });
  assert.equal(secretId, null, "secret turn is dropped (returns null)");

  const cleanId = await a.storeEpisodic({
    scopeKey: "scopeA", conversationId: "c1", role: "user",
    messageText: "alice prefers window seats", messageId: "c1m", turnIndex: 1,
    timestamp: new Date(1_700_000_001_000).toISOString(),
  });
  assert.notEqual(cleanId, null, "non-secret turn is stored");

  const facts = await a.upsertSemanticFacts({
    scopeKey: "scopeA",
    facts: [
      { text: "the api key is ABCD-1234", factKey: "fk_secret", category: "fact" },
      { text: "bob lives in Berlin", factKey: "fk_clean", category: "fact" },
    ],
  });
  assert.equal(facts.length, 1, "the secret fact is skipped, the clean fact is stored");
  assert.equal(facts[0].factKey, "fk_clean");

  // db.store only saw the two non-secret payloads.
  assert.ok(!storeCalls.some((t) => /password|api key/i.test(t)), "no secret text reached db.store");
});

test("CONTRACT: episodicTopK=0 returns no turns (honor zero, no floor)", async () => {
  // getEpisodicSummaries honors zero: a caller asking for ZERO episodic items
  // receives none. (Was a Math.max(1, …) floor that leaked one recent turn —
  // removed as an Exp5 hygiene fix; Codex authorized the contract change.)
  const a = adapter();
  await ingest(a, "scopeA", 5);
  const zero = await a.getEpisodicSummaries({ scopeKey: "scopeA", maxItems: 0 });
  assert.equal(zero.length, 0, "episodicTopK=0 returns no episodic turns");
});
