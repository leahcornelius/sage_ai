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
