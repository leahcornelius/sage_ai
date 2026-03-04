function createMcpHttpClient({ server, timeoutMs }) {
  async function connect() {
    // HTTP MCP uses request/response; no persistent connection handshake needed.
  }

  async function listTools() {
    const response = await sendJsonRpc({
      server,
      method: "tools/list",
      params: {},
      timeoutMs,
    });
    return Array.isArray(response?.tools) ? response.tools : [];
  }

  async function callTool(toolName, argumentsObject) {
    return sendJsonRpc({
      server,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: argumentsObject || {},
      },
      timeoutMs,
    });
  }

  async function close() {
    // no-op for HTTP transport
  }

  return {
    connect,
    listTools,
    callTool,
    close,
  };
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

export { createMcpHttpClient };
