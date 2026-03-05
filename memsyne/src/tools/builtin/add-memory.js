import { AppError } from "../../errors/app-error.js";

const addMemoryTool = {
  type: "function",
  function: {
    name: "add_memory",
    description: "Store a long-term memory for future recall.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Memory text to store.",
        },
        importance: {
          type: "integer",
          description: "Memory importance score from 1 to 10. Persisted scale is normalized to 0..1.",
          minimum: 1,
          maximum: 10,
        },
        category: {
          type: "string",
          description: "Optional memory category.",
        },
        event_time: {
          type: "string",
          description: "Optional event timestamp in ISO format.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

function createAddMemoryHandler({ config, memoryService }) {
  return async function handleAddMemory({ args, logger }) {
    if (!config.tools.memoryWriteEnabled) {
      throw new AppError({
        statusCode: 403,
        code: "memory_write_disabled",
        type: "invalid_request_error",
        message: "The add_memory tool is disabled by server configuration.",
      });
    }

    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text || text.length > 2_000) {
      throw new AppError({
        statusCode: 400,
        code: "invalid_tool_arguments",
        type: "invalid_request_error",
        message: "add_memory requires text with length between 1 and 2000 characters.",
      });
    }

    const parsedImportance = Number.parseInt(args.importance, 10);
    const importance =
      args.importance === undefined || args.importance === null || args.importance === ""
        ? null
        : Number.isInteger(parsedImportance) && parsedImportance >= 1 && parsedImportance <= 10
          ? parsedImportance
          : null;

    if (
      args.importance !== undefined &&
      args.importance !== null &&
      args.importance !== "" &&
      importance === null
    ) {
      throw new AppError({
        statusCode: 400,
        code: "invalid_tool_arguments",
        type: "invalid_request_error",
        message: "add_memory importance must be an integer from 1 to 10.",
      });
    }

    const category =
      typeof args.category === "string" && args.category.trim() ? args.category.trim() : null;
    if (category && category.length > 100) {
      throw new AppError({
        statusCode: 400,
        code: "invalid_tool_arguments",
        type: "invalid_request_error",
        message: "add_memory category cannot exceed 100 characters.",
      });
    }

    const eventTime =
      typeof args.event_time === "string" && args.event_time.trim() ? args.event_time.trim() : null;
    if (eventTime && Number.isNaN(new Date(eventTime).getTime())) {
      throw new AppError({
        statusCode: 400,
        code: "invalid_tool_arguments",
        type: "invalid_request_error",
        message: "add_memory event_time must be a valid ISO timestamp.",
      });
    }

    const result = await memoryService.addMemoryFromTool({
      text,
      importance,
      category,
      eventTime,
      logger,
    });

    return {
      stored: true,
      memory: result,
    };
  };
}

export { addMemoryTool, createAddMemoryHandler };
