import { AppError } from "../../errors/app-error.js";

const SUPPORTED_ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: "messages must be a non-empty array.",
      param: "messages",
    });
  }

  return messages.map((message, index) => normalizeMessage(message, index));
}

function normalizeMessage(message, index) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: `messages[${index}] must be an object.`,
      param: `messages[${index}]`,
    });
  }

  if (message.function_call || message.audio) {
    throw unsupportedFeatureError(`messages[${index}]`, "Audio and function_call message content is not supported.");
  }

  const role = typeof message.role === "string" ? message.role.trim() : "";
  if (!SUPPORTED_ROLES.has(role)) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: `messages[${index}].role must be one of system, developer, user, assistant, or tool.`,
      param: `messages[${index}].role`,
    });
  }

  const toolCalls = normalizeToolCalls(message.tool_calls, index, role);
  const content = normalizeMessageContent({
    content: message.content,
    index,
    role,
    hasToolCalls: toolCalls.length > 0,
  });
  const normalized = {
    role,
    content,
  };
  if (toolCalls.length > 0) {
    normalized.tool_calls = toolCalls;
  }

  if (role === "tool") {
    const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id.trim() : "";
    if (!toolCallId) {
      throw new AppError({
        statusCode: 400,
        code: "invalid_request_error",
        type: "invalid_request_error",
        message: `messages[${index}].tool_call_id is required when role is \"tool\".`,
        param: `messages[${index}].tool_call_id`,
      });
    }
    normalized.tool_call_id = toolCallId;
  } else if (message.tool_call_id !== undefined) {
    throw unsupportedFeatureError(
      `messages[${index}].tool_call_id`,
      "tool_call_id is only supported for tool role messages."
    );
  }

  if (typeof message.name === "string" && message.name.trim()) {
    normalized.name = message.name.trim();
  }

  return normalized;
}

function normalizeMessageContent({ content, index, role, hasToolCalls }) {
  if (content === null && role === "assistant" && hasToolCalls) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part, partIndex) => normalizeTextPart(part, index, partIndex)).join("");
  }

  throw new AppError({
    statusCode: 400,
    code: "invalid_request_error",
    type: "invalid_request_error",
    message: `messages[${index}].content must be a string or an array of text parts.`,
    param: `messages[${index}].content`,
  });
}

function normalizeToolCalls(value, messageIndex, role) {
  if (value === undefined || value === null) {
    return [];
  }

  if (role !== "assistant") {
    throw unsupportedFeatureError(
      `messages[${messageIndex}].tool_calls`,
      "tool_calls are only supported for assistant role messages."
    );
  }

  if (!Array.isArray(value)) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: `messages[${messageIndex}].tool_calls must be an array.`,
      param: `messages[${messageIndex}].tool_calls`,
    });
  }

  return value.map((toolCall, callIndex) => normalizeToolCall(toolCall, messageIndex, callIndex));
}

function normalizeToolCall(toolCall, messageIndex, callIndex) {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: `messages[${messageIndex}].tool_calls[${callIndex}] must be an object.`,
      param: `messages[${messageIndex}].tool_calls[${callIndex}]`,
    });
  }

  const id = typeof toolCall.id === "string" ? toolCall.id.trim() : "";
  const type = typeof toolCall.type === "string" ? toolCall.type.trim() : "";
  const functionName = typeof toolCall?.function?.name === "string" ? toolCall.function.name.trim() : "";

  if (!id || !type || type !== "function" || !functionName) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: `messages[${messageIndex}].tool_calls[${callIndex}] must include id, type=\"function\", and function.name.`,
      param: `messages[${messageIndex}].tool_calls[${callIndex}]`,
    });
  }

  const argumentsValue =
    typeof toolCall.function.arguments === "string"
      ? toolCall.function.arguments
      : JSON.stringify(toolCall.function.arguments || {});

  return {
    id,
    type: "function",
    function: {
      name: functionName,
      arguments: argumentsValue,
    },
  };
}

function normalizeTextPart(part, messageIndex, partIndex) {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: `messages[${messageIndex}].content[${partIndex}] must be an object.`,
      param: `messages[${messageIndex}].content[${partIndex}]`,
    });
  }

  if (part.type !== "text") {
    throw unsupportedFeatureError(
      `messages[${messageIndex}].content[${partIndex}]`,
      "Only text content parts are supported in V1."
    );
  }

  if (typeof part.text !== "string") {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: `messages[${messageIndex}].content[${partIndex}].text must be a string.`,
      param: `messages[${messageIndex}].content[${partIndex}].text`,
    });
  }

  return part.text;
}

function getLastUserMessageContent(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return messages[index].content;
    }
  }

  return "";
}

function unsupportedFeatureError(param, message) {
  return new AppError({
    statusCode: 400,
    code: "unsupported_feature",
    type: "invalid_request_error",
    message,
    param,
  });
}

export { getLastUserMessageContent, normalizeMessages };
