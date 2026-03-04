import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { createGetMemoriesHandler } from "../src/tools/builtin/get-memories.js";
import { createAddMemoryHandler } from "../src/tools/builtin/add-memory.js";
import { createWebSearchHandler } from "../src/tools/builtin/web-search.js";

const logger = pino({ level: "silent" });

test("get_memories handler returns memory results", async () => {
  const handler = createGetMemoriesHandler({
    memoryService: {
      getMemoriesForTool: async () => [{ text: "prefers tea" }],
    },
  });

  const result = await handler({
    args: {
      query: "tea",
    },
    logger,
  });

  assert.equal(result.count, 1);
  assert.equal(result.memories[0].text, "prefers tea");
});

test("add_memory handler enforces write flag", async () => {
  const handler = createAddMemoryHandler({
    config: {
      tools: {
        memoryWriteEnabled: false,
      },
    },
    memoryService: {
      addMemoryFromTool: async () => ({}),
    },
  });

  await assert.rejects(
    () =>
      handler({
        args: { text: "new memory" },
        logger,
      }),
    /disabled/
  );
});

test("web_search handler calls provider and normalizes results", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      results: [{ title: "Result", url: "https://example.com", snippet: "Snippet" }],
    }),
  });

  try {
    const handler = createWebSearchHandler({
      config: {
        tools: {
          webSearch: {
            enabled: true,
            apiUrl: "https://search.example.com",
            apiKey: "secret",
            maxResults: 5,
            timeoutMs: 500,
          },
        },
      },
    });

    const result = await handler({
      args: {
        query: "test query",
      },
      logger,
    });

    assert.equal(result.result_count, 1);
    assert.equal(result.results[0].url, "https://example.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
