import { AppError } from "../../errors/app-error.js";
import { getLastUserMessageContent, normalizeMessages } from "./messages.js";

const UNSUPPORTED_REQUEST_FIELDS = ["tools", "tool_choice", "functions", "function_call"];
const PASSTHROUGH_FIELDS = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "user",
];

function validateChatCompletionsRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: "Request body must be a JSON object.",
    });
  }

  for (const field of UNSUPPORTED_REQUEST_FIELDS) {
    if (body[field] !== undefined) {
      throw new AppError({
        statusCode: 400,
        code: "unsupported_feature",
        type: "invalid_request_error",
        message: `${field} is not supported in V1.`,
        param: field,
      });
    }
  }

  if (body.n !== undefined && body.n !== 1) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: "Only n=1 is supported in V1.",
      param: "n",
    });
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: "model is required.",
      param: "model",
    });
  }

  const messages = normalizeMessages(body.messages);
  const stream = body.stream === true;
  const upstreamOptions = pickDefinedFields(body, PASSTHROUGH_FIELDS);
  if (stream && body.stream_options !== undefined) {
    upstreamOptions.stream_options = body.stream_options;
  }

  return {
    model,
    messages,
    stream,
    upstreamOptions,
    lastUserMessage: getLastUserMessageContent(messages),
  };
}

function pickDefinedFields(source, fieldNames) {
  return fieldNames.reduce((result, fieldName) => {
    if (source[fieldName] !== undefined) {
      result[fieldName] = source[fieldName];
    }
    return result;
  }, {});
}

export { validateChatCompletionsRequest };
