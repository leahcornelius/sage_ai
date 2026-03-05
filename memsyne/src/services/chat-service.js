import {
  extractAssistantTextFromChunk,
  extractAssistantTextFromCompletion,
} from "../http/serializers/openai-chat.js";
import { excerptText, objectKeys, textLength } from "../logging/safe-debug.js";
import { AppError } from "../errors/app-error.js";
import { createSyntheticId } from "../utils/ids.js";

/**
 * Composes Sage-specific context around standard OpenAI chat completion
 * requests while keeping the external HTTP layer stateless.
 */
function createChatService({
  openaiClient,
  memoryService,
  promptService,
  modelService,
  conversationStore,
  toolRegistry,
  toolExecutor,
  config,
  logger,
}) {
  const serviceLogger = logger.child({ service: "chat-service" });

  async function createChatCompletion({
    requestBody,
    signal,
    logger: requestLogger,
    skipMemoryExtraction = false,
  }) {
    const operationLogger = requestLogger || serviceLogger;
    await modelService.assertModelAvailable(requestBody.model, { logger: operationLogger });
    await synchronizeConversationForRequest({
      conversationStore,
      requestBody,
      logger: operationLogger,
    });

    const lastUserMessage = requestBody.lastUserMessage;
    const recalledMemories = await memoryService.recallRelevantMemories(lastUserMessage, {
      logger: operationLogger,
    });
    const upstreamRequest = buildUpstreamRequest({
      requestBody,
      promptService,
      memoryService,
      recalledMemories,
      logger: operationLogger,
    });
    const executionContext = getExecutionContext({
      requestBody,
      toolRegistry,
      logger: operationLogger,
    });
    if (executionContext.tools.length > 0) {
      upstreamRequest.tools = executionContext.tools;
    }
    if (requestBody.toolChoice) {
      upstreamRequest.tool_choice = requestBody.toolChoice;
    }
    operationLogger.debug(
      {
        model: requestBody.model,
        stream: false,
        upstreamOptionKeys: objectKeys(requestBody.upstreamOptions),
        toolCount: executionContext.tools.length,
      },
      "Dispatching upstream chat completion request"
    );

    const startedAt = Date.now();
    const completion = shouldExecuteTools({ requestBody, toolsEnabled: executionContext.tools.length > 0 })
      ? await runToolLoop({
          upstreamRequest,
          requestBody,
          executionContext,
          signal,
          operationLogger,
          openaiClient,
          toolExecutor,
          maxRounds: config.tools.maxRounds,
        })
      : await openaiClient.chat.completions.create(upstreamRequest, { signal });
    operationLogger.info(
      {
        model: requestBody.model,
        stream: false,
        upstreamLatencyMs: Date.now() - startedAt,
        recalledMemoryCount: recalledMemories.length,
      },
      "Upstream chat completion succeeded"
    );

    const assistantMessage = extractAssistantTextFromCompletion(completion);
    appendAssistantMessageToConversation({
      conversationStore,
      conversationId: requestBody.conversationId,
      assistantMessage,
      logger: operationLogger,
    });
    operationLogger.debug(
      {
        model: requestBody.model,
        stream: false,
        choiceCount: Array.isArray(completion?.choices) ? completion.choices.length : 0,
        finishReasons: Array.isArray(completion?.choices)
          ? completion.choices.map((choice) => choice?.finish_reason || null)
          : [],
        assistantMessageLength: textLength(assistantMessage),
        assistantMessageExcerpt: excerptText(assistantMessage),
      },
      "Processed upstream chat completion response"
    );
    if (!skipMemoryExtraction) {
      scheduleConversationMemoryExtraction({
        memoryService,
        conversationId: requestBody.conversationId,
        assistantMessage,
        model: requestBody.model,
        logger: operationLogger,
      });
    }

    return completion;
  }

  async function* streamChatCompletion({ requestBody, signal, logger: requestLogger }) {
    const operationLogger = requestLogger || serviceLogger;
    await modelService.assertModelAvailable(requestBody.model, { logger: operationLogger });
    await synchronizeConversationForRequest({
      conversationStore,
      requestBody,
      logger: operationLogger,
    });

    const lastUserMessage = requestBody.lastUserMessage;
    const recalledMemories = await memoryService.recallRelevantMemories(lastUserMessage, {
      logger: operationLogger,
    });
    const upstreamRequest = buildUpstreamRequest({
      requestBody,
      promptService,
      memoryService,
      recalledMemories,
      logger: operationLogger,
    });
    const executionContext = getExecutionContext({
      requestBody,
      toolRegistry,
      logger: operationLogger,
    });
    if (executionContext.tools.length > 0) {
      upstreamRequest.tools = executionContext.tools;
    }
    if (requestBody.toolChoice) {
      upstreamRequest.tool_choice = requestBody.toolChoice;
    }

    const startedAt = Date.now();
    operationLogger.info(
      {
        model: requestBody.model,
        stream: true,
        recalledMemoryCount: recalledMemories.length,
      },
      "Opened upstream streaming chat completion"
    );
    operationLogger.debug(
      {
        model: requestBody.model,
        stream: true,
        upstreamOptionKeys: objectKeys(requestBody.upstreamOptions),
        toolCount: executionContext.tools.length,
      },
      "Opened upstream streaming request"
    );

    let assistantMessage = "";
    let completed = false;
    let chunkCount = 0;
    let firstChunkLatencyMs = null;

    try {
      if (shouldExecuteTools({ requestBody, toolsEnabled: executionContext.tools.length > 0 })) {
        yield* runStreamingToolLoop({
          upstreamRequest,
          requestBody,
          executionContext,
          signal,
          operationLogger,
          openaiClient,
          toolExecutor,
          maxRounds: config.tools.maxRounds,
          onChunk: (chunk) => {
            if (firstChunkLatencyMs === null) {
              firstChunkLatencyMs = Date.now() - startedAt;
            }
            chunkCount += 1;
            assistantMessage += extractAssistantTextFromChunk(chunk);
          },
        });
      } else {
        const stream = await openaiClient.chat.completions.create(
          {
            ...upstreamRequest,
            stream: true,
          },
          { signal }
        );

        for await (const chunk of stream) {
          if (firstChunkLatencyMs === null) {
            firstChunkLatencyMs = Date.now() - startedAt;
          }
          chunkCount += 1;
          assistantMessage += extractAssistantTextFromChunk(chunk);
          yield chunk;
        }
      }
      completed = true;
      operationLogger.info(
        {
          model: requestBody.model,
          stream: true,
          upstreamLatencyMs: Date.now() - startedAt,
        },
        "Upstream streaming chat completion finished"
      );
      operationLogger.debug(
        {
          model: requestBody.model,
          chunkCount,
          firstChunkLatencyMs,
          assistantMessageLength: assistantMessage.length,
          assistantMessageExcerpt: excerptText(assistantMessage),
        },
        "Processed upstream streaming response"
      );
    } finally {
      if (completed) {
        operationLogger.debug(
          {
            model: requestBody.model,
            assistantMessageLength: assistantMessage.length,
          },
          "Streaming completion finished; memory extraction will run after SSE completes"
        );
      }
    }
  }

  return {
    createChatCompletion,
    streamChatCompletion,
  };
}

