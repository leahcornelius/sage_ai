// Entry #1 — the merge bug (HEADLINE).
//
// Intended contract: ingesting N distinct episodic turns yields N LIVE (non-deleted)
// points, each retaining metadata.scopeKey, with the gold retrievable within scope.
//
// Defect: episodic turns routed through mnemosyneClient.store() -> fullStorePipeline run
// an unconditional 0.85/0.92-cosine dedup/merge (mnemosy-ai dist/index.js:186-247):
// near-duplicate turns get soft-deleted and the survivor's metadata is overwritten,
// dropping scopeKey. The bury mechanic plants gold early, so gold is the merge loser.
//
// Fix: storeEpisodic always writes via the raw db.store path (skips dedup/merge).
//
// Test A characterizes the upstream corruption (documents WHY we bypass) and stays green.
// Test B is the contract: RED before the fix (default merges), GREEN after.
// Test C makes the BM25 consequence of the fix EXPLICIT (raw store -> vector-only).

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIsolatedClient,
  buildIsolatedAdapter,
  countLive,
  countDeleted,
  liveScopeKeys,
  dropCollections,
  preflightOnce,
} from "./harness.mjs";

const pf = await preflightOnce();
const skip = pf.ok ? false : `backends unavailable: ${pf.reason}`;

const SCOPE = "scope_alpha";
const BASE =
  "The quarterly revenue summary for the northeast regional sales division remains under active internal review pending sign-off";

const GOLD_INDEX = 3;
const GOLD_MARKER = "GOLD7Q";
const GOLD_TEXT = `Reminder: the vault access code for the Mercury archival project is ${GOLD_MARKER}, effective at the next scheduled maintenance window.`;

function markerFor(i) {
  return `MK${String(i).padStart(4, "0")}`;
}

// N turns in one scope: mostly near-duplicate filler (a long shared prefix so pairwise
// cosine reliably exceeds mnemosy-ai's merge threshold — mirrors the homogeneous
// benchmark facts) plus ONE semantically-distinct gold turn at GOLD_INDEX. The filler
// drives the merge corruption (Test A); the distinct gold is reliably retrievable by
// its own content (Test B) without depending on approximate search over near-identical
// vectors.
function buildTurns(n, scopeKey = SCOPE) {
  return Array.from({ length: n }, (_, i) => ({
    scopeKey,
    conversationId: "conv-1",
    role: "user",
    messageText:
      i === GOLD_INDEX ? GOLD_TEXT : `${BASE}; tracking marker ${markerFor(i)}.`,
    messageId: `m-${i}`,
    turnIndex: i,
    timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  }));
}

test(
  "entry #1 (characterization): mnemosyneClient.store() merge soft-deletes near-duplicate facts and drops scopeKey",
  { skip },
  async (t) => {
    const { client, collections } = await buildIsolatedClient();
    t.after(() => dropCollections(collections));

    const N = 12;
    for (const turn of buildTurns(N)) {
      await client.store({ text: turn.messageText, metadata: { scopeKey: SCOPE, turnIndex: turn.turnIndex } });
    }

    // Poll for eventual write visibility: mnemosy-ai's store() schedules the
    // soft-delete asynchronously, so an immediate read can miss it and flake.
    let live = 0;
    let dead = 0;
    for (let i = 0; i < 40; i++) {
      live = await countLive(collections.shared);
      dead = await countDeleted(collections.shared);
      if (live + dead >= N) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    t.diagnostic(`merge path: live=${live} dead=${dead} of N=${N}`);

    assert.ok(live < N, `merge collapses near-dups: expected live < ${N}, got ${live}`);
    assert.ok(dead > 0, `merge soft-deletes losers: expected dead > 0, got ${dead}`);

    const scopeKeys = await liveScopeKeys(collections.shared);
    assert.ok(
      scopeKeys.some((k) => k == null),
      "merge overwrites metadata on survivors -> at least one live point has no scopeKey"
    );
  }
);

test(
  "entry #1 (contract): storeEpisodic preserves every distinct turn as a live point with scopeKey, gold retrievable",
  { skip },
  async (t) => {
    const { adapter, collections } = await buildIsolatedAdapter();
    t.after(() => dropCollections(collections));

    const N = 12;
    const turns = buildTurns(N);
    for (const turn of turns) {
      await adapter.storeEpisodic(turn);
    }

    // Poll for eventual write visibility: db.store does not wait for the point to be
    // searchable, so an immediate read flakes (worse under npm-test concurrency).
    let live = 0;
    let dead = 0;
    for (let i = 0; i < 100; i++) {
      live = await countLive(collections.shared);
      dead = await countDeleted(collections.shared);
      if (live >= N) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    t.diagnostic(`raw episodic path: live=${live} dead=${dead} of N=${N}`);

    assert.equal(live, N, `every distinct turn is a live point: expected ${N}, got ${live}`);
    assert.equal(dead, 0, `no soft-deletes on the raw episodic path: expected 0, got ${dead}`);

    const scopeKeys = await liveScopeKeys(collections.shared);
    assert.equal(scopeKeys.length, N);
    assert.ok(
      scopeKeys.every((k) => k === SCOPE),
      `every live point retains its scopeKey: ${JSON.stringify(scopeKeys)}`
    );

    // Gold retrievable within scope (scoped semantic = plain vector + payload filter).
    const results = await adapter.searchSemantic({
      scopeKey: SCOPE,
      query: GOLD_TEXT,
      topK: 5,
      scopeFilter: true,
    });
    assert.ok(
      results.some((r) => String(r.text || "").includes(GOLD_MARKER)),
      `gold marker ${GOLD_MARKER} retrievable within scope`
    );
  }
);

test(
  "entry #1 (consequence, explicit): raw episodic store is vector-only — no in-process BM25 lexical index",
  { skip },
  async (t) => {
    // HARD contract: the live bm25Index is private to mnemosy-ai's createMnemosyne
    // closure and is NOT exposed on the client (dist/index.js:387-480). addDocument is
    // only ever called inside fullStorePipeline (dist/index.js:293). Therefore the raw
    // db.store path provably cannot index BM25 in-process — episodic raw store is
    // vector-only until the next client restart re-bootstraps from Qdrant.
    const { client, collections } = await buildIsolatedClient();
    t.after(() => dropCollections(collections));
    assert.equal(client.bm25Index, undefined, "bm25Index must not be reachable from the client");

    // Positive control + informational contrast (diagnostic only — recall scoring is
    // model-dependent, so we don't gate the suite on it; the structural guarantee above
    // is the hard contract).
    const token = "QX9ZK7TOKEN";
    const text = `Lorem ipsum dolor sit amet consectetur adipiscing elit; reference ${token}.`;

    await client.store({ text, metadata: { scopeKey: SCOPE } }); // merge path -> BM25 indexed
    const merged = await client.recall({ query: token, limit: 5 });
    const mergedHit = (merged || []).some((r) => String(r?.entry?.text || "").includes(token));

    const { client: rawClient, collections: rawCols } = await buildIsolatedClient();
    t.after(() => dropCollections(rawCols));
    const vec = await rawClient.embeddings.embed(text);
    await rawClient.db.store(text, vec, {
      classification: "public",
      memoryType: "semantic",
      metadata: { scopeKey: SCOPE },
    });
    const raw = await rawClient.recall({ query: token, limit: 5 });
    const rawHit = (raw || []).some((r) => String(r?.entry?.text || "").includes(token));

    t.diagnostic(
      `exact-token recall: merge-path(BM25) hit=${mergedHit}, raw-path(vector-only) hit=${rawHit}`
    );
  }
);
