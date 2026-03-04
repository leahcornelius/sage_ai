import {
  extractAssistantTextFromChunk,
  extractAssistantTextFromCompletion,
} from "../http/serializers/openai-chat.js";
import { excerptText, objectKeys, textLength } from "../logging/safe-debug.js";

/**
 * Composes Sage-specific context around standard OpenAI chat completion
 * requests while keeping the external HTTP layer stateless.
 */
function createChatService({
  openaiClient,
  memoryService,
  promptService,
  modelService,
  logger,
}) {
  const serviceLogger = logger.child({ service: "chat-service" });

  async function createChatCompletion({ requestBody, signal, logger: requestLogger }) {
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
    operationLogger.debug(
      {
        model: requestBody.model,
        stream: false,
        upstreamOptionKeys: objectKeys(requestBody.upstreamOptions),
      },
      "Dispatching upstream chat completion request"
    );

    const startedAt = Date.now();
    const completion = await openaiClient.chat.completions.create(upstreamRequest, { signal });
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
    scheduleMemoryExtraction({
      memoryService,
      userMessage: lastUserMessage,
      assistantMessage,
      model: requestBody.model,
      logger: operationLogger,
    });

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

    const startedAt = Date.now();
    const stream = await openaiClient.chat.completions.create(
      {
        ...upstreamRequest,
        stream: true,
      },
      { signal }
    );

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
      },
      "Opened upstream streaming request"
    );

    let assistantMessage = "";
    let completed = false;
    let chunkCount = 0;
    let firstChunkLatencyMs = null;

    try {
      for await (const chunk of stream) {
        if (firstChunkLatencyMs === null) {
          firstChunkLatencyMs = Date.now() - startedAt;
        }
        chunkCount += 1;
        assistantMessage += extractAssistantTextFromChunk(chunk);
        yield chunk;
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
        scheduleMemoryExtraction({
          memoryService,
          userMessage: lastUserMessage,
          assistantMessage,
          model: requestBody.model,
          logger: operationLogger,
        });
      }
    }
  }

  return {
    createChatCompletion,
    streamChatCompletion,
  };
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
