// Embedding hygiene (Exp2) — lock it so it can't silently regress.
//
// Contract: storeEpisodic embeds the CLEAN message content; structural fields
// (scopeKey, conversationId, role, turnIndex, messageId, timestamp) live in the Qdrant
// payload's metadata object, NOT in the embedded text.

import assert from "node:assert/strict";
import test from "node:test";

import { buildIsolatedAdapter, scrollPoints, settle, dropCollections, preflightOnce } from "./harness.mjs";

const pf = await preflightOnce();
const skip = pf.ok ? false : `backends unavailable: ${pf.reason}`;

test("storeEpisodic embeds clean content; structural fields live in metadata payload", { skip }, async (t) => {
  const { adapter, collections } = await buildIsolatedAdapter();
  t.after(() => dropCollections(collections));

  const messageText = "I usually drink chamomile tea before a long-haul flight.";
  await adapter.storeEpisodic({
    scopeKey: "scope_hygiene",
    conversationId: "conv-42",
    role: "user",
    messageText,
    messageId: "msg-abc123",
    turnIndex: 7,
    timestamp: "2026-01-02T03:04:05.000Z",
  });
  await settle(collections.shared, 1);

  const points = await scrollPoints(collections.shared, { liveOnly: true });
  assert.equal(points.length, 1);
  const payload = points[0].payload;

  // The embedded text is exactly the clean content — no boilerplate tags.
  assert.equal(payload.text, messageText, "stored/embedded text is the clean message content");
  assert.doesNotMatch(payload.text, /\[scope:|\[turn|\[conversation|message_id:/, "no structural tags in text");

  // Structural fields are preserved in the metadata payload (available for filtering).
  assert.equal(payload.metadata.scopeKey, "scope_hygiene");
  assert.equal(payload.metadata.conversationId, "conv-42");
  assert.equal(payload.metadata.role, "user");
  assert.equal(payload.metadata.turnIndex, 7);
  assert.equal(payload.metadata.messageId, "msg-abc123");
  assert.equal(payload.metadata.memoryClass, "episodic");
});
