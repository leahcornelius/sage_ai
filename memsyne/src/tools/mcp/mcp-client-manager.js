import { AppError } from "../../errors/app-error.js";
import { mapMcpToolsToOpenAiTools, parseNamespacedToolName } from "./mcp-tool-adapter.js";
import { createMcpHttpClient } from "./mcp-http-client.js";
import { createMcpStdioClient } from "./mcp-stdio-client.js";

function createMcpClientManager({
  config,
  logger,
  httpClientFactory = createMcpHttpClient,
  stdioClientFactory = createMcpStdioClient,
}) {
  const managerLogger = logger.child({ component: "mcp-client-manager" });
  const servers = new Map();

  async function initialize() {
    for (const definition of config.tools.mcpServers) {
      let normalized;
      try {
        normalized = normalizeServerDefinition(definition);
      } catch (error) {
        throw new AppError({
          statusCode: 500,
          code: "config_error",
          type: "server_error",
          message: "Invalid SAGE_MCP_SERVERS_JSON entry.",
          cause: error,
        });
      }

      const transportClient = createTransportClient({
        normalized,
        timeoutMs: config.tools.timeoutMs,
        managerLogger,
        httpClientFactory,
        stdioClientFactory,
      });

      try {
        await transportClient.connect();
        const tools = await transportClient.listTools();

        servers.set(normalized.name, {
          ...normalized,
          transportClient,
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
            transport: normalized.transport,
          },
          `${message}; continuing without this server`
        );

        await safeCloseTransport({
          transportClient,
          managerLogger,
          serverName: normalized.name,
        });
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
        transport: server.transport,
      },
      "Invoking MCP tool"
    );

    return server.transportClient.callTool(parsed.toolName, args);
  }

  async function close() {
    for (const server of servers.values()) {
      await safeCloseTransport({
        transportClient: server.transportClient,
        managerLogger,
        serverName: server.name,
      });
    }
    servers.clear();
  }

  return {
    initialize,
    getToolDefinitions,
    invoke,
    close,
  };
}

function createTransportClient({
  normalized,
  timeoutMs,
  managerLogger,
  httpClientFactory,
  stdioClientFactory,
}) {
  if (normalized.transport === "http") {
    return httpClientFactory({
      server: normalized,
      timeoutMs,
    });
  }

  if (normalized.transport === "stdio") {
    return stdioClientFactory({
      server: normalized,
      timeoutMs,
      logger: managerLogger,
    });
  }

  throw new Error(`Unsupported MCP transport "${normalized.transport}".`);
}

function normalizeServerDefinition(server) {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new Error("MCP server entry must be an object.");
  }

  const name = requiredTrimmedString(server.name, "name");
  const transport = requiredTrimmedString(server.transport, "transport").toLowerCase();
  const required = server.required === true;

  if (transport === "http") {
    return normalizeHttpServerDefinition(server, { name, transport, required });
  }

  if (transport === "stdio") {
    return normalizeStdioServerDefinition(server, { name, transport, required });
  }

  throw new Error("transport must be one of: http, stdio.");
}

function normalizeHttpServerDefinition(server, base) {
  const url = requiredTrimmedString(server.url, "url");
  const headers = normalizeRecordOfStrings(server.headers, "headers");
  return {
    ...base,
    url,
    headers,
  };
}

function normalizeStdioServerDefinition(server, base) {
  const command = requiredTrimmedString(server.command, "command");
  const args = normalizeStringArray(server.args, "args");
  const cwd =
    server.cwd === undefined || server.cwd === null ? null : requiredTrimmedString(server.cwd, "cwd");
  const env = normalizeRecordOfStrings(server.env, "env");

  return {
    ...base,
    command,
    args,
    cwd,
    env,
  };
}

function requiredTrimmedString(value, field) {
  if (typeof value !== "string") {
    throw new Error(`MCP server ${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`MCP server ${field} is required.`);
  }
  return trimmed;
}

function normalizeStringArray(value, field) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`MCP server ${field} must be an array of strings.`);
  }
  return value;
}

function normalizeRecordOfStrings(value, field) {
  if (value === undefined || value === null) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`MCP server ${field} must be an object.`);
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`MCP server ${field}.${key} must be a string.`);
    }
    result[key] = entry;
  }
  return result;
}

async function safeCloseTransport({ transportClient, managerLogger, serverName }) {
  if (!transportClient || typeof transportClient.close !== "function") {
    return;
  }

  try {
    await transportClient.close();
  } catch (error) {
    managerLogger.warn(
      {
        err: error,
        serverName,
      },
      "Failed to close MCP transport cleanly"
    );
  }
}

export { createMcpClientManager, normalizeServerDefinition };
