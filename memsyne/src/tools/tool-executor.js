import { excerptText, textLength } from "../logging/safe-debug.js";

const TOOL_RESULT_MAX_BYTES = 8_000;

function createToolExecutor({ config, logger }) {
  const executorLogger = logger.child({ component: "tool-executor" });

  async function executeToolCalls({ toolCalls, executionContext, requestLogger }) {
    const operationLogger = requestLogger || executorLogger;
    const maxParallelCalls = config.tools.maxParallelCalls;
    const concurrencyLimit = Math.max(1, Math.min(maxParallelCalls, toolCalls.length || 1));

    const results = new Array(toolCalls.length);
    let cursor = 0;
    const workers = Array.from({ length: concurrencyLimit }, async () => {
      while (cursor < toolCalls.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await executeOneToolCall({
          toolCall: toolCalls[index],
          executionContext,
          logger: operationLogger,
        });
      }
    });

    await Promise.all(workers);
    return results;
  }

  async function executeOneToolCall({ toolCall, executionContext, logger: operationLogger }) {
    const toolName = toolCall?.function?.name || "";
    const toolCallId = toolCall?.id || "";
    const toolDefinition = executionContext.handlers.get(toolName);

    if (!toolDefinition) {
      operationLogger.debug(
        {
          toolCallId,
          toolName,
        },
        "Tool call returned to caller because no server-side handler exists"
      );
      return {
        toolCallId,
        toolName,
        handled: false,
        content: null,
      };
    }

    let parsedArgs;
    try {
      parsedArgs = parseToolArguments(toolCall?.function?.arguments);
    } catch (error) {
      return {
        toolCallId,
        toolName,
        handled: true,
        content: stringifyToolResult({
          ok: false,
          error: {
            code: "invalid_tool_arguments",
            message: error.message,
          },
        }, {
          logger: operationLogger,
          toolName,
          toolCallId,
        }),
      };
    }

    try {
      operationLogger.debug(
        {
          toolCallId,
          toolName,
          argumentKeys: Object.keys(parsedArgs),
          argumentLength: textLength(toolCall?.function?.arguments || ""),
        },
        "Executing server-side tool call"
      );

      const data = await runWithTimeout(
        () => toolDefinition.handler({ args: parsedArgs, toolCall, logger: operationLogger }),
        config.tools.timeoutMs
      );

      return {
        toolCallId,
        toolName,
        handled: true,
        content: stringifyToolResult({
          ok: true,
          data,
        }, {
          logger: operationLogger,
          toolName,
          toolCallId,
        }),
      };
    } catch (error) {
      operationLogger.warn(
        {
          err: error,
          toolCallId,
          toolName,
        },
        "Tool call failed"
      );
      return {
        toolCallId,
        toolName,
        handled: true,
        content: stringifyToolResult({
          ok: false,
          error: {
            code: error?.code || "tool_execution_failed",
            message: error?.message || "Tool execution failed.",
          },
        }, {
          logger: operationLogger,
          toolName,
          toolCallId,
        }),
      };
    }
  }

  return {
    executeToolCalls,
  };
}

function parseToolArguments(rawArguments) {
  if (rawArguments === undefined || rawArguments === null || rawArguments === "") {
    return {};
  }

  if (typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
    return rawArguments;
  }

  if (typeof rawArguments !== "string") {
    throw new Error("Tool arguments must be a JSON object.");
  }

  let parsed;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new Error("Tool arguments must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return parsed;
}

async function runWithTimeout(callback, timeoutMs) {
  const timeoutError = new Error(`Tool execution exceeded ${timeoutMs}ms timeout.`);
  timeoutError.code = "tool_timeout";

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });

  try {
    return await Promise.race([callback(), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

function stringifyToolResult(result, { logger, toolName, toolCallId } = {}) {
  const raw = JSON.stringify(result);
  if (raw.length <= TOOL_RESULT_MAX_BYTES) {
    return raw;
  }

  logger?.warn(
    {
      toolName,
      toolCallId,
      resultBytes: Buffer.byteLength(raw, "utf8"),
      resultCharLength: raw.length,
      maxBytes: TOOL_RESULT_MAX_BYTES,
    },
    "Tool result exceeded executor cap and was truncated"
  );

  return JSON.stringify({
    ok: false,
    error: {
      code: "tool_result_truncated",
      message: `Tool result exceeded ${TOOL_RESULT_MAX_BYTES} bytes and was truncated. Preview: ${excerptText(raw, 500)}`,
    },
  });
}

export { createToolExecutor };
