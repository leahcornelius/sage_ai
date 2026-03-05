import {
  extractAssistantTextFromChunk,
  extractAssistantTextFromCompletion,
} from "../http/serializers/openai-chat.js";
import { excerptText, objectKeys, textLength } from "../logging/safe-debug.js";
import { AppError } from "../errors/app-error.js";

/**
 * Composes Sage-specific context around standard OpenAI chat completion
 * requests while keeping the external HTTP layer stateless.
 */
function createChatService({
  openaiClient,
  memoryService,
  promptService,
  modelService,
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
      scheduleMemoryExtraction({
        memoryService,
        userMessage: lastUserMessage,
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
    for await (const chunk of stream) {
      onChunk?.(chunk);
      applyStreamChunkToAggregate(chunk, aggregate);
      yield chunk;
    }

    const toolCalls = normalizeStreamedToolCalls(aggregate.streamedToolCalls);
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
    const index = Number.isInteger(delta?.index) && delta.index >= 0 ? delta.index : current.length;
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
        existing.function.name += delta.function.name;
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

function scheduleMemoryExtraction({ memoryService, userMessage, assistantMessage, model, logger }) {
  if (!userMessage || !assistantMessage) {
    logger.debug(
      {
        model,
        userMessageLength: textLength(userMessage),
        assistantMessageLength: textLength(assistantMessage),
      },
      "Skipping background memory extraction due to missing conversation text"
    );
    return;
  }
  logger.debug(
    {
      model,
      userMessageLength: textLength(userMessage),
      assistantMessageLength: textLength(assistantMessage),
      userMessageExcerpt: excerptText(userMessage),
      assistantMessageExcerpt: excerptText(assistantMessage),
    },
    "Scheduling background memory extraction"
  );

  void memoryService
    .extractAndStoreMemories({
      userMessage,
      assistantMessage,
      model,
      logger,
    })
    .catch((error) => {
      logger.warn({ err: error }, "Background memory extraction failed");
    });
}

export { createChatService };
