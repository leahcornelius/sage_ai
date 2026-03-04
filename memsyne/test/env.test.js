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
  assert.deepEqual(config.openai.modelAllowlist, ["gpt-4.1-mini", "gpt-5.2"]);
  assert.equal(config.tools.enabled, true);
  assert.equal(config.tools.maxRounds, 6);
  assert.equal(config.tools.timeoutMs, 10000);
  assert.equal(config.tools.maxParallelCalls, 4);
  assert.equal(config.tools.memoryWriteEnabled, true);
  assert.deepEqual(config.tools.mcpServers, []);
  assert.equal(config.tools.webSearch.enabled, true);
  assert.equal(config.tools.webSearch.maxResults, 5);
  assert.equal(config.tools.webSearch.timeoutMs, 8000);
});

test("createConfig supports independent console and file log levels", () => {
  const config = createConfig({
    OPENAI_API_KEY: "openai-key",
    SAGE_API_KEY: "sage-key",
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
    SAGE_WEB_SEARCH_ENABLED: "false",
    SAGE_WEB_SEARCH_API_URL: "https://search.example.com",
    SAGE_WEB_SEARCH_API_KEY: "key",
    SAGE_WEB_SEARCH_MAX_RESULTS: "9",
    SAGE_WEB_SEARCH_TIMEOUT_MS: "9000",
  });

  assert.equal(config.tools.enabled, false);
  assert.equal(config.tools.maxRounds, 8);
  assert.equal(config.tools.timeoutMs, 15000);
  assert.equal(config.tools.maxParallelCalls, 2);
  assert.equal(config.tools.memoryWriteEnabled, false);
  assert.equal(config.tools.mcpServers.length, 2);
  assert.equal(config.tools.webSearch.enabled, false);
  assert.equal(config.tools.webSearch.maxResults, 9);
  assert.equal(config.tools.webSearch.timeoutMs, 9000);
});
