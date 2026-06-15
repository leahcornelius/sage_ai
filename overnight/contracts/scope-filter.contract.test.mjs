// Scope handling / cross-scope bleed / scope-filter.
//
// Contract: scoped semantic recall (scopeFilter ON) returns ONLY in-scope points (the
// payload filter on metadata.scopeKey is exact). Unscoped recall (OFF) searches the
// whole shared collection and CAN surface cross-scope lookalikes (bleed) — the realistic
// condition scope-filtering exists to fix. Depends on the #1 fix preserving scopeKey.

import assert from "node:assert/strict";
import test from "node:test";

import { buildIsolatedAdapter, settle, dropCollections, preflightOnce } from "./harness.mjs";

const pf = await preflightOnce();
const skip = pf.ok ? false : `backends unavailable: ${pf.reason}`;

const QUERY = "What is the Helios project access badge code?";

// Two scopes with near-identical facts; a unique per-scope token marks provenance.
const ALPHA = [
  "The Helios project access badge code is ALPHAONLY1 for the east wing entrance.",
  "The Helios project parking permit is ALPHAONLY2 for visitors.",
  "The Helios project wifi password is ALPHAONLY3 in the lab.",
];
const BETA = [
  "The Helios project access badge code is BETAONLY1 for the west wing entrance.",
  "The Helios project parking permit is BETAONLY2 for visitors.",
  "The Helios project wifi password is BETAONLY3 in the lab.",
];

async function seedScope(adapter, scopeKey, facts) {
  for (let i = 0; i < facts.length; i++) {
    await adapter.storeEpisodic({
      scopeKey,
      conversationId: `${scopeKey}-c`,
      role: "user",
      messageText: facts[i],
      messageId: `${scopeKey}-m${i}`,
      turnIndex: i,
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    });
  }
}

async function seedBoth(adapter, collections) {
  await seedScope(adapter, "scope_alpha", ALPHA);
  await seedScope(adapter, "scope_beta", BETA);
  await settle(collections.shared, ALPHA.length + BETA.length);
}

test("scopeFilter ON returns ONLY in-scope points (no cross-scope leakage)", { skip }, async (t) => {
  const { adapter, collections } = await buildIsolatedAdapter();
  t.after(() => dropCollections(collections));
  await seedBoth(adapter, collections);

  const alpha = await adapter.searchSemantic({ scopeKey: "scope_alpha", query: QUERY, topK: 10, scopeFilter: true });
  assert.ok(alpha.length > 0, "scoped recall returns in-scope results");
  assert.ok(alpha.every((r) => r.text.includes("ALPHAONLY")), `only alpha results: ${alpha.map((r) => r.text)}`);
  assert.ok(!alpha.some((r) => r.text.includes("BETAONLY")), "no beta leakage");

  const beta = await adapter.searchSemantic({ scopeKey: "scope_beta", query: QUERY, topK: 10, scopeFilter: true });
  assert.ok(beta.every((r) => r.text.includes("BETAONLY")), `only beta results: ${beta.map((r) => r.text)}`);
});

test("scopeFilter OFF can bleed cross-scope; ON and OFF differ", { skip }, async (t) => {
  const { adapter, collections } = await buildIsolatedAdapter();
  t.after(() => dropCollections(collections));
  await seedBoth(adapter, collections);

  const off = await adapter.searchSemantic({ scopeKey: "scope_alpha", query: QUERY, topK: 10, scopeFilter: false });
  const on = await adapter.searchSemantic({ scopeKey: "scope_alpha", query: QUERY, topK: 10, scopeFilter: true });

  const offHasBeta = off.some((r) => r.text.includes("BETAONLY"));
  t.diagnostic(`unscoped results=${off.length} (beta present=${offHasBeta}); scoped results=${on.length}`);

  // Core contrast: the scoped set never contains beta; the unscoped set is not restricted
  // to alpha (it reaches the whole collection). On this fixture unscoped surfaces beta.
  assert.ok(!on.some((r) => r.text.includes("BETAONLY")), "scoped excludes beta");
  assert.ok(offHasBeta, "unscoped reaches cross-scope (beta) — bleed demonstrated");
});