function getExecutionContext({ requestBody, toolRegistry, logger }) {
  if (!toolRegistry) {
    return {
      tools: [],
      handlers: new Map(),
    };
  }

  return toolRegistry.getExecutionContext({
    clientTools: requestBody.tools || [],
    logger,
  });
}

async function runToolLoop({
  upstreamRequest,
  requestBody,
  executionContext,
  signal,
  operationLogger,
  openaiClient,
  toolExecutor,
  maxRounds,
}) {
  const conversationMessages = Array.isArray(upstreamRequest.messages)
    ? [...upstreamRequest.messages]
    : [];
  const basePayload = {
    ...upstreamRequest,
    messages: undefined,
  };

  for (let round = 0; round < maxRounds; round += 1) {
    const completion = await openaiClient.chat.completions.create(
      {
        ...basePayload,
        messages: conversationMessages,
      },
      { signal }
    );

    const assistantMessage = completion?.choices?.[0]?.message;
    const toolCalls = normalizeToolCalls(assistantMessage?.tool_calls);
    if (toolCalls.length === 0) {
      operationLogger.debug(
        {
          model: requestBody.model,
          round,
          stopReason: "assistant_message_without_tool_calls",
        },
        "Tool loop completed"
      );
      return completion;
    }

    conversationMessages.push({
      role: "assistant",
      content: assistantMessage?.content ?? "",
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    operationLogger.debug(
      {
        model: requestBody.model,
        round,
        toolCallCount: toolCalls.length,
      },
      "Processing tool calls from model response"
    );

    const toolResults = await toolExecutor.executeToolCalls({
      toolCalls,
      executionContext,
      requestLogger: operationLogger,
    });

    const handledResults = toolResults.filter((result) => result.handled);
    if (handledResults.length === 0) {
      operationLogger.debug(
        {
          model: requestBody.model,
          round,
          stopReason: "no_server_handlers_for_tool_calls",
        },
        "Tool loop returned raw tool calls to caller"
      );
      return completion;
    }

    for (const result of handledResults) {
      conversationMessages.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: result.content,
      });
    }
  }

  throw new AppError({
    statusCode: 400,
    code: "invalid_request_error",
    type: "invalid_request_error",
    message: `Tool execution exceeded the maximum number of rounds (${maxRounds}).`,
  });
}

