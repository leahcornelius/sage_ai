import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { createAddMemoryHandler } from "../src/tools/builtin/add-memory.js";
import { createFindInDocumentHandler } from "../src/tools/builtin/find-in-document.js";
import { createGetMemoriesHandler } from "../src/tools/builtin/get-memories.js";
import { createGetUrlContentHandler } from "../src/tools/builtin/get-url-content.js";
import { createReadDocumentChunkHandler } from "../src/tools/builtin/read-document-chunk.js";
import { createWebSearchHandler } from "../src/tools/builtin/web-search.js";
import { createDocumentCache } from "../src/tools/document-cache.js";

const logger = pino({ level: "silent" });

function createWebConfig(overrides = {}) {
  return {
    tools: {
      web: {
        enabled: true,
        braveApiKey: "brave-key",
        mode: "llm_context",
        maxResults: 5,
        timeoutMs: 500,
        safeSearch: "off",
        country: "GB",
        searchLang: "en",
        ...overrides,
      },
      documentCache: {
        ttlMs: 3_600_000,
        maxDocuments: 500,
        maxDocumentBytes: 4_194_304,
      },
    },
  };
}

function createCache() {
  return createDocumentCache({
    config: createWebConfig(),
    logger,
  });
}

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

test("web_search returns lightweight metadata and stable result_id", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      json: async () => ({
        summary: "Long contextual summary that should not be returned directly.",
        web: {
          results: [{ title: "Result", url: "https://example.com", description: "Snippet text" }],
        },
      }),
    };
  };

  try {
    const documentCache = createCache();
    const handler = createWebSearchHandler({
      config: createWebConfig(),
      documentCache,
    });

    const result = await handler({
      args: {
        query: "test query",
        max_tokens: 16384,
      },
      logger,
    });

    const parsed = new URL(requestedUrl);
    assert.equal(parsed.searchParams.get("summary"), "true");
    assert.equal(parsed.searchParams.get("maximum_number_of_tokens_per_url"), "16384");
    assert.equal(result.result_count, 1);
    assert.equal(result.results[0].url, "https://example.com");
    assert.ok(result.results[0].result_id.startsWith("sr_"));
    assert.equal(result.context, undefined);
    assert.equal(documentCache.resolveResultUrl(result.results[0].result_id), "https://example.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web_search rejects invalid max_tokens values", async () => {
  const handler = createWebSearchHandler({
    config: createWebConfig(),
    documentCache: createCache(),
  });

  await assert.rejects(
    () =>
      handler({
        args: {
          query: "query",
          max_tokens: 1234,
        },
        logger,
      }),
    /max_tokens/
  );
});

test("get_url_content caches document and returns document handle", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      web: {
        results: [
          {
            title: "Example Article",
            url: "https://example.com/post",
            description: "Description from Brave with substantial body text. ".repeat(12),
            extra_snippets: [
              "More context from Brave that is long enough to trigger Brave-first usage. ".repeat(8),
              "Additional details for the same URL. ".repeat(8),
            ],
          },
        ],
      },
    }),
  });

  try {
    const documentCache = createCache();
    const handler = createGetUrlContentHandler({
      config: createWebConfig(),
      documentCache,
    });
    const readChunk = createReadDocumentChunkHandler({ documentCache });

    const result = await handler({
      args: {
        url: "https://example.com/post",
      },
      logger,
    });

    assert.equal(result.source, "brave");
    assert.ok(result.document_id.startsWith("doc_"));
    assert.ok(result.preview.length > 0);

    const chunk = await readChunk({
      args: {
        document_id: result.document_id,
        offset: 0,
        max_tokens: 2048,
      },
      logger,
    });
    assert.equal(chunk.document_id, result.document_id);
    assert.ok(chunk.text.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("get_url_content supports result_id and direct fallback", async () => {
  const originalFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = async () => {
    callIndex += 1;
    if (callIndex === 1) {
      return {
        ok: true,
        json: async () => ({
          web: {
            results: [{ title: "Example", url: "https://example.com/article", description: "Snippet" }],
          },
        }),
      };
    }
    if (callIndex === 2) {
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      };
    }

    return {
      ok: true,
      url: "https://example.com/article",
      headers: {
        get: (name) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null),
      },
      text: async () =>
        "<html><head><title>Test Title</title></head><body><h1>Hello</h1><p>World content</p></body></html>",
    };
  };

  try {
    const documentCache = createCache();
    const webSearch = createWebSearchHandler({
      config: createWebConfig(),
      documentCache,
    });
    const urlHandler = createGetUrlContentHandler({
      config: createWebConfig(),
      documentCache,
    });
    const finder = createFindInDocumentHandler({ documentCache });

    const searchResult = await webSearch({
      args: { query: "article" },
      logger,
    });
    const resultId = searchResult.results[0].result_id;

    const contentResult = await urlHandler({
      args: {
        result_id: resultId,
        max_tokens: 2048,
      },
      logger,
    });

    assert.equal(contentResult.source, "direct_fallback");
    assert.ok(contentResult.document_id.startsWith("doc_"));

    const findResult = await finder({
      args: {
        document_id: contentResult.document_id,
        query: "world",
      },
      logger,
    });
    assert.ok(findResult.match_count >= 1);
    assert.ok(findResult.matches[0].excerpt.toLowerCase().includes("world"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web tooling handlers reject when disabled", async () => {
  const webHandler = createWebSearchHandler({
    config: createWebConfig({ enabled: false }),
    documentCache: createCache(),
  });
  const urlHandler = createGetUrlContentHandler({
    config: createWebConfig({ enabled: false }),
    documentCache: createCache(),
  });

  await assert.rejects(
    () => webHandler({ args: { query: "hello" }, logger }),
    /disabled/
  );
  await assert.rejects(
    () => urlHandler({ args: { url: "https://example.com" }, logger }),
    /disabled/
  );
});
