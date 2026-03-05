import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { createMcpClientManager, normalizeServerDefinition } from "../src/tools/mcp/mcp-client-manager.js";

const logger = pino({ level: "silent" });

test("normalizeServerDefinition accepts valid http and stdio entries", () => {
  const http = normalizeServerDefinition({
    name: "web",
    transport: "http",
    url: "https://mcp.example.com",
    required: true,
  });
  assert.equal(http.transport, "http");
  assert.equal(http.url, "https://mcp.example.com");
  assert.equal(http.required, true);

  const stdio = normalizeServerDefinition({
    name: "brave",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: { BRAVE_API_KEY: "x" },
  });
  assert.equal(stdio.transport, "stdio");
  assert.equal(stdio.command, "npx");
  assert.deepEqual(stdio.args, ["-y", "@modelcontextprotocol/server-brave-search"]);
  assert.equal(stdio.env.BRAVE_API_KEY, "x");
});

test("normalizeServerDefinition rejects malformed stdio entry", () => {
  assert.throws(
    () =>
      normalizeServerDefinition({
        name: "broken",
        transport: "stdio",
      }),
    /command/
  );
});

test("mcp manager ignores optional server initialization failures", async () => {
  const manager = createMcpClientManager({
    config: {
      tools: {
        timeoutMs: 1000,
        mcpServers: [
          {
            name: "broken",
            transport: "stdio",
            command: "missing-command",
            required: false,
          },
        ],
      },
    },
    logger,
    stdioClientFactory: () => ({
      connect: async () => {
        throw new Error("spawn failed");
      },
      listTools: async () => [],
      callTool: async () => ({}),
      close: async () => {},
    }),
  });

  await manager.initialize();
  assert.deepEqual(manager.getToolDefinitions(), []);
});

test("mcp manager throws when required server initialization fails", async () => {
  const manager = createMcpClientManager({
    config: {
      tools: {
        timeoutMs: 1000,
        mcpServers: [
          {
            name: "required-server",
            transport: "stdio",
            command: "missing-command",
            required: true,
          },
        ],
      },
    },
    logger,
    stdioClientFactory: () => ({
      connect: async () => {
        throw new Error("spawn failed");
      },
      listTools: async () => [],
      callTool: async () => ({}),
      close: async () => {},
    }),
  });

  await assert.rejects(
    () => manager.initialize(),
    (error) => error?.code === "mcp_initialization_failed"
  );
});

test("mcp manager supports mixed http and stdio transports and routes invoke", async () => {
  const calls = [];
  const manager = createMcpClientManager({
    config: {
      tools: {
        timeoutMs: 1000,
        mcpServers: [
          {
            name: "http1",
            transport: "http",
            url: "https://mcp-http.example.com",
            required: false,
          },
          {
            name: "stdio1",
            transport: "stdio",
            command: "node",
            args: ["server.js"],
            required: false,
          },
        ],
      },
    },
    logger,
    httpClientFactory: () => ({
      connect: async () => {},
      listTools: async () => [{ name: "search", inputSchema: { type: "object" } }],
      callTool: async (name, args) => {
        calls.push({ transport: "http", name, args });
        return { ok: true, transport: "http" };
      },
      close: async () => {},
    }),
    stdioClientFactory: () => ({
      connect: async () => {},
      listTools: async () => [{ name: "lookup", inputSchema: { type: "object" } }],
      callTool: async (name, args) => {
        calls.push({ transport: "stdio", name, args });
        return { ok: true, transport: "stdio" };
      },
      close: async () => {},
    }),
  });

  await manager.initialize();
  const toolDefs = manager.getToolDefinitions();
  assert.ok(toolDefs.some((tool) => tool.function.name === "mcp.http1.search"));
  assert.ok(toolDefs.some((tool) => tool.function.name === "mcp.stdio1.lookup"));

  const result = await manager.invoke("mcp.stdio1.lookup", { query: "x" }, { logger });
  assert.equal(result.transport, "stdio");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "lookup");
});

test("mcp manager closes transport clients", async () => {
  let closed = 0;
  const manager = createMcpClientManager({
    config: {
      tools: {
        timeoutMs: 1000,
        mcpServers: [
          {
            name: "stdio1",
            transport: "stdio",
            command: "node",
            required: false,
          },
        ],
      },
    },
    logger,
    stdioClientFactory: () => ({
      connect: async () => {},
      listTools: async () => [],
      callTool: async () => ({}),
      close: async () => {
        closed += 1;
      },
    }),
  });

  await manager.initialize();
  await manager.close();
  assert.equal(closed, 1);
});
