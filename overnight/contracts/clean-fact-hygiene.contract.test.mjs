// Clean-fact hygiene (Experiment 5) — lock the rewritten upsertSemanticFacts.
//
// Contract: upsertSemanticFacts stores each distinct atomic fact as a CLEAN,
// scope-tagged, RAW (un-merged) Qdrant point:
//   1. embeds the fact TEXT ONLY — no [scope]/[fact_key]/[version]/... tags in the
//      embedded string (resolves D3.1; same hygiene episodic got in Exp2);
//   2. structural fields live in payload.metadata (scopeKey, factKey, version,
//      status, memoryClass="semantic_fact") — available for the scope filter;
//   3. N distinct facts -> N LIVE points, 0 deleted — distinct atomic facts are NOT
//      duplicates, so the Exp4 merge-bug fix is applied to the semantic path (raw
//      db.store bypasses fullStorePipeline's 0.85/0.92 dedup/merge);
//   4. clean facts are retrievable in-scope via the scoped semantic search and do
//      NOT leak cross-scope.
//
// This is a RED->GREEN contract: before Exp5, upsertSemanticFacts embedded tags and
// routed through mnemosyneClient.store() (the merge pipeline), so #1/#2/#3 all failed.
//
// No model calls — facts are supplied directly (extraction is exercised separately by
// overnight/harness/cleanfact-validate.mjs). Deterministic local-Ollama embeddings.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIsolatedAdapter,
  scrollPoints,
  settle,
  countLive,
  countDeleted,
  dropCollections,
  preflightOnce,
} from "./harness.mjs";

const pf = await preflightOnce();
const skip = pf.ok ? false : `backends unavailable: ${pf.reason}`;

function fact(text, n) {
  return {
    text,
    factKey: `fk_${n}_${text.replace(/\W+/g, "").slice(0, 12)}`,
    sourceMessageId: `m${n}`,
    sourceTurnIds: [n],
    category: "fact",
  };
}

const ALPHA = [
  fact("The route code for the Crimson Falcon yard is Z8VAG0RP.", 0),
  fact("The access badge for the Helios east wing is ALPHA1234.", 1),
  // NB: deliberately NOT a secret-classified fact (no "password"/"token"/"key"):
  // upsertSemanticFacts now drops secret-classified text (raw-store secret guard),
  // which is exercised separately in episodic-buffer.contract.test.mjs.
  fact("The wifi network name in the Helios lab is QWERTY9XZ.", 2),
];
const BETA = [
  fact("The route code for the Crimson Lynx annex is B7TT2KLM.", 0),
  fact("The access badge for the Helios west wing is BETA5678.", 1),
];

test("clean-fact hygiene: embeds fact TEXT ONLY; scopeKey/factKey/semantic_fact in metadata", { skip }, async (t) => {
  const { adapter, collections } = await buildIsolatedAdapter();
  t.after(() => dropCollections(collections));

  const res = await adapter.upsertSemanticFacts({ scopeKey: "scope_alpha", facts: ALPHA });
  assert.equal(res.length, ALPHA.length, "every fact returns a result");
  await settle(collections.shared, ALPHA.length);

  const points = await scrollPoints(collections.shared, { liveOnly: true });
  assert.equal(points.length, ALPHA.length, "N distinct facts -> N live points");

  const byText = new Map(points.map((p) => [p.payload.text, p.payload]));
  for (const f of ALPHA) {
    const payload = byText.get(f.text);
    assert.ok(payload, `fact stored with clean text: ${f.text}`);
    // (1) embedded text is the clean fact, no structural tags.
    assert.doesNotMatch(payload.text, /\[scope:|\[fact_key:|\[version:|\[status:|\[event_time:/, "no tags in embedded text");
    // (2) structural fields in metadata.
    assert.equal(payload.metadata.scopeKey, "scope_alpha");
    assert.equal(payload.metadata.factKey, f.factKey);
    assert.equal(payload.metadata.memoryClass, "semantic_fact");
    assert.equal(payload.metadata.version, 1);
    assert.equal(payload.metadata.status, "active");
  }
});

test("clean-fact raw store: near-duplicate distinct facts are NOT merged (Exp4 fix on semantic path)", { skip }, async (t) => {
  const { adapter, collections } = await buildIsolatedAdapter();
  t.after(() => dropCollections(collections));

  // Two structurally near-identical facts (differ only by the opaque code): the old
  // store()/fullStorePipeline path (0.85 cosine merge) would soft-delete one and drop
  // scopeKey. The raw path must keep BOTH as live, scope-tagged points.
  const nearDupes = [
    fact("The access code for the Helios vault is AAAA1111.", 0),
    fact("The access code for the Helios vault is BBBB2222.", 1),
  ];
  await adapter.upsertSemanticFacts({ scopeKey: "scope_dup", facts: nearDupes });
  await settle(collections.shared, 2);

  assert.equal(await countLive(collections.shared), 2, "both near-duplicate facts are live");
  assert.equal(await countDeleted(collections.shared), 0, "nothing was soft-deleted (no merge)");

  const scopeKeys = (await scrollPoints(collections.shared, { liveOnly: true })).map(
    (p) => p.payload.metadata.scopeKey
  );
  assert.deepEqual([...new Set(scopeKeys)], ["scope_dup"], "scopeKey preserved on every point");
});

test("clean-fact retrieval: scoped semantic search returns in-scope facts, excludes cross-scope", { skip }, async (t) => {
  const { adapter, collections } = await buildIsolatedAdapter();
  t.after(() => dropCollections(collections));

  await adapter.upsertSemanticFacts({ scopeKey: "scope_alpha", facts: ALPHA });
  await adapter.upsertSemanticFacts({ scopeKey: "scope_beta", facts: BETA });
  await settle(collections.shared, ALPHA.length + BETA.length);

  const hits = await adapter.searchSemantic({
    scopeKey: "scope_alpha",
    query: "What is the route code for the Crimson Falcon yard?",
    topK: 5,
    scopeFilter: true,
  });
  assert.ok(hits.length > 0, "scoped search returns in-scope clean facts");
  assert.ok(hits.some((h) => h.text.includes("Z8VAG0RP")), "the in-scope gold fact is retrieved by content");
  assert.ok(!hits.some((h) => h.text.includes("B7TT2KLM")), "no cross-scope (beta) leakage");
  // Clean text out (cleanStoredText is a no-op on untagged facts).
  assert.ok(hits.every((h) => !/\[scope:|\[fact_key:/.test(h.text)), "retrieved text is clean");
});
