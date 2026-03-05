import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createConfig } from "../src/config/env.js";

test("createConfig requires OPENAI_API_KEY", () => {
  assert.throws(
    () => createConfig({ SAGE_API_KEY: "test-key" }),
    /OPENAI_API_KEY/
  );
});

test("createConfig requires SAGE_API_KEY", () => {
  assert.throws(
    () => createConfig({ OPENAI_API_KEY: "openai-key" }),
    /SAGE_API_KEY/
  );
});

test("createConfig parses optional settings and defaults", () => {
  const config = createConfig({
    OPENAI_API_KEY: "openai-key",
    SAGE_API_KEY: "sage-key",
    BRAVE_API_KEY: "brave-key",
    SAGE_OPENAI_MODEL_ALLOWLIST: "gpt-4.1-mini, gpt-5.2",
    SAGE_PORT: "9999",
    SAGE_LOG_PRETTY: "false",
    SAGE_MEMORY_TOP_K: "7",
  });

  assert.equal(config.server.port, 9999);
  assert.equal(config.logging.pretty, false);
  assert.equal(config.logging.consoleLevel, "info");
  assert.equal(config.logging.fileLevel, "debug");
  assert.equal(config.logging.fileEnabled, true);
  assert.equal(config.logging.filePath, path.resolve(process.cwd(), "logs/sage.log"));
  assert.equal(config.memory.topK, 7);
  assert.equal(config.memory.extractEvery, 4);
  assert.equal(config.memory.extractionHistoryMultiplier, 2);
  assert.equal(config.memory.summaryModel, null);
  assert.equal(
    config.memory.conversationDbPath,
    path.resolve(process.cwd(), "data/sage-conversations.sqlite")
  );
  assert.deepEqual(config.openai.modelAllowlist, ["gpt-4.1-mini", "gpt-5.2"]);
  assert.equal(config.tools.enabled, true);
  assert.equal(config.tools.maxRounds, 6);
  assert.equal(config.tools.timeoutMs, 10000);
  assert.equal(config.tools.maxParallelCalls, 4);
  assert.equal(config.tools.memoryWriteEnabled, true);
  assert.deepEqual(config.tools.mcpServers, []);
  assert.equal(config.tools.web.enabled, true);
  assert.equal(config.tools.web.braveApiKey, "brave-key");
  assert.equal(config.tools.web.mode, "llm_context");
  assert.equal(config.tools.web.maxResults, 5);
  assert.equal(config.tools.web.timeoutMs, 8000);
  assert.equal(config.tools.web.safeSearch, "off");
  assert.equal(config.tools.web.country, "GB");
  assert.equal(config.tools.web.searchLang, "en");
  assert.equal(config.tools.documentCache.ttlMs, 3600000);
  assert.equal(config.tools.documentCache.maxDocuments, 500);
  assert.equal(config.tools.documentCache.maxDocumentBytes, 4194304);
});

test("createConfig supports independent console and file log levels", () => {
  const config = createConfig({
    OPENAI_API_KEY: "openai-key",
    SAGE_API_KEY: "sage-key",
    BRAVE_API_KEY: "brave-key",
    SAGE_LOG_LEVEL: "warn",
    SAGE_LOG_CONSOLE_LEVEL: "error",
    SAGE_LOG_FILE_LEVEL: "trace",
    SAGE_LOG_FILE_PATH: "tmp/debug.log",
    SAGE_LOG_FILE_ENABLED: "false",
  });

  assert.equal(config.logging.level, "warn");
  assert.equal(config.logging.consoleLevel, "error");
  assert.equal(config.logging.fileLevel, "trace");
  assert.equal(config.logging.fileEnabled, false);
  assert.equal(config.logging.filePath, path.resolve(process.cwd(), "tmp/debug.log"));
});

test("createConfig falls back to SAGE_LOG_LEVEL for per-destination levels", () => {
  const config = createConfig({
    OPENAI_API_KEY: "openai-key",
    SAGE_API_KEY: "sage-key",
    BRAVE_API_KEY: "brave-key",
    SAGE_LOG_LEVEL: "warn",
  });

  assert.equal(config.logging.consoleLevel, "warn");
  assert.equal(config.logging.fileLevel, "warn");
});

test("createConfig rejects invalid log levels", () => {
  assert.throws(
    () =>
      createConfig({
        OPENAI_API_KEY: "openai-key",
        SAGE_API_KEY: "sage-key",
        SAGE_LOG_CONSOLE_LEVEL: "verbose",
      }),
    /must be one of/
  );
});

