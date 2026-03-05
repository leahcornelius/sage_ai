import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMessages } from "../src/http/validation/messages.js";

test("normalizeMessages accepts string and text-part content", () => {
  const normalized = normalizeMessages([
    { role: "system", content: "You are Sage." },
    {
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: " world" },
      ],
    },
  ]);

  assert.deepEqual(normalized, [
    { role: "system", content: "You are Sage." },
    { role: "user", content: "Hello world" },
  ]);
});

test("normalizeMessages rejects non-text content parts", () => {
  assert.throws(
    () =>
      normalizeMessages([
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/test.png" } }],
        },
      ]),
    /Only text content parts are supported/
  );
});

test("normalizeMessages accepts assistant tool_calls and tool messages", () => {
  const normalized = normalizeMessages([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "get_memories",
            arguments: "{\"query\":\"hello\"}",
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: "{\"ok\":true}",
    },
  ]);

  assert.equal(normalized[0].role, "assistant");
  assert.equal(normalized[0].tool_calls[0].function.name, "get_memories");
  assert.equal(normalized[1].role, "tool");
  assert.equal(normalized[1].tool_call_id, "call_1");
});
