// semanticTopK -> limit (Exp1) — lock it.
//
// Contract: semanticTopK=k returns AT MOST k semantic results; the knob controls the
// count on both paths. OFF: mnemosy-ai recall() honors `limit` (not `topK`), so
// searchSemantic passes limit=topK. ON: db.search is limited to topK directly.

import assert from "node:assert/strict";
import test from "node:test";

import { buildIsolatedAdapter, settle, dropCollections, preflightOnce } from "./harness.mjs";

const pf = await preflightOnce();
const skip = pf.ok ? false : `backends unavailable: ${pf.reason}`;

const SCOPE = "scope_topk";
const QUERY = "Tell me everything about the Helios project.";

// Six thematically-related, distinct facts — all comfortably above minScore for QUERY,
// so topK is the binding constraint (not minScore filtering).
const FACTS = [
  "The Helios project lead engineer is Dana Okonkwo.",
  "The Helios project launch window opens in late March.",
  "The Helios project budget was approved at four million euros.",
  "The Helios project uses a solar-sail propulsion prototype.",
  "The Helios project ground station is located near Tromso.",
  "The Helios project review board meets every second Tuesday.",
];

async function seed(adapter, collections) {
  for (let i = 0; i < FACTS.length; i++) {
    await adapter.storeEpisodic({
      scopeKey: SCOPE,
      conversationId: "c1",
      role: "user",
      messageText: FACTS[i],
      messageId: `m-${i}`,
      turnIndex: i,
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    });
  }
  await settle(collections.shared, FACTS.length);
}

test("scoped (ON) semantic recall returns exactly topK when enough in-scope matches exist", { skip }, async (t) => {
  const { adapter, collections } = await buildIsolatedAdapter();
  t.after(() => dropCollections(collections));
  await seed(adapter, collections);

  for (const k of [1, 3, 6]) {
    const results = await adapter.searchSemantic({ scopeKey: SCOPE, query: QUERY, topK: k, scopeFilter: true });
    assert.equal(results.length, k, `scopeFilter ON: topK=${k} -> ${results.length}`);
  }
});

test("unscoped (OFF) semantic recall returns at most topK", { skip }, async (t) => {
  const { adapter, collections } = await buildIsolatedAdapter();
  t.after(() => dropCollections(collections));
  await seed(adapter, collections);

  for (const k of [1, 2, 4]) {
    const results = await adapter.searchSemantic({ scopeKey: SCOPE, query: QUERY, topK: k, scopeFilter: false });
    assert.ok(results.length <= k, `scopeFilter OFF: topK=${k} -> ${results.length} (must be <= ${k})`);
  }
});
