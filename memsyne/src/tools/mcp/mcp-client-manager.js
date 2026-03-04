import { AppError } from "../../errors/app-error.js";
import { mapMcpToolsToOpenAiTools, parseNamespacedToolName } from "./mcp-tool-adapter.js";

function createMcpClientManager({ config, logger }) {
  const managerLogger = logger.child({ component: "mcp-client-manager" });
  const servers = new Map();

  async function initialize() {
    for (const definition of config.tools.mcpServers) {
      const normalized = normalizeServerDefinition(definition);
      if (!normalized) {
        continue;
      }

      try {
        const tools = await listServerTools(normalized, config.tools.timeoutMs);
        servers.set(normalized.name, {
          ...normalized,
          tools,
          healthy: true,
          lastError: null,
        });
        managerLogger.info(
          {
            serverName: normalized.name,
            toolCount: tools.length,
            transport: normalized.transport,
          },
          "Connected to MCP server"
        );
      } catch (error) {
        const message = "Failed to initialize MCP server";
        if (normalized.required) {
          throw new AppError({
            statusCode: 500,
            code: "mcp_initialization_failed",
            type: "server_error",
            message: `${message}: ${normalized.name}`,
            cause: error,
          });
        }

        managerLogger.warn(
          {
            err: error,
            serverName: normalized.name,
          },
          `${message}; continuing without this server`
        );
      }
    }
  }

  function getToolDefinitions() {
    const definitions = [];
    for (const server of servers.values()) {
      definitions.push(...mapMcpToolsToOpenAiTools({ serverName: server.name, tools: server.tools }));
    }
    return definitions;
  }

  async function invoke(namespacedToolName, args, { logger: requestLogger }) {
    const operationLogger = requestLogger || managerLogger;
    const parsed = parseNamespacedToolName(namespacedToolName);
    if (!parsed) {
      throw new AppError({
        statusCode: 400,
        code: "invalid_tool_arguments",
        type: "invalid_request_error",
        message: "Invalid MCP tool name.",
      });
    }

    const server = servers.get(parsed.serverName);
    if (!server) {
      throw new AppError({
        statusCode: 404,
        code: "tool_not_found",
        type: "invalid_request_error",
        message: `MCP server \"${parsed.serverName}\" is not available.`,
      });
    }

    operationLogger.debug(
      {
        serverName: server.name,
        toolName: parsed.toolName,
      },
      "Invoking MCP tool"
    );

    const response = await callServerTool({
      server,
      toolName: parsed.toolName,
      argumentsObject: args,
      timeoutMs: config.tools.timeoutMs,
    });

    return response;
  }

  return {
    initialize,
    getToolDefinitions,
    invoke,
  };
}

function normalizeServerDefinition(server) {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    return null;
  }

  const name = typeof server.name === "string" ? server.name.trim() : "";
  const url = typeof server.url === "string" ? server.url.trim() : "";
  if (!name || !url) {
    return null;
  }

  const headers = server.headers && typeof server.headers === "object" ? server.headers : {};
  const transport = typeof server.transport === "string" ? server.transport.trim().toLowerCase() : "http";
  if (transport !== "http") {
    return null;
  }

  return {
    name,
    transport,
    url,
    headers,
    required: server.required === true,
  };
}

async function listServerTools(server, timeoutMs) {
  const response = await sendJsonRpc({
    server,
    method: "tools/list",
    params: {},
    timeoutMs,
  });
  return Array.isArray(response?.tools) ? response.tools : [];
}

async function callServerTool({ server, toolName, argumentsObject, timeoutMs }) {
  const response = await sendJsonRpc({
    server,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: argumentsObject || {},
    },
    timeoutMs,
  });

  return response;
}

async function sendJsonRpc({ server, method, params, timeoutMs }) {
  const signal = AbortSignal.timeout(timeoutMs);
  const requestId = cryptoRandomId();
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...server.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`MCP server returned HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (payload?.error) {
    throw new Error(payload.error.message || "MCP server returned an error.");
  }

  return payload?.result || {};
}

function cryptoRandomId() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

export { createMcpClientManager };
