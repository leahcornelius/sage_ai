import assert from "node:assert/strict";
import test from "node:test";

import { validateChatCompletionsRequest } from "../src/http/validation/chat-completions.js";

test("validateChatCompletionsRequest requires chat id headers", () => {
  assert.throws(
    () =>
      validateChatCompletionsRequest({
        model: "gpt-5.2",
        messages: [{ role: "user", content: "Hello" }],
      }),
    /X-OpenWebUI-Chat-Id/
  );
});

test("validateChatCompletionsRequest accepts X-OpenWebUI-Chat-Id", () => {
  const validated = validateChatCompletionsRequest(
    {
      model: "gpt-5.2",
      messages: [{ role: "user", content: "Hello" }],
    },
    {
      headers: {
        "x-openwebui-chat-id": "conv-1",
      },
    }
  );

  assert.equal(validated.chatId, "conv-1");
});

test("validateChatCompletionsRequest accepts X-Conversation-ID", () => {
  const validated = validateChatCompletionsRequest(
    {
      model: "gpt-5.2",
      messages: [{ role: "user", content: "Hello" }],
    },
    {
      headers: {
        "x-conversation-id": "conv-2",
      },
    }
  );

  assert.equal(validated.chatId, "conv-2");
});

test("validateChatCompletionsRequest rejects mismatched chat id headers", () => {
  assert.throws(
    () =>
      validateChatCompletionsRequest(
        {
          model: "gpt-5.2",
          messages: [{ role: "user", content: "Hello" }],
        },
        {
          headers: {
            "x-openwebui-chat-id": "conv-1",
            "x-conversation-id": "conv-2",
          },
        }
      ),
    /must match/
  );
});

test("validateChatCompletionsRequest passes reasoning controls to upstream options", () => {
  const validated = validateChatCompletionsRequest(
    {
      model: "gpt-5.2",
      messages: [{ role: "user", content: "Hello" }],
      reasoning_effort: "high",
      reasoning: { effort: "medium" },
    },
    {
      headers: {
        "x-openwebui-chat-id": "conv-1",
      },
    }
  );

  assert.equal(validated.upstreamOptions.reasoning_effort, "high");
  assert.deepEqual(validated.upstreamOptions.reasoning, { effort: "medium" });
});

test("validateChatCompletionsRequest treats reasoning none as unset", () => {
  const validated = validateChatCompletionsRequest(
    {
      model: "gpt-5.2",
      messages: [{ role: "user", content: "Hello" }],
      reasoning_effort: "none",
      reasoning: { effort: "none" },
    },
    {
      headers: {
        "x-openwebui-chat-id": "conv-1",
      },
    }
  );

  assert.equal(validated.upstreamOptions.reasoning_effort, undefined);
  assert.equal(validated.upstreamOptions.reasoning, undefined);
});

test("validateChatCompletionsRequest uses configured default model when request model is missing", () => {
  const validated = validateChatCompletionsRequest(
    {
      messages: [{ role: "user", content: "Hello" }],
    },
    {
      config: {
        openai: {
          defaultModel: "gpt-5.2-mini",
          allowModelOverride: true,
        },
      },
      headers: {
        "x-openwebui-chat-id": "conv-1",
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
          messages: [{ role: "user", content: "Hello" }],
        },
        {
          config: {
            openai: {
              defaultModel: "gpt-5.2-mini",
              allowModelOverride: false,
            },
          },
          headers: {
            "x-openwebui-chat-id": "conv-1",
          },
        }
      ),
    /override is disabled/
  );
});
