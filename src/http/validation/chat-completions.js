import { AppError } from "../../errors/app-error.js";
import { getLastUserMessageContent, normalizeMessages } from "./messages.js";

const UNSUPPORTED_REQUEST_FIELDS = ["functions", "function_call"];
const PASSTHROUGH_FIELDS = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "reasoning_effort",
  "reasoning",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "user",
];

function validateChatCompletionsRequest(body, { config, headers } = {}) {
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

  const model = resolveEffectiveModel({ body, config });

  const messages = normalizeMessages(body.messages);
  const stream = body.stream === true;
  const upstreamOptions = pickDefinedFields(body, PASSTHROUGH_FIELDS);
  normalizeReasoningControls(upstreamOptions);
  if (stream && body.stream_options !== undefined) {
    upstreamOptions.stream_options = body.stream_options;
  }
  const tools = normalizeTools(body.tools);
  const toolChoice = normalizeToolChoice(body.tool_choice);
  const chatId = normalizeChatId(headers);

  return {
    model,
    messages,
    stream,
    chatId,
    user: normalizeUserIdentifier(body.user),
    upstreamOptions,
    tools,
    toolChoice,
    lastUserMessage: getLastUserMessageContent(messages),
    // Read-only answer mode (benchmark checkpoint): when set, the request retrieves
    // memory context as usual but does NOT write the user turn or schedule assistant
    // ingestion into the scope — so a scored scope is never contaminated by the
    // checkpoint's own generated answers. Header-only (not part of the OpenAI body).
    skipMemoryWrite: isTruthyHeader(headers?.["x-sage-skip-memory-write"]),
  };
}

function isTruthyHeader(value) {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeUserIdentifier(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function pickDefinedFields(source, fieldNames) {
  return fieldNames.reduce((result, fieldName) => {
    if (source[fieldName] !== undefined) {
      result[fieldName] = source[fieldName];
    }
    return result;
  }, {});
}

function normalizeTools(value) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: "tools must be an array.",
      param: "tools",
    });
  }

  return value.map((tool, index) => normalizeTool(tool, index));
}

function normalizeTool(tool, index) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: `tools[${index}] must be an object.`,
      param: `tools[${index}]`,
    });
  }

  if (tool.type !== "function") {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: `tools[${index}].type must be \"function\".`,
      param: `tools[${index}].type`,
    });
  }

  const functionName = typeof tool.function?.name === "string" ? tool.function.name.trim() : "";
  if (!functionName || !/^[A-Za-z0-9._-]{1,128}$/.test(functionName)) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: `tools[${index}].function.name is invalid.`,
      param: `tools[${index}].function.name`,
    });
  }

  const normalized = {
    type: "function",
    function: {
      name: functionName,
      description:
        typeof tool.function?.description === "string" && tool.function.description.trim()
          ? tool.function.description.trim()
          : undefined,
      parameters:
        tool.function?.parameters && typeof tool.function.parameters === "object" && !Array.isArray(tool.function.parameters)
          ? tool.function.parameters
          : { type: "object", properties: {} },
    },
  };

  return normalized;
}

function normalizeToolChoice(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    if (["none", "auto", "required"].includes(value)) {
      return value;
    }

    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: "tool_choice must be one of none, auto, required, or a function selection object.",
      param: "tool_choice",
    });
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: "tool_choice must be one of none, auto, required, or a function selection object.",
      param: "tool_choice",
    });
  }

  const type = typeof value.type === "string" ? value.type.trim() : "";
  const functionName = typeof value.function?.name === "string" ? value.function.name.trim() : "";
  if (type !== "function" || !functionName) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: "tool_choice function selection must include type=\"function\" and function.name.",
      param: "tool_choice",
    });
  }

  return {
    type: "function",
    function: {
      name: functionName,
    },
  };
}

function normalizeChatId(headers) {
  const openWebUiChatId =
    typeof headers?.["x-openwebui-chat-id"] === "string"
      ? headers["x-openwebui-chat-id"].trim()
      : "";
  const conversationIdHeader =
    typeof headers?.["x-conversation-id"] === "string"
      ? headers["x-conversation-id"].trim()
      : "";

  if (openWebUiChatId && conversationIdHeader && openWebUiChatId !== conversationIdHeader) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message:
        "X-OpenWebUI-Chat-Id and X-Conversation-ID headers must match when both are provided.",
      param: "x-openwebui-chat-id",
    });
  }

  const chatId = openWebUiChatId || conversationIdHeader;

  if (!chatId) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message:
        "One of X-OpenWebUI-Chat-Id or X-Conversation-ID headers is required.",
      param: "x-openwebui-chat-id",
    });
  }

  return chatId;
}

function normalizeReasoningControls(upstreamOptions) {
  if (upstreamOptions.reasoning_effort === "none") {
    delete upstreamOptions.reasoning_effort;
  }

  if (
    upstreamOptions.reasoning &&
    typeof upstreamOptions.reasoning === "object" &&
    !Array.isArray(upstreamOptions.reasoning) &&
    upstreamOptions.reasoning.effort === "none"
  ) {
    delete upstreamOptions.reasoning;
  }
}

function resolveEffectiveModel({ body, config }) {
  const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
  const defaultModel =
    typeof config?.openai?.defaultModel === "string" ? config.openai.defaultModel.trim() : "";
  const allowModelOverride =
    typeof config?.openai?.allowModelOverride === "boolean"
      ? config.openai.allowModelOverride
      : true;

  if (requestedModel && defaultModel && !allowModelOverride && requestedModel !== defaultModel) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: "Model override is disabled by server configuration.",
      param: "model",
    });
  }

  const resolvedModel = requestedModel || defaultModel;
  if (!resolvedModel) {
    throw new AppError({
      statusCode: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: "model is required.",
      param: "model",
    });
  }

  return resolvedModel;
}

export { validateChatCompletionsRequest };
