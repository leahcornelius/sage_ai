import { createMnemosyne } from "mnemosy-ai";

/**
 * Creates the shared Mnemosyne memory client once during startup.
 */
async function createMnemosyneClient({ config, logger }) {
  const memoryLogger = logger.child({ component: "mnemosyne" });
  memoryLogger.info(
    {
      vectorDbUrl: config.memory.mnemosyne.vectorDbUrl,
      graphDbUrl: config.memory.mnemosyne.graphDbUrl,
      cacheUrl: config.memory.mnemosyne.cacheUrl,
      collectionName: config.memory.mnemosyne.collectionName,
      agentId: config.memory.mnemosyne.agentId,
    },
    "Initializing Mnemosyne client"
  );
  memoryLogger.debug(
    {
      embeddingUrl: config.memory.mnemosyne.embeddingUrl,
      embeddingModel: config.memory.mnemosyne.embeddingModel,
    },
    "Mnemosyne embedding configuration"
  );

  return createMnemosyne({
    vectorDbUrl: config.memory.mnemosyne.vectorDbUrl,
    embeddingUrl: config.memory.mnemosyne.embeddingUrl,
    graphDbUrl: config.memory.mnemosyne.graphDbUrl,
    cacheUrl: config.memory.mnemosyne.cacheUrl,
    agentId: config.memory.mnemosyne.agentId,
    embeddingModel: config.memory.mnemosyne.embeddingModel,
    collectionName: config.memory.mnemosyne.collectionName,
  });
}

export { createMnemosyneClient };