async function* runStreamingToolLoop({
  upstreamRequest,
  requestBody,
  executionContext,
  signal,
  operationLogger,
  openaiClient,
  toolExecutor,
  maxRounds,
  onChunk,
}) {
  const conversationMessages = Array.isArray(upstreamRequest.messages)
    ? [...upstreamRequest.messages]
    : [];
  const basePayload = {
    ...upstreamRequest,
    messages: undefined,
    stream: true,
  };

  for (let round = 0; round < maxRounds; round += 1) {
    const stream = await openaiClient.chat.completions.create(
      {
        ...basePayload,
        messages: conversationMessages,
      },
      { signal }
    );

    const aggregate = {
      assistantContent: "",
      streamedToolCalls: [],
    };
    const roundChunks = [];
    for await (const chunk of stream) {
      applyStreamChunkToAggregate(chunk, aggregate);
      roundChunks.push(chunk);
    }

    const toolCalls = normalizeStreamedToolCalls(aggregate.streamedToolCalls);
    if (toolCalls.length === 0) {
      for (const chunk of roundChunks) {
        onChunk?.(chunk);
        yield chunk;
      }
    }

    conversationMessages.push({
      role: "assistant",
      content: aggregate.assistantContent,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    if (toolCalls.length === 0) {
      operationLogger.debug(
        {
          model: requestBody.model,
          round,
          stopReason: "assistant_stream_without_tool_calls",
        },
        "Streaming tool loop completed"
      );
      return;
    }

    operationLogger.debug(
      {
        model: requestBody.model,
        round,
        toolCallCount: toolCalls.length,
      },
      "Executing tool calls from streamed assistant response"
    );

    const toolResults = await toolExecutor.executeToolCalls({
      toolCalls,
      executionContext,
      requestLogger: operationLogger,
    });
    const toolResultById = new Map(toolResults.map((result) => [result.toolCallId, result]));

    for (const chunk of buildSyntheticToolCallChunks({
      toolCalls,
      toolResultById,
      model: requestBody.model,
    })) {
      onChunk?.(chunk);
      yield chunk;
    }

    const handledResults = toolResults.filter((result) => result.handled);
    if (handledResults.length === 0) {
      operationLogger.debug(
        {
          model: requestBody.model,
          round,
          stopReason: "no_server_handlers_for_tool_calls",
        },
        "Streaming tool loop returned raw tool calls to caller"
      );
      return;
    }

    for (const result of handledResults) {
      conversationMessages.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: result.content,
      });
    }
  }

  throw new AppError({
    statusCode: 400,
    code: "invalid_request_error",
    type: "invalid_request_error",
    message: `Tool execution exceeded the maximum number of rounds (${maxRounds}).`,
  });
}

function applyStreamChunkToAggregate(chunk, aggregate) {
  const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null;
  const delta = choice?.delta;
  if (!delta || typeof delta !== "object") {
    return;
  }

  aggregate.assistantContent += extractAssistantTextFromChunk({
    choices: [{ delta }],
  });

  if (Array.isArray(delta.tool_calls)) {
    mergeToolCallDeltas(aggregate.streamedToolCalls, delta.tool_calls);
  }
}

function mergeToolCallDeltas(current, deltas) {
  for (const delta of deltas) {
    let index = Number.isInteger(delta?.index) && delta.index >= 0 ? delta.index : -1;
    if (index < 0 && typeof delta?.id === "string" && delta.id) {
      index = current.findIndex((item) => item?.id === delta.id);
    }
    if (index < 0) {
      index = current.length;
    }
    const existing = current[index] || {
      id: "",
      type: "function",
      function: {
        name: "",
        arguments: "",
      },
    };

    if (typeof delta?.id === "string" && delta.id) {
      existing.id = delta.id;
    }
    if (typeof delta?.type === "string" && delta.type) {
      existing.type = delta.type;
    }
    if (delta?.function && typeof delta.function === "object") {
      if (typeof delta.function.name === "string" && delta.function.name) {
        existing.function.name = delta.function.name;
      }
      if (typeof delta.function.arguments === "string" && delta.function.arguments) {
        existing.function.arguments += delta.function.arguments;
      }
    }

    current[index] = existing;
  }
}

function normalizeStreamedToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .map((toolCall) => {
      const id = typeof toolCall?.id === "string" ? toolCall.id : "";
      const name = typeof toolCall?.function?.name === "string" ? toolCall.function.name : "";
      const rawArgs = toolCall?.function?.arguments;
      if (!id || !name) {
        return null;
      }
      return {
        id,
        type: "function",
        function: {
          name,
          arguments: typeof rawArgs === "string" && rawArgs ? rawArgs : "{}",
        },
      };
    })
    .filter(Boolean);
}

function buildSyntheticToolCallChunks({ toolCalls, toolResultById, model }) {
  const created = Math.floor(Date.now() / 1000);
  const chunks = [];

  for (let index = 0; index < toolCalls.length; index += 1) {
    const toolCall = toolCalls[index];
    const result = toolResultById.get(toolCall.id) || null;
    const argumentsObject = parseJsonObject(toolCall.function.arguments);
    const enrichedArguments = enrichToolArgumentsForDisplay({
      toolName: toolCall.function.name,
      argumentsObject,
      result,
    });
    const summary = summarizeToolResultForStream({
      toolCall,
      resultContent: result?.content || "{}",
    });
    const serializedArguments = JSON.stringify(enrichedArguments);

    chunks.push({
      id: createSyntheticId("chatcmplchunk"),
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            ...(index === 0 ? { role: "assistant" } : {}),
            tool_calls: [
              {
                index,
                id: toolCall.id,
                type: "function",
                function: {
                  name: toolCall.function.name,
                  arguments: serializedArguments,
                },
                output: summary.output || null,
                error: summary.error || null,
              },
            ],
          },
        },
      ],
    });
  }

  chunks.push({
    id: createSyntheticId("chatcmplchunk"),
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "tool_calls",
      },
    ],
  });

  return chunks;
}

function summarizeToolResultForStream({ toolCall, resultContent }) {
  const parsedResult = parseJsonObject(resultContent);
  const inputArgs = parseJsonObject(toolCall?.function?.arguments);
  const data = parsedResult?.data;
  const summary = {
    ok: Boolean(parsedResult?.ok),
    input: sanitizeObjectForToolStream(inputArgs, 260),
  };

  if (summary.ok) {
    summary.output = summarizeToolOutputData(data);
  } else {
    summary.error = {
      code: parsedResult?.error?.code || "tool_execution_failed",
      message: excerptText(String(parsedResult?.error?.message || "Tool execution failed."), 260),
    };
  }

  return summary;
}

function summarizeToolOutputData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return sanitizeValueForToolStream(data, 260);
  }

  const summary = {};
  if (typeof data.url === "string") {
    summary.url = data.url;
  }
  if (typeof data.document_id === "string") {
    summary.document_id = data.document_id;
  }
  if (typeof data.source === "string") {
    summary.source = data.source;
  }
  if (typeof data.result_count === "number") {
    summary.result_count = data.result_count;
  }
  if (typeof data.match_count === "number") {
    summary.match_count = data.match_count;
  }
  if (typeof data.text_length === "number") {
    summary.text_length = data.text_length;
  }
  if (typeof data.preview === "string") {
    summary.preview_excerpt = excerptText(data.preview, 260);
  }
  if (typeof data.text === "string") {
    summary.text_excerpt = excerptText(data.text, 260);
  }

  if (Array.isArray(data.results)) {
    summary.results = data.results.slice(0, 5).map((item) => ({
      result_id: item?.result_id || null,
      title: excerptText(String(item?.title || ""), 100),
      url: typeof item?.url === "string" ? item.url : null,
      snippet: excerptText(String(item?.snippet || ""), 140),
    }));
  }

  if (Array.isArray(data.matches)) {
    summary.matches = data.matches.slice(0, 3).map((item) => ({
      offset: item?.offset ?? null,
      excerpt: excerptText(String(item?.excerpt || ""), 200),
    }));
  }

  if (Object.keys(summary).length === 0) {
    return sanitizeObjectForToolStream(data, 200);
  }
  return summary;
}

