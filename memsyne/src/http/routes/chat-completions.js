import {
  extractAssistantTextFromChunk,
  serializeChatCompletion,
  serializeChatCompletionChunk,
} from "../serializers/openai-chat.js";
import { validateChatCompletionsRequest } from "../validation/chat-completions.js";
import { createAbortControllerFromRequest } from "../../utils/abort.js";
import { excerptText, objectKeys, roleSequence } from "../../logging/safe-debug.js";

async function registerChatCompletionRoutes(app) {
  app.post("/chat/completions", async (request, reply) => {
    const requestBody = validateChatCompletionsRequest(request.body);
    const abortController = createAbortControllerFromRequest(request);
    const routeStartedAt = process.hrtime.bigint();

    try {
      request.log.info(
        {
          model: requestBody.model,
          stream: requestBody.stream,
          messageCount: requestBody.messages.length,
          toolCount: requestBody.tools.length,
          toolChoice: requestBody.toolChoice || "auto",
        },
        "Handling chat completion request"
      );
      request.log.debug(
        {
          model: requestBody.model,
          stream: requestBody.stream,
          messageCount: requestBody.messages.length,
          roles: roleSequence(requestBody.messages),
          upstreamOptionKeys: objectKeys(requestBody.upstreamOptions),
          toolCount: requestBody.tools.length,
          toolChoice: requestBody.toolChoice || "auto",
          lastUserMessageExcerpt: excerptText(requestBody.lastUserMessage),
        },
        "Validated chat completion request"
      );

      if (!requestBody.stream) {
        const completion = await app.sageServices.chatService.createChatCompletion({
          requestBody,
          signal: abortController.signal,
          logger: request.log,
        });

        return serializeChatCompletion(completion);
      }

      const stream = app.sageServices.chatService.streamChatCompletion({
        requestBody,
        signal: abortController.signal,
        logger: request.log,
      });
      const iterator = stream[Symbol.asyncIterator]();
      let chunkCount = 0;
      let assistantTextLength = 0;
      let assistantMessage = "";
      let firstChunkLatencyMs = null;
      const firstResult = await iterator.next();
      if (!firstResult.done) {
        chunkCount = 1;
        assistantTextLength += getChunkTextLength(firstResult.value);
        assistantMessage += extractAssistantTextFromChunk(firstResult.value);
        firstChunkLatencyMs = Number(
          (Number(process.hrtime.bigint() - routeStartedAt) / 1_000_000).toFixed(2)
        );
      }

      reply.hijack();
      reply.raw.statusCode = 200;
      setStreamingCorsHeaders(request, reply);
      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      if (typeof reply.raw.flushHeaders === "function") {
        reply.raw.flushHeaders();
      }
      request.log.debug(
        {
          model: requestBody.model,
          firstChunkLatencyMs,
        },
        "Streaming response headers sent"
      );

      try {
        if (!firstResult.done) {
          reply.raw.write(`data: ${JSON.stringify(serializeChatCompletionChunk(firstResult.value))}\n\n`);
        }

        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
          chunkCount += 1;
          assistantTextLength += getChunkTextLength(chunk);
          assistantMessage += extractAssistantTextFromChunk(chunk);
          reply.raw.write(`data: ${JSON.stringify(serializeChatCompletionChunk(chunk))}\n\n`);
        }

        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        scheduleMemoryExtractionAfterStreaming({
          memoryService: app.sageServices.memoryService,
          model: requestBody.model,
          userMessage: requestBody.lastUserMessage,
          assistantMessage,
          logger: request.log,
        });
        request.log.debug(
          {
            model: requestBody.model,
            chunkCount,
            assistantTextLength,
            firstChunkLatencyMs,
          },
          "Streaming chat completion finished"
        );
      } catch (error) {
        request.log.error(
          {
            err: error,
            chunkCount,
            assistantTextLength,
            firstChunkLatencyMs,
          },
          "Streaming chat completion failed after the response started"
        );
        reply.raw.end();
      }

      return reply;
    } finally {
      abortController.complete();
    }
  });
}

function scheduleMemoryExtractionAfterStreaming({
  memoryService,
  model,
  userMessage,
  assistantMessage,
  logger,
}) {
  if (!userMessage || !assistantMessage) {
    logger.debug(
      {
        model,
        userMessageLength: typeof userMessage === "string" ? userMessage.length : 0,
        assistantMessageLength: typeof assistantMessage === "string" ? assistantMessage.length : 0,
      },
      "Skipping post-stream memory extraction due to missing conversation text"
    );
    return;
  }
  if (typeof memoryService?.extractAndStoreMemories !== "function") {
    logger.debug({ model }, "Skipping post-stream memory extraction because memory service is unavailable");
    return;
  }

  logger.debug(
    {
      model,
      userMessageLength: userMessage.length,
      assistantMessageLength: assistantMessage.length,
    },
    "Scheduling post-stream memory extraction"
  );

  void memoryService
    .extractAndStoreMemories({
      userMessage,
      assistantMessage,
      model,
      logger,
    })
    .catch((error) => {
      logger.warn({ err: error }, "Background memory extraction failed after streaming");
    });
}

function getChunkTextLength(chunk) {
  const delta = chunk?.choices?.[0]?.delta;
  if (!delta || typeof delta !== "object") {
    return 0;
  }
  if (delta.role === "tool") {
    return 0;
  }
  return typeof delta.content === "string" ? delta.content.length : 0;
}

function setStreamingCorsHeaders(request, reply) {
  const configuredOrigin = request.server.sageConfig.server.corsOrigin;
  const requestOrigin = request.headers.origin;

  if (!configuredOrigin) {
    return;
  }

  if (configuredOrigin === "*") {
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");
    return;
  }

  if (requestOrigin && requestOrigin === configuredOrigin) {
    reply.raw.setHeader("Access-Control-Allow-Origin", configuredOrigin);
    reply.raw.setHeader("Vary", "Origin");
  }
}

export { registerChatCompletionRoutes };
