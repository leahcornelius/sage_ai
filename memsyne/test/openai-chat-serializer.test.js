import assert from "node:assert/strict";
import test from "node:test";

import {
  serializeChatCompletion,
  serializeChatCompletionChunk,
} from "../src/http/serializers/openai-chat.js";

class NonEnumerableChunk {
  constructor() {
    Object.defineProperty(this, "id", { value: "chunk-1", enumerable: false });
    Object.defineProperty(this, "object", { value: "chat.completion.chunk", enumerable: false });
    Object.defineProperty(this, "created", { value: 123, enumerable: false });
    Object.defineProperty(this, "model", { value: "gpt-5.2", enumerable: false });
    Object.defineProperty(this, "choices", {
      value: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
      enumerable: false,
    });
  }
}

class NonEnumerableCompletion {
  constructor() {
    Object.defineProperty(this, "id", { value: "cmpl-1", enumerable: false });
    Object.defineProperty(this, "object", { value: "chat.completion", enumerable: false });
    Object.defineProperty(this, "created", { value: 123, enumerable: false });
    Object.defineProperty(this, "model", { value: "gpt-5.2", enumerable: false });
    Object.defineProperty(this, "choices", {
      value: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      enumerable: false,
    });
  }
}

test("serializeChatCompletionChunk preserves SDK-style non-enumerable fields", () => {
  const chunk = serializeChatCompletionChunk(new NonEnumerableChunk());

  assert.equal(chunk.id, "chunk-1");
  assert.equal(chunk.object, "chat.completion.chunk");
  assert.equal(chunk.model, "gpt-5.2");
  assert.equal(chunk.choices[0].delta.content, "Hello");
});

test("serializeChatCompletion preserves SDK-style non-enumerable fields", () => {
  const completion = serializeChatCompletion(new NonEnumerableCompletion());

  assert.equal(completion.id, "cmpl-1");
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.model, "gpt-5.2");
  assert.equal(completion.choices[0].message.content, "Hello");
});
