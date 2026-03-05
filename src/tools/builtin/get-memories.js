import { AppError } from "../../errors/app-error.js";

const getMemoriesTool = {
  type: "function",
  function: {
    name: "get_memories",
    description: "Retrieve relevant long-term memories related to a query.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Memory lookup query.",
        },
        top_k: {
          type: "integer",
          description: "Maximum number of memory results to return.",
          minimum: 1,
          maximum: 20,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

function createGetMemoriesHandler({ memoryService }) {
  return async function handleGetMemories({ args, logger }) {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      throw new AppError({
        statusCode: 400,
        code: "invalid_tool_arguments",
        type: "invalid_request_error",
        message: "get_memories requires a non-empty query string.",
      });
    }

    const parsedTopK = Number.parseInt(args.top_k, 10);
    const topK =
      Number.isInteger(parsedTopK) && parsedTopK >= 1 && parsedTopK <= 20 ? parsedTopK : undefined;

    const memories = await memoryService.getMemoriesForTool({
      query,
      topK,
      logger,
    });

    return {
      query,
      count: memories.length,
      memories,
    };
  };
}

export { getMemoriesTool, createGetMemoriesHandler };
