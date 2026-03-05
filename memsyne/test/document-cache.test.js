import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { createDocumentCache } from "../src/tools/document-cache.js";

const logger = pino({ level: "silent" });

function createCache(overrides = {}) {
  return createDocumentCache({
    config: {
      tools: {
        documentCache: {
          ttlMs: 1_000,
          maxDocuments: 5,
          maxDocumentBytes: 10_000,
          ...overrides,
        },
      },
    },
    logger,
  });
}

test("document cache stores and retrieves documents", () => {
  const cache = createCache();
  const stored = cache.putDocument({
    url: "https://example.com/a",
    title: "A",
    text: "alpha beta gamma",
    metadata: {},
    source: "direct_fallback",
  });

  const loaded = cache.getDocument(stored.documentId);
  assert.equal(loaded.url, "https://example.com/a");
  assert.equal(loaded.text, "alpha beta gamma");
});

test("document cache readChunk paginates by offset", () => {
  const cache = createCache();
  const stored = cache.putDocument({
    url: "https://example.com/b",
    title: "B",
    text: "x".repeat(8_000),
    metadata: {},
    source: "direct_fallback",
  });

  const first = cache.readChunk({
    documentId: stored.documentId,
    offset: 0,
    maxTokens: 2048,
  });
  const second = cache.readChunk({
    documentId: stored.documentId,
    offset: first.next_offset,
    maxTokens: 2048,
  });

  assert.equal(first.offset, 0);
  assert.equal(first.text.length, 1200);
  assert.equal(second.offset, first.next_offset);
});

test("document cache expires entries by TTL", async () => {
  const cache = createCache({ ttlMs: 10 });
  const stored = cache.putDocument({
    url: "https://example.com/c",
    title: "C",
    text: "short text",
    metadata: {},
    source: "direct_fallback",
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.throws(() => cache.getDocument(stored.documentId), /document_id is not found or has expired/);
});

test("document cache evicts oldest documents when max size is reached", () => {
  const cache = createCache({ maxDocuments: 2 });
  const one = cache.putDocument({
    url: "https://example.com/1",
    title: "1",
    text: "one",
    metadata: {},
    source: "direct_fallback",
  });
  const two = cache.putDocument({
    url: "https://example.com/2",
    title: "2",
    text: "two",
    metadata: {},
    source: "direct_fallback",
  });
  cache.putDocument({
    url: "https://example.com/3",
    title: "3",
    text: "three",
    metadata: {},
    source: "direct_fallback",
  });

  assert.throws(() => cache.getDocument(one.documentId), /document_id is not found or has expired/);
  assert.equal(cache.getDocument(two.documentId).title, "2");
});

test("document cache truncates oversized document payloads", () => {
  const cache = createCache({ maxDocumentBytes: 100 });
  const stored = cache.putDocument({
    url: "https://example.com/long",
    title: "long",
    text: "a".repeat(500),
    metadata: {},
    source: "direct_fallback",
  });

  assert.equal(stored.truncated, true);
  assert.ok(stored.storedBytes <= 100);
});

test("document cache stores stable result_id URL mappings", () => {
  const cache = createCache();
  const results = cache.putSearchResults({
    query: "sage query",
    results: [
      { title: "Example", url: "https://example.com", snippet: "snippet" },
    ],
  });

  assert.equal(results.length, 1);
  assert.equal(cache.resolveResultUrl(results[0].result_id), "https://example.com");
});
