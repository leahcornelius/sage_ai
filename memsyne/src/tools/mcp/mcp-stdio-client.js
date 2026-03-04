import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function createMcpStdioClient({ server, timeoutMs, logger }) {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: server.cwd || undefined,
    env: {
      ...process.env,
      ...server.env,
    },
  });

  const client = new Client(
    {
      name: "sage-mcp-client",
      version: "0.1.0",
    },
    {
      capabilities: {},
    }
  );

  transport.onerror = (error) => {
    logger.warn(
      {
        err: error,
        serverName: server.name,
      },
      "MCP stdio transport emitted an error"
    );
  };

  transport.onclose = () => {
    logger.warn(
      {
        serverName: server.name,
      },
      "MCP stdio transport closed"
    );
  };

  async function connect() {
    await withTimeout(() => client.connect(transport), timeoutMs);
    logger.debug(
      {
        serverName: server.name,
        transport: "stdio",
        pid: transport.pid,
        command: server.command,
        args: server.args,
      },
      "Connected stdio MCP transport"
    );
  }

  async function listTools() {
    const result = await withTimeout(() => client.listTools(), timeoutMs);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async function callTool(toolName, argumentsObject) {
    return withTimeout(
      () =>
        client.callTool({
          name: toolName,
          arguments: argumentsObject || {},
        }),
      timeoutMs
    );
  }

  async function close() {
    const errors = [];
    try {
      await client.close();
    } catch (error) {
      errors.push(error);
    }

    try {
      await transport.close();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      throw errors[0];
    }
  }

  return {
    connect,
    listTools,
    callTool,
    close,
  };
}

async function withTimeout(task, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      task(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`MCP stdio operation exceeded timeout (${timeoutMs}ms).`);
          error.code = "mcp_timeout";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export { createMcpStdioClient };
