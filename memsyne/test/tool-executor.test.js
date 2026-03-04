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
