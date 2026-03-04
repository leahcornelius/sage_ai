import { AppError } from "../../errors/app-error.js";

const SUPPORTED_ROLES = new Set(["system", "developer", "user", "assistant"]);

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

  if (message.tool_calls || message.function_call || message.audio) {
    throw unsupportedFeatureError(`messages[${index}]`, "Tool and audio message content is not supported.");
  }

  const role = typeof message.role === "string" ? message.role.trim() : "";
  if (role === "tool") {
    throw unsupportedFeatureError(`messages[${index}].role`, "Tool role messages are not supported.");
  }

  if (!SUPPORTED_ROLES.has(role)) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: `messages[${index}].role must be one of system, developer, user, or assistant.`,
      param: `messages[${index}].role`,
    });
  }

  const content = normalizeMessageContent(message.content, index);
  const normalized = {
    role,
    content,
  };

  if (typeof message.name === "string" && message.name.trim()) {
    normalized.name = message.name.trim();
  }

  return normalized;
}

function normalizeMessageContent(content, index) {
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
