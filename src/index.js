import { buildApp } from "./app.js";
import { createConfig } from "./config/env.js";
import { createLogger } from "./logging/logger.js";
import { createOpenAIClient } from "./providers/openai-client.js";
import { createMnemosyneClient } from "./providers/mnemosyne-client.js";
import { createChatService } from "./services/chat-service.js";
import { createMemoryService } from "./services/memory-service.js";
import { createLlmRouterService } from "./services/llm-router-service.js";
import { createModelService } from "./services/model-service.js";
import { createPromptService } from "./services/prompt-service.js";
import { createConversationStore } from "./services/conversation-store.js";
import { createMcpClientManager } from "./tools/mcp/mcp-client-manager.js";
import { createDocumentCache } from "./tools/document-cache.js";
import { createToolRegistry } from "./tools/tool-registry.js";
import { createToolExecutor } from "./tools/tool-executor.js";

async function main() {
  let logger;
  let mcpClientManager;
  let conversationStore;
  let memoryService;

  try {
    const config = createConfig();
    logger = createLogger(config);

    logger.info(
      {
        host: config.server.host,
        port: config.server.port,
        openaiBaseUrl: config.openai.baseUrl || "https://api.openai.com/v1",
        modelAllowlistCount: config.openai.modelAllowlist?.length || 0,
        memoryTopK: config.memory.topK,
        memoryExtractEvery: config.memory.extractEvery,
        memoryExtractionHistoryMultiplier: config.memory.extractionHistoryMultiplier,
        conversationDbPath: config.memory.conversationDbPath,
        systemPromptPath: config.prompt.systemPromptPath,
        consoleLogLevel: config.logging.consoleLevel,
        fileLoggingEnabled: config.logging.fileEnabled,
        fileLogLevel: config.logging.fileLevel,
        fileLogPath: config.logging.filePath,
      },
      "Loaded Sage server configuration"
    );
    logger.debug(
      {
        legacyLogLevel: config.logging.level,
        prettyConsoleLogs: config.logging.pretty,
        documentCacheTtlMs: config.tools.documentCache.ttlMs,
        documentCacheMaxDocs: config.tools.documentCache.maxDocuments,
        documentCacheMaxDocBytes: config.tools.documentCache.maxDocumentBytes,
      },
      "Resolved logging configuration"
    );

    const localOpenAiClient = createOpenAIClient({
      apiKey: config.llm.localApiKey,
      baseUrl: config.llm.localBaseUrl,
    });
    const cloudOpenAiClient = createOpenAIClient({
      apiKey: config.llm.cloudApiKey,
      baseUrl: config.llm.cloudBaseUrl,
    });
    const mnemosyneClient = await createMnemosyneClient({ config, logger });
    conversationStore = createConversationStore({ config, logger });
    const promptService = createPromptService({ config, logger });
    const modelService = createModelService({ openaiClient: localOpenAiClient, config, logger });
    const llmRouter = createLlmRouterService({
      localClient: localOpenAiClient,
      cloudClient: cloudOpenAiClient,
      config,
      logger,
    });
    memoryService = createMemoryService({
      mnemosyneClient,
      conversationStore,
      config,
      logger,
    });
    await memoryService.assertReady({ logger });
    mcpClientManager = createMcpClientManager({ config, logger });
    await mcpClientManager.initialize();
    const documentCache = createDocumentCache({
      config,
      logger,
    });
    const toolRegistry = createToolRegistry({
      config,
      logger,
      memoryService,
      mcpClientManager,
      documentCache,
    });
    const toolExecutor = createToolExecutor({
      config,
      logger,
    });
    const chatService = createChatService({
      openaiClient: localOpenAiClient,
      llmRouter,
      memoryService,
      promptService,
      modelService,
      conversationStore,
      toolRegistry,
      toolExecutor,
      config,
      logger,
    });

    const app = await buildApp({
      config,
      logger,
      services: {
        chatService,
        memoryService,
        modelService,
        promptService,
        conversationStore,
      },
    });

    const shutdown = createShutdownHandler(app, logger, mcpClientManager);
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await app.listen({
      host: config.server.host,
      port: config.server.port,
    });

    logger.info({ address: app.server.address() }, "Sage OpenAI-compatible API server is listening");
  } catch (error) {
    if (conversationStore) {
      conversationStore.close();
    }
    if (memoryService) {
      await memoryService.close();
    }
    if (mcpClientManager) {
      await mcpClientManager.close();
    }
    if (logger) {
      logger.fatal({ err: error }, "Sage server failed to start");
      await flushLogger(logger);
    } else {
      console.error(error);
    }
    process.exit(1);
  }
}

function createShutdownHandler(app, logger, mcpClientManager) {
  let shuttingDown = false;

  return async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, "Shutting down Sage server");

    try {
      await mcpClientManager?.close();
      await app.sageServices.memoryService?.close?.();
      app.sageServices.conversationStore?.close?.();
      await app.close();
      logger.info("Sage server shutdown complete");
      await flushLogger(logger);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "Sage server shutdown failed");
      await flushLogger(logger);
      process.exit(1);
    }
  };
}

async function flushLogger(logger) {
  if (typeof logger?.flush !== "function") {
    return;
  }

  await new Promise((resolve) => logger.flush(resolve));
}

await main();
