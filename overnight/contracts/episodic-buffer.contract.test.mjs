// Episodic ring buffer contract + episodicTopK=0 floor characterization.
//
// Uses the real adapter with a STUB client (db.store / embeddings.embed no-ops), so the
// in-memory ring buffer is exercised without any backend.
//
// Contract: per-scope FIFO, max 20 turns, returned most-recent-first, capped at maxItems.
// Characterization (intent TBD, flagged): getEpisodicSummaries floors at 1 — episodicTopK=0
// still returns one (the most recent) turn, never zero.

import assert from "node:assert/strict";
import test from "node:test";

import pino from "pino";

import { createMnemosyneAdapter } from "../../src/services/memory/mnemosyne-adapter.js";

const logger = pino({ level: "silent" });

function stubClient() {
  return {
    embeddings: { async embed() { return [0]; } },
    db: { async store() { return { id: "stub" }; } },
    async store() { return "stub"; },
    async recall() { return []; },
  };
}

function adapter() {
  return createMnemosyneAdapter({
    mnemosyneClient: stubClient(),
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
      messageText: `turn ${i}`,
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
  assert.ok(b.every((s) => s.text.includes("turn")));
});

test("CHARACTERIZATION (intent TBD): episodicTopK=0 floors at 1 turn, never 0", async () => {
  // Math.max(1, maxItems) in getEpisodicSummaries means a caller asking for ZERO
  // episodic items still receives ONE (the most recent). FLAGGED for a design call:
  // deliberate continuity vs over-aggressive guard. Pinned here so it can't change
  // silently while the question is open.
  const a = adapter();
  await ingest(a, "scopeA", 5);
  const zero = await a.getEpisodicSummaries({ scopeKey: "scopeA", maxItems: 0 });
  assert.equal(zero.length, 1, "episodicTopK=0 currently returns 1 floored turn");
  assert.ok(zero[0].text.includes("turn 4"), "the single floored turn is the most recent");
});
