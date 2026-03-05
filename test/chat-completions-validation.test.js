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

test("validateChatCompletionsRequest passes reasoning controls to upstream options", () => {
  const validated = validateChatCompletionsRequest({
    model: "gpt-5.2",
    conversation_id: "conv-1",
    messages: [{ role: "user", content: "Hello" }],
    reasoning_effort: "high",
    reasoning: { effort: "medium" },
  });

  assert.equal(validated.upstreamOptions.reasoning_effort, "high");
  assert.deepEqual(validated.upstreamOptions.reasoning, { effort: "medium" });
});

test("validateChatCompletionsRequest treats reasoning none as unset", () => {
  const validated = validateChatCompletionsRequest({
    model: "gpt-5.2",
    conversation_id: "conv-1",
    messages: [{ role: "user", content: "Hello" }],
    reasoning_effort: "none",
    reasoning: { effort: "none" },
  });

  assert.equal(validated.upstreamOptions.reasoning_effort, undefined);
  assert.equal(validated.upstreamOptions.reasoning, undefined);
});

test("validateChatCompletionsRequest uses configured default model when request model is missing", () => {
  const validated = validateChatCompletionsRequest(
    {
      conversation_id: "conv-1",
      messages: [{ role: "user", content: "Hello" }],
    },
    {
      config: {
        openai: {
          defaultModel: "gpt-5.2-mini",
          allowModelOverride: true,
        },
      },
    }
  );

  assert.equal(validated.model, "gpt-5.2-mini");
});

test("validateChatCompletionsRequest rejects model override when disabled", () => {
  assert.throws(
    () =>
      validateChatCompletionsRequest(
        {
          model: "gpt-5.2",
          conversation_id: "conv-1",
          messages: [{ role: "user", content: "Hello" }],
        },
        {
          config: {
            openai: {
              defaultModel: "gpt-5.2-mini",
              allowModelOverride: false,
            },
          },
        }
      ),
    /override is disabled/
  );
});
