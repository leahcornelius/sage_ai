import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLogger } from "../src/logging/logger.js";

async function readFileWithRetry(filePath, attempts = 20, delayMs = 25) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT" || attempt === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`Unable to read ${filePath}`);
}

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

  const fileContents = await readFileWithRetry(logFilePath);
  assert.match(fileContents, /info message/);
  assert.match(fileContents, /debug message/);
  assert.doesNotMatch(fileContents, /top-secret/);
  assert.doesNotMatch(fileContents, /super-secret/);
  assert.match(fileContents, /\[Redacted\]/);
});