test("createConfig parses tool and MCP settings", () => {
  const config = createConfig({
    OPENAI_API_KEY: "openai-key",
    SAGE_API_KEY: "sage-key",
    SAGE_TOOLS_ENABLED: "false",
    SAGE_TOOL_MAX_ROUNDS: "8",
    SAGE_TOOL_TIMEOUT_MS: "15000",
    SAGE_TOOL_MAX_PARALLEL_CALLS: "2",
    SAGE_MEMORY_TOOL_WRITE_ENABLED: "false",
    SAGE_MCP_SERVERS_JSON: '[{"name":"web","transport":"http","url":"https://mcp.example.com"},{"name":"brave","transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-brave-search"],"env":{"BRAVE_API_KEY":"x"}}]',
    WEB_SEARCH_ENABLED: "true",
    BRAVE_API_KEY: "brave-key",
    SAGE_BRAVE_MODE: "web_search",
    SAGE_BRAVE_MAX_RESULTS: "9",
    SAGE_BRAVE_TIMEOUT_MS: "9000",
    SAGE_BRAVE_SAFESEARCH: "moderate",
    SAGE_BRAVE_COUNTRY: "US",
    SAGE_BRAVE_SEARCH_LANG: "en",
    SAGE_DOC_CACHE_TTL_MS: "7200000",
    SAGE_DOC_CACHE_MAX_DOCS: "1000",
    SAGE_DOC_CACHE_MAX_DOC_BYTES: "6000000",
  });

  assert.equal(config.tools.enabled, false);
  assert.equal(config.tools.maxRounds, 8);
  assert.equal(config.tools.timeoutMs, 15000);
  assert.equal(config.tools.maxParallelCalls, 2);
  assert.equal(config.tools.memoryWriteEnabled, false);
  assert.equal(config.tools.mcpServers.length, 2);
  assert.equal(config.tools.web.enabled, true);
  assert.equal(config.tools.web.braveApiKey, "brave-key");
  assert.equal(config.tools.web.mode, "web_search");
  assert.equal(config.tools.web.maxResults, 9);
  assert.equal(config.tools.web.timeoutMs, 9000);
  assert.equal(config.tools.web.safeSearch, "moderate");
  assert.equal(config.tools.web.country, "US");
  assert.equal(config.tools.web.searchLang, "en");
  assert.equal(config.tools.documentCache.ttlMs, 7200000);
  assert.equal(config.tools.documentCache.maxDocuments, 1000);
  assert.equal(config.tools.documentCache.maxDocumentBytes, 6000000);
});

test("createConfig requires BRAVE_API_KEY when WEB_SEARCH_ENABLED=true", () => {
  assert.throws(
    () =>
      createConfig({
        OPENAI_API_KEY: "openai-key",
        SAGE_API_KEY: "sage-key",
        WEB_SEARCH_ENABLED: "true",
      }),
    /BRAVE_API_KEY/
  );
});

test("createConfig accepts disabled web search without BRAVE_API_KEY", () => {
  const config = createConfig({
    OPENAI_API_KEY: "openai-key",
    SAGE_API_KEY: "sage-key",
    WEB_SEARCH_ENABLED: "false",
  });

  assert.equal(config.tools.web.enabled, false);
  assert.equal(config.tools.web.braveApiKey, null);
});

test("createConfig rejects invalid brave enum values", () => {
  assert.throws(
    () =>
      createConfig({
        OPENAI_API_KEY: "openai-key",
        SAGE_API_KEY: "sage-key",
        BRAVE_API_KEY: "brave-key",
        SAGE_BRAVE_MODE: "random",
      }),
    /SAGE_BRAVE_MODE/
  );

  assert.throws(
    () =>
      createConfig({
        OPENAI_API_KEY: "openai-key",
        SAGE_API_KEY: "sage-key",
        BRAVE_API_KEY: "brave-key",
        SAGE_BRAVE_SAFESEARCH: "high",
      }),
    /SAGE_BRAVE_SAFESEARCH/
  );
});

test("createConfig rejects invalid document cache values", () => {
  assert.throws(
    () =>
      createConfig({
        OPENAI_API_KEY: "openai-key",
        SAGE_API_KEY: "sage-key",
        BRAVE_API_KEY: "brave-key",
        SAGE_DOC_CACHE_TTL_MS: "0",
      }),
    /SAGE_DOC_CACHE_TTL_MS/
  );
});

test("createConfig parses memory extraction cadence and conversation db path", () => {
  const config = createConfig({
    OPENAI_API_KEY: "openai-key",
    SAGE_API_KEY: "sage-key",
    BRAVE_API_KEY: "brave-key",
    SAGE_MEMORY_EXTRACT_EVERY: "6",
    SAGE_MEM_EXT_HISTORY_MULTIPLIER: "1.5",
    SAGE_MEMORY_SUMMARY_MODEL: "gpt-4.1-mini",
    SAGE_CONVERSATION_DB_PATH: "./tmp/sage-conversations.sqlite",
  });

  assert.equal(config.memory.extractEvery, 6);
  assert.equal(config.memory.extractionHistoryMultiplier, 1.5);
  assert.equal(config.memory.summaryModel, "gpt-4.1-mini");
  assert.equal(
    config.memory.conversationDbPath,
    path.resolve(process.cwd(), "tmp/sage-conversations.sqlite")
  );
});

test("createConfig rejects invalid memory extraction history multiplier", () => {
  assert.throws(
    () =>
      createConfig({
        OPENAI_API_KEY: "openai-key",
        SAGE_API_KEY: "sage-key",
        BRAVE_API_KEY: "brave-key",
        SAGE_MEM_EXT_HISTORY_MULTIPLIER: "0",
      }),
    /SAGE_MEM_EXT_HISTORY_MULTIPLIER/
  );
});