function enrichToolArgumentsForDisplay({ toolName, argumentsObject, result }) {
  const outputData = parseJsonObject(result?.content)?.data;
  if (toolName === "get_url_content" && outputData && typeof outputData === "object") {
    const enriched = { ...argumentsObject };
    if (!enriched.url && typeof outputData.url === "string") {
      enriched.url = outputData.url;
    }
    if (typeof outputData.source === "string" && enriched.source === undefined) {
      enriched.source = outputData.source;
    }
    return enriched;
  }

  return argumentsObject;
}

function sanitizeObjectForToolStream(value, maxStringLength) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = sanitizeValueForToolStream(entry, maxStringLength);
  }
  return out;
}

function sanitizeValueForToolStream(value, maxStringLength) {
  if (typeof value === "string") {
    return excerptText(value, maxStringLength);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 6).map((item) => sanitizeValueForToolStream(item, 120));
  }
  if (value && typeof value === "object") {
    return sanitizeObjectForToolStream(value, 120);
  }
  return value ?? null;
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .map((toolCall) => {
      const id = typeof toolCall?.id === "string" ? toolCall.id : "";
      const name = typeof toolCall?.function?.name === "string" ? toolCall.function.name : "";
      const rawArgs = toolCall?.function?.arguments;
      if (!id || !name) {
        return null;
      }
      return {
        id,
        type: "function",
        function: {
          name,
          arguments:
            typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs || {}),
        },
      };
    })
    .filter(Boolean);
}

function shouldExecuteTools({ requestBody, toolsEnabled }) {
  if (!toolsEnabled) {
    return false;
  }

  if (requestBody.toolChoice === "none") {
    return false;
  }

  return true;
}

function buildUpstreamRequest({ requestBody, promptService, memoryService, recalledMemories, logger }) {
  const systemPrompt = promptService.getActiveSystemPrompt();
  const memoryContext = memoryService.formatMemoryContext(recalledMemories);
  const upstreamMessages = [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "system",
      content: `Current Date: ${new Date().toISOString()}`,
    },
    {
      role: "system",
      content: memoryContext,
    },
    ...requestBody.messages,
  ];

  logger?.debug(
    {
      originalMessageCount: requestBody.messages.length,
      recalledMemoryCount: recalledMemories.length,
      upstreamMessageCount: upstreamMessages.length,
      upstreamOptionKeys: objectKeys(requestBody.upstreamOptions),
      hasSystemPrompt: Boolean(systemPrompt),
      memoryContextLength: textLength(memoryContext),
    },
    "Built upstream chat completion request payload"
  );

  return {
    model: requestBody.model,
    stream: false,
    messages: upstreamMessages,
    ...requestBody.upstreamOptions,
  };
}

async function synchronizeConversationForRequest({ conversationStore, requestBody, logger }) {
  if (!conversationStore || !requestBody?.conversationId) {
    return;
  }

  try {
    conversationStore.replaceConversationMessagesFromClient({
      conversationId: requestBody.conversationId,
      messages: requestBody.messages,
    });
  } catch (error) {
    logger.warn(
      {
        err: error,
        conversationId: requestBody.conversationId,
      },
      "Failed to mirror client conversation history before upstream request"
    );
  }
}

function appendAssistantMessageToConversation({
  conversationStore,
  conversationId,
  assistantMessage,
  logger,
}) {
  if (!conversationStore || !conversationId || typeof assistantMessage !== "string") {
    return;
  }

  try {
    conversationStore.appendAssistantMessage({
      conversationId,
      content: assistantMessage,
    });
  } catch (error) {
    logger.warn(
      { err: error, conversationId },
      "Failed to append assistant message to conversation store"
    );
  }
}

function scheduleConversationMemoryExtraction({
  memoryService,
  conversationId,
  assistantMessage,
  model,
  logger,
}) {
  if (!conversationId || !assistantMessage) {
    logger.debug(
      {
        model,
        conversationId,
        assistantMessageLength: textLength(assistantMessage),
      },
      "Skipping background memory extraction due to missing conversation context"
    );
    return;
  }
  logger.debug(
    {
      model,
      conversationId,
      assistantMessageLength: textLength(assistantMessage),
      assistantMessageExcerpt: excerptText(assistantMessage),
    },
    "Scheduling background memory extraction"
  );

  void memoryService
    .extractAndStoreMemories({
      conversationId,
      assistantMessage,
      model,
      logger,
    })
    .catch((error) => {
      logger.warn({ err: error }, "Background memory extraction failed");
    });
}

export { createChatService };
