// Context-merge / trim contract (pure functions, no backend).
//
// Contract:
//  - Output order is Identity -> Graph -> Semantic -> Episodic.
//  - Trim order under a token budget is episodic -> semantic -> graph; identity is
//    protected (never in the trim order; dropped only via the last-resort fallback).
//  - No scores are threaded; items are popped from the END of each bucket.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMemoryContextBlock,
  mergeMemoryBuckets,
  countTokens,
} from "../../src/services/memory/context-merge.js";

const MODEL = "gpt-4o-mini";

function sample() {
  return mergeMemoryBuckets({
    identityMemories: [{ text: "IDENTITY_ALPHA the user is a pilot" }],
    graphMemories: [{ text: "GRAPH_ALPHA acme employs the user" }, { text: "GRAPH_BETA acme is in berlin" }],
    semanticMemories: [{ text: "SEMANTIC_ALPHA prefers window seats" }, { text: "SEMANTIC_BETA dislikes layovers" }],
    episodicSummaries: [{ text: "EPISODIC_ALPHA user asked about gates" }, { text: "EPISODIC_BETA user said thanks" }],
  });
}

test("mergeMemoryBuckets returns the four buckets and coerces non-arrays to []", () => {
  const merged = mergeMemoryBuckets({ identityMemories: null, graphMemories: undefined, semanticMemories: "x", episodicSummaries: [{ text: "e" }] });
  assert.deepEqual(merged.identity, []);
  assert.deepEqual(merged.graph, []);
  assert.deepEqual(merged.semantic, []);
  assert.equal(merged.episodic.length, 1);
});

test("context block orders buckets Identity -> Graph -> Semantic -> Episodic", () => {
  const block = buildMemoryContextBlock({ merged: sample(), modelId: MODEL, maxTokens: 100_000 });
  const iIdentity = block.indexOf("Identity memories:");
  const iGraph = block.indexOf("Graph facts:");
  const iSemantic = block.indexOf("Semantic memories:");
  const iEpisodic = block.indexOf("Episodic summaries:");
  assert.ok(iIdentity >= 0 && iGraph > iIdentity && iSemantic > iGraph && iEpisodic > iSemantic, block);
});

test("trim drops episodic FIRST when over the token budget", () => {
  const merged = sample();
  // Budget = exactly the block with the episodic bucket emptied -> the trimmer must
  // remove episodic (and nothing else) to fit.
  const noEpisodic = buildMemoryContextBlock({
    merged: { ...merged, episodic: [] },
    modelId: MODEL,
    maxTokens: 100_000,
  });
  const budget = countTokens(noEpisodic, MODEL);
  const trimmed = buildMemoryContextBlock({ merged, modelId: MODEL, maxTokens: budget });
  assert.ok(!trimmed.includes("EPISODIC_ALPHA") && !trimmed.includes("EPISODIC_BETA"), "episodic trimmed");
  assert.ok(trimmed.includes("SEMANTIC_ALPHA") && trimmed.includes("SEMANTIC_BETA"), "semantic kept");
  assert.ok(trimmed.includes("GRAPH_ALPHA") && trimmed.includes("GRAPH_BETA"), "graph kept");
  assert.ok(trimmed.includes("IDENTITY_ALPHA"), "identity kept");
});

test("trim drops semantic SECOND (after episodic), graph kept, identity protected", () => {
  const merged = sample();
  const graphAndIdentityOnly = buildMemoryContextBlock({
    merged: { ...merged, semantic: [], episodic: [] },
    modelId: MODEL,
    maxTokens: 100_000,
  });
  const budget = countTokens(graphAndIdentityOnly, MODEL);
  const trimmed = buildMemoryContextBlock({ merged, modelId: MODEL, maxTokens: budget });
  assert.ok(!trimmed.includes("EPISODIC_ALPHA"), "episodic trimmed");
  assert.ok(!trimmed.includes("SEMANTIC_ALPHA") && !trimmed.includes("SEMANTIC_BETA"), "semantic trimmed");
  assert.ok(trimmed.includes("GRAPH_ALPHA"), "graph still present");
  assert.ok(trimmed.includes("IDENTITY_ALPHA"), "identity protected");
});

test("identity is protected — survives an aggressive budget that empties all other buckets", () => {
  const merged = sample();
  const trimmed = buildMemoryContextBlock({ merged, modelId: MODEL, maxTokens: 6 });
  assert.ok(!trimmed.includes("EPISODIC_ALPHA") && !trimmed.includes("SEMANTIC_ALPHA") && !trimmed.includes("GRAPH_ALPHA"));
  // Either identity survives in the block, or the last-resort fallback message is used.
  assert.ok(
    trimmed.includes("IDENTITY_ALPHA") || trimmed.includes("exceeds token budget"),
    `identity protected or fallback used: ${trimmed}`
  );
});
