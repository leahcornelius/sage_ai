// Semantic recall pipeline — characterization of the REAL behaviour + the ON/OFF
// post-processing asymmetry.
//
// OFF (scopeFilter false): mnemosy-ai recall() over the whole shared collection —
//   over-fetch x3 -> hybrid(vector+BM25) -> decay/multi-signal rescoring + intent
//   threshold (~0.35) + diversity rerank -> slice to limit. Reaches cross-scope.
// ON (scopeFilter true): a PLAIN db.search (vector + payload filter on metadata.scopeKey,
//   minScore 0.3) — NO hybrid / decay / rerank.
//
// So the two arms apply different post-processing; an A/B over scopeFilter compares
// scope-restriction AND pipeline, which is why Exp3 added a raw-db.search control probe.

import assert from "node:assert/strict";
import test from "node:test";

import { buildIsolatedAdapter, settle, dropCollections, preflightOnce } from "./harness.mjs";

const pf = await preflightOnce();
const skip = pf.ok ? false : `backends unavailable: ${pf.reason}`;

const SCOPE = "scope_recall";
const QUERY = "Details about the Helios project ground operations.";
const FACTS = [
  "The Helios project ground station is near Tromso.",
  "The Helios project mission control runs three shifts.",
  "The Helios project telemetry uplink uses S-band.",
  "The Helios project recovery team is on standby in Reykjavik.",
  "The Helios project fuel handling follows protocol seven.",
];

async function seed(adapter, scopeKey = SCOPE) {
  for (let i = 0; i < FACTS.length; i++) {
    await adapter.storeEpisodic({
      scopeKey,
      conversationId: "c1",
      role: "user",
      messageText: FACTS[i],
      messageId: `${scopeKey}-m${i}`,
      turnIndex: i,
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    });
  }
}

test("ON path is a plain filtered vector search: searchSemantic(ON) == db.search with the scope filter", { skip }, async (t) => {
  const { adapter, client, collections } = await buildIsolatedAdapter();
  t.after(() => dropCollections(collections));
  await seed(adapter);
  await settle(collections.shared, FACTS.length);

  const onTexts = (await adapter.searchSemantic({ scopeKey: SCOPE, query: QUERY, topK: 3, scopeFilter: true }))
    .map((r) => r.text)
    .sort();

  // Reproduce the ON path directly: embed -> db.search(shared, vec, topK, 0.3, {scopeKey}).
  const vec = await client.embeddings.embed(QUERY);
  const raw = (await client.db.search(collections.shared, vec, 3, 0.3, { "metadata.scopeKey": SCOPE }))
    .map((r) => r.entry.text)
    .sort();

  assert.deepEqual(onTexts, raw, "ON path applies no rerank/decay beyond the raw filtered vector search");
});

test("OFF path reaches the global pool and respects topK (full recall pipeline)", { skip }, async (t) => {
  const { adapter, collections } = await buildIsolatedAdapter();
  t.after(() => dropCollections(collections));
  await seed(adapter, "scope_one");
  await seed(adapter, "scope_two");
  await settle(collections.shared, FACTS.length * 2);

  const off = await adapter.searchSemantic({ scopeKey: "scope_one", query: QUERY, topK: 4, scopeFilter: false });
  assert.ok(off.length <= 4, "OFF respects topK");
  assert.ok(off.length > 0, "OFF returns results from the global pool");
  t.diagnostic(`OFF returned ${off.length} of up to 4 (post decay/intent-threshold/diversity rerank)`);
});
