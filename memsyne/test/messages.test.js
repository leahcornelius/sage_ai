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
