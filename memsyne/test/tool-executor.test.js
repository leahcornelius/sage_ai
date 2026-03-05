import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { createToolExecutor } from "../src/tools/tool-executor.js";

const logger = pino({ level: "silent" });

test("tool executor returns handled=false when no handler exists", async () => {
  const executor = createToolExecutor({
    config: {
      tools: {
        timeoutMs: 1000,
        maxParallelCalls: 4,
      },
    },
    logger,
  });

  const [result] = await executor.executeToolCalls({
    toolCalls: [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "unknown_tool",
          arguments: "{}",
        },
      },
    ],
    executionContext: {
      handlers: new Map(),
    },
  });

  assert.equal(result.handled, false);
  assert.equal(result.content, null);
});

test("tool executor returns timeout error envelope for long-running handlers", async () => {
  const executor = createToolExecutor({
    config: {
      tools: {
        timeoutMs: 10,
        maxParallelCalls: 1,
      },
    },
    logger,
  });

  const [result] = await executor.executeToolCalls({
    toolCalls: [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "slow_tool",
          arguments: "{}",
        },
      },
    ],
    executionContext: {
      handlers: new Map([
        [
          "slow_tool",
          {
            handler: async () => {
              await new Promise((resolve) => setTimeout(resolve, 100));
              return { ok: true };
            },
          },
        ],
      ]),
    },
  });

  assert.equal(result.handled, true);
  assert.match(result.content, /tool_timeout/);
});

test("tool executor truncates oversized tool results and emits truncation log", async () => {
  const warnings = [];
  const captureLogger = {
    child() {
      return this;
    },
    debug() {},
    warn(payload) {
      warnings.push(payload);
    },
  };

  const executor = createToolExecutor({
    config: {
      tools: {
        timeoutMs: 1_000,
        maxParallelCalls: 1,
      },
    },
    logger: captureLogger,
  });

  const [result] = await executor.executeToolCalls({
    toolCalls: [
      {
        id: "call_oversize",
        type: "function",
        function: {
          name: "large_tool",
          arguments: "{}",
        },
      },
    ],
    executionContext: {
      handlers: new Map([
        [
          "large_tool",
          {
            handler: async () => ({
              text: "x".repeat(20_000),
            }),
          },
        ],
      ]),
    },
  });

  assert.equal(result.handled, true);
  assert.match(result.content, /tool_result_truncated/);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].toolName, "large_tool");
  assert.equal(warnings[0].toolCallId, "call_oversize");
});
