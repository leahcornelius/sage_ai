// Harness validity — the measurement apparatus must reflect LIVE behaviour.
//
// (1) Completeness/retrieval count LIVE points only. mnemosy-ai soft-deletes via a
//     `deleted:true` payload flag and db.search filters deleted=false. The Exp2
//     diagnostics never checked this flag, so soft-deleted gold was counted as present.
//     Lock: a soft-deleted point is excluded from both live counting and retrieval.
// (2) The offline preview is NOT a proxy for live retrieval. Offline within-scope
//     cosine rank can be excellent while live UNSCOPED recall buries the gold globally
//     (the Exp2/Exp3 over-optimism). Guard: surface both so divergence is visible, and
//     pin the documented direction (offline within-scope is optimistic).

import assert from "node:assert/strict";
import test from "node:test";

import { buildIsolatedAdapter, countLive, settle, scrollPoints, dropCollections, preflightOnce } from "./harness.mjs";

const pf = await preflightOnce();
const skip = pf.ok ? false : `backends unavailable: ${pf.reason}`;

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

test("live counting + retrieval exclude soft-deleted points", { skip }, async (t) => {
  const { adapter, client, collections } = await buildIsolatedAdapter();
  t.after(() => dropCollections(collections));

  const facts = [
    "The aurora observation window is code RED41 tonight.",
    "The aurora observation window is code BLUE22 tomorrow.",
    "The aurora observation window is code GREEN9 on friday.",
  ];
  for (let i = 0; i < facts.length; i++) {
    await adapter.storeEpisodic({
      scopeKey: "scope_live",
      conversationId: "c1",
      role: "user",
      messageText: facts[i],
      messageId: `m-${i}`,
      turnIndex: i,
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    });
  }
  await settle(collections.shared, facts.length);

  // Soft-delete the RED41 point.
  const points = await scrollPoints(collections.shared, { liveOnly: true });
  const red = points.find((p) => p.payload.text.includes("RED41"));
  assert.ok(red, "RED41 point exists before deletion");
  await client.db.softDelete(collections.shared, red.id);
  await settle(collections.shared, facts.length - 1);

  assert.equal(await countLive(collections.shared), 2, "live count excludes the soft-deleted point");

  const results = await adapter.searchSemantic({
    scopeKey: "scope_live",
    query: "aurora observation window code RED41",
    topK: 10,
    scopeFilter: true,
  });
  assert.ok(!results.some((r) => r.text.includes("RED41")), "retrieval excludes the soft-deleted point");
});

test("offline within-scope cosine rank is NOT a proxy for live global retrieval (divergence guard)", { skip }, async (t) => {
  const { adapter, client, collections } = await buildIsolatedAdapter();
  t.after(() => dropCollections(collections));

  // One scope's gold, plus many cross-scope homogeneous lookalikes (the Exp condition).
  const goldText = "The maintenance override sequence for bay seven is XQ-GOLD-7788.";
  await adapter.storeEpisodic({
    scopeKey: "scope_gold",
    conversationId: "g",
    role: "user",
    messageText: goldText,
    messageId: "gold",
    turnIndex: 0,
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  for (let s = 0; s < 6; s++) {
    for (let i = 0; i < 8; i++) {
      await adapter.storeEpisodic({
        scopeKey: `scope_distract_${s}`,
        conversationId: `d${s}`,
        role: "user",
        messageText: `The maintenance override sequence for bay ${i} is XQ-D${s}${i}-0000.`,
        messageId: `d-${s}-${i}`,
        turnIndex: i,
        timestamp: new Date(1_700_000_000_000 + (s * 8 + i) * 1000).toISOString(),
      });
    }
  }
  await settle(collections.shared, 1 + 6 * 8);

  const query = "What is the maintenance override sequence for bay seven?";
  const qvec = await client.embeddings.embed(query);

  // OFFLINE within-scope rank: cosine of the query against the gold's scope only.
  const inScope = (await scrollPoints(collections.shared, { liveOnly: true })).filter(
    (p) => p.payload.metadata?.scopeKey === "scope_gold"
  );
  // (only the gold is in scope_gold -> trivially rank 1; this models the offline preview
  // measuring rank within the candidate's own scope.)
  const goldVec = await client.embeddings.embed(goldText);
  const offlineWithinScopeCos = cosine(qvec, goldVec);

  // LIVE unscoped recall over the whole (homogeneous, cross-scope) pool.
  const live = await adapter.searchSemantic({ scopeKey: "scope_gold", query, topK: 5, scopeFilter: false });
  const liveUnscopedFound = live.some((r) => r.text.includes("XQ-GOLD-7788"));

  // LIVE scoped recall (the fix the gap motivates).
  const scoped = await adapter.searchSemantic({ scopeKey: "scope_gold", query, topK: 5, scopeFilter: true });
  const liveScopedFound = scoped.some((r) => r.text.includes("XQ-GOLD-7788"));

  t.diagnostic(
    `offline within-scope gold cosine=${offlineWithinScopeCos.toFixed(3)}; ` +
      `live unscoped found=${liveUnscopedFound}; live scoped found=${liveScopedFound}`
  );

  // The documented lesson: offline within-scope is optimistic (high cosine / would rank
  // gold top within its scope), while the scoped channel is what actually carries the gold
  // live. We assert the robust, deterministic halves and surface the unscoped result so a
  // future offline-vs-live divergence is visible rather than silently assumed away.
  assert.ok(offlineWithinScopeCos > 0.5, "offline within-scope signal is strong (optimistic)");
  assert.ok(liveScopedFound, "live scoped retrieval carries the gold (offline signal transfers via scoping)");
});
