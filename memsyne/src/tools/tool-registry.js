import { createAddMemoryHandler, addMemoryTool } from "./builtin/add-memory.js";
import { createGetMemoriesHandler, getMemoriesTool } from "./builtin/get-memories.js";
import {
  createGetUrlContentHandler,
  getUrlContentTool,
} from "./builtin/get-url-content.js";
import { createWebSearchHandler, webSearchTool } from "./builtin/web-search.js";

function createToolRegistry({ config, logger, memoryService, mcpClientManager }) {
  const registryLogger = logger.child({ component: "tool-registry" });
  const builtInTools = new Map();

  builtInTools.set(getMemoriesTool.function.name, {
    definition: getMemoriesTool,
    handler: createGetMemoriesHandler({ memoryService }),
  });
  builtInTools.set(addMemoryTool.function.name, {
    definition: addMemoryTool,
    handler: createAddMemoryHandler({ config, memoryService }),
  });

  if (config.tools.web?.enabled) {
    builtInTools.set(webSearchTool.function.name, {
      definition: webSearchTool,
      handler: createWebSearchHandler({ config }),
    });
    builtInTools.set(getUrlContentTool.function.name, {
      definition: getUrlContentTool,
      handler: createGetUrlContentHandler({ config }),
    });
  }

  function getExecutionContext({ clientTools = [], logger: requestLogger }) {
    const operationLogger = requestLogger || registryLogger;
    if (!config.tools.enabled) {
      return {
        tools: [],
        handlers: new Map(),
      };
    }

    const handlers = new Map();
    const effectiveTools = [];

    for (const [name, entry] of builtInTools.entries()) {
      effectiveTools.push(entry.definition);
      handlers.set(name, {
        handler: entry.handler,
        source: "builtin",
      });
    }

    const mcpTools = mcpClientManager.getToolDefinitions();
    for (const tool of mcpTools) {
      const name = tool?.function?.name;
      if (!name) {
        continue;
      }

      effectiveTools.push(tool);
      handlers.set(name, {
        source: "mcp",
        handler: async ({ args, logger }) => mcpClientManager.invoke(name, args, { logger }),
      });
    }

    for (const tool of clientTools) {
      const name = tool?.function?.name;
      if (!name) {
        continue;
      }

      if (builtInTools.has(name)) {
        operationLogger.debug({ toolName: name }, "Ignored client tool due to built-in name conflict");
        continue;
      }

      if (!handlers.has(name)) {
        effectiveTools.push(tool);
      }
    }

    operationLogger.debug(
      {
        builtinToolCount: builtInTools.size,
        mcpToolCount: mcpTools.length,
        clientToolCount: Array.isArray(clientTools) ? clientTools.length : 0,
        effectiveToolCount: effectiveTools.length,
      },
      "Prepared effective tool registry for request"
    );

    return {
      tools: effectiveTools,
      handlers,
    };
  }

  return {
    getExecutionContext,
  };
}

export { createToolRegistry };
