import assert from "node:assert/strict";
import test from "node:test";

import { validateChatCompletionsRequest } from "../src/http/validation/chat-completions.js";

test("validateChatCompletionsRequest requires conversation id", () => {
  assert.throws(
    () =>
      validateChatCompletionsRequest({
        model: "gpt-5.2",
        messages: [{ role: "user", content: "Hello" }],
      }),
    /conversation_id/
  );
});

test("validateChatCompletionsRequest accepts conversationId alias", () => {
  const validated = validateChatCompletionsRequest({
    model: "gpt-5.2",
    conversationId: "conv-1",
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.equal(validated.conversationId, "conv-1");
});

test("validateChatCompletionsRequest rejects mismatched aliases", () => {
  assert.throws(
    () =>
      validateChatCompletionsRequest({
        model: "gpt-5.2",
        conversation_id: "conv-a",
        conversationId: "conv-b",
        messages: [{ role: "user", content: "Hello" }],
      }),
    /must match/
  );
});
