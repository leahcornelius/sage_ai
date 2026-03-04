import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLogger } from "../src/logging/logger.js";

test("createLogger writes debug logs to file when console level is silent", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sage-logger-test-"));
  const logFilePath = path.join(tempDir, "sage.log");
  const logger = createLogger({
    logging: {
      level: "info",
      pretty: false,
      consoleLevel: "silent",
      fileLevel: "debug",
      filePath: logFilePath,
      fileEnabled: true,
    },
  });

  logger.info({ authorization: "Bearer top-secret" }, "info message");
  logger.debug({ openaiApiKey: "super-secret" }, "debug message");

  await new Promise((resolve) => logger.flush(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const fileContents = await fs.readFile(logFilePath, "utf8");
  assert.match(fileContents, /info message/);
  assert.match(fileContents, /debug message/);
  assert.doesNotMatch(fileContents, /top-secret/);
  assert.doesNotMatch(fileContents, /super-secret/);
  assert.match(fileContents, /\[Redacted\]/);
});
