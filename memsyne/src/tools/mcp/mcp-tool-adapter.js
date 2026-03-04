function mapMcpToolsToOpenAiTools({ serverName, tools }) {
  return tools
    .filter((tool) => tool && typeof tool === "object")
    .map((tool) => {
      const sourceName = String(tool.name || "").trim();
      if (!sourceName) {
        return null;
      }

      return {
        type: "function",
        function: {
          name: toNamespacedToolName(serverName, sourceName),
          description: typeof tool.description === "string" ? tool.description : undefined,
          parameters:
            tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
              ? tool.inputSchema
              : { type: "object", properties: {} },
        },
      };
    })
    .filter(Boolean);
}

function toNamespacedToolName(serverName, toolName) {
  return `mcp.${sanitizeName(serverName)}.${sanitizeName(toolName)}`;
}

function parseNamespacedToolName(namespaced) {
  if (typeof namespaced !== "string") {
    return null;
  }
  const parts = namespaced.split(".");
  if (parts.length < 3 || parts[0] !== "mcp") {
    return null;
  }

  return {
    serverName: parts[1],
    toolName: parts.slice(2).join("."),
  };
}

function sanitizeName(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export { mapMcpToolsToOpenAiTools, parseNamespacedToolName, toNamespacedToolName };
