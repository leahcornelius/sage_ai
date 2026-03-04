import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { createToolRegistry } from "../src/tools/tool-registry.js";

const logger = pino({ level: "silent" });

test("tool registry keeps built-in tool when client defines a conflicting name", () => {
  const registry = createToolRegistry({
    config: {
      tools: {
        enabled: true,
        memoryWriteEnabled: true,
        webSearch: {
          enabled: false,
        },
      },
    },
    logger,
    memoryService: {
      getMemoriesForTool: async () => [],
      addMemoryFromTool: async () => ({}),
    },
    mcpClientManager: {
      getToolDefinitions: () => [],
      invoke: async () => ({}),
    },
  });

  const context = registry.getExecutionContext({
    clientTools: [
      {
        type: "function",
        function: {
          name: "get_memories",
          description: "client override attempt",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });

  const matchingTools = context.tools.filter((tool) => tool.function.name === "get_memories");
  assert.equal(matchingTools.length, 1);
});

test("tool registry includes namespaced MCP tools", () => {
  const registry = createToolRegistry({
    config: {
      tools: {
        enabled: true,
        memoryWriteEnabled: true,
        webSearch: {
          enabled: false,
        },
      },
    },
    logger,
    memoryService: {
      getMemoriesForTool: async () => [],
      addMemoryFromTool: async () => ({}),
    },
    mcpClientManager: {
      getToolDefinitions: () => [
        {
          type: "function",
          function: {
            name: "mcp.web.search",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      invoke: async () => ({ ok: true }),
    },
  });

  const context = registry.getExecutionContext({
    clientTools: [],
  });

  assert.ok(context.tools.some((tool) => tool.function.name === "mcp.web.search"));
  assert.ok(context.handlers.has("mcp.web.search"));
});
