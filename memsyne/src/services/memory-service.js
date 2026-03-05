import {
  extractAssistantTextFromCompletion,
  extractTextContent,
} from "../http/serializers/openai-chat.js";
import { excerptText, textLength } from "../logging/safe-debug.js";

/**
 * Owns all long-term memory interactions so the rest of the app only needs to
 * ask for recalled context and trigger best-effort extraction after replies.
 */
function createMemoryService({
  mnemosyneClient,
  openaiClient,
  conversationStore,
  config,
  logger,
}) {
  const serviceLogger = logger.child({ service: "memory-service" });

  async function recallRelevantMemories(query, { logger: requestLogger } = {}) {
    if (!query) {
      return [];
    }

    const operationLogger = requestLogger || serviceLogger;
    operationLogger.debug(
      {
        queryLength: textLength(query),
        queryExcerpt: excerptText(query),
        topK: config.memory.topK,
      },
      "Recalling long-term memories"
    );

    try {
      const recalled = await mnemosyneClient.recall({
        query,
        topK: config.memory.topK,
      });

      operationLogger.info(
        { recallCount: recalled.length, topK: config.memory.topK },
        "Recalled long-term memories"
      );
      operationLogger.debug(
        {
          recallCount: recalled.length,
          confidenceTags: summarizeMemoryMetadata(recalled, "confidenceTag"),
          categories: summarizeMemoryMetadata(recalled, "category"),
        },
        "Memory recall metadata"
      );

      return recalled;
    } catch (error) {
      operationLogger.warn(
        { err: error },
        "Memory recall failed; continuing without recalled memories"
      );
      return [];
    }
  }

  function formatMemoryContext(memories) {
    if (!Array.isArray(memories) || memories.length === 0) {
      return "Memory context:\nNo relevant long-term memories were recalled for this request.";
    }

    const lines = memories.map((memory, index) => {
      const entry = memory.entry || {};
      return `Recalled memory #${index + 1} - (${formatTimestamp(entry.ingestedAt)}, ${formatTimestamp(entry.updatedAt)}, ${entry.confidenceTag || "unknown"}, ${entry.memoryType || "unknown"}, ${entry.decayStatus || "unknown"}): ${entry.text || ""}`;
    });

    return [
      "Memory context:",
      "Recalled memory # - (ingestedAt, updatedAt, confidenceTag, memoryType, decayStatus): memoryContent",
      ...lines,
    ].join("\n");
  }

  async function extractAndStoreMemories({ conversationId, assistantMessage, model, logger: requestLogger }) {
    const operationLogger = requestLogger || serviceLogger;
    if (!conversationStore) {
      operationLogger.debug({ conversationId }, "Skipping extraction: conversation store is unavailable");
      return 0;
    }

    if (!conversationId || !assistantMessage) {
      operationLogger.debug(
        {
          conversationId,
          assistantMessageLength: textLength(assistantMessage),
        },
        "Skipping extraction: missing conversation context"
      );
      return 0;
    }

    const extractEvery = config.memory.extractEvery;
    const historyWindow = Math.max(
      1,
      Math.round(extractEvery * config.memory.extractionHistoryMultiplier)
    );
    let totalStored = 0;

    let conversation = conversationStore.getConversation(conversationId);
    let uaCount = conversationStore.getUaMessageCount(conversationId);

    while (uaCount - conversation.lastExtractedUaCount >= extractEvery) {
      const batchStart = conversation.lastExtractedUaCount;
      const batchEnd = batchStart + extractEvery - 1;

      const batchResult = await runExtractionBatch({
        conversationId,
        model,
        extractEvery,
        historyWindow,
        batchStart,
        batchEnd,
        conversation,
        logger: operationLogger,
      });

      if (!batchResult.success) {
        break;
      }

      totalStored += batchResult.storedCount;
      conversationStore.updateConversationProgress({
        conversationId,
        lastExtractedUaCount: batchEnd + 1,
        summaryThroughUaIndex: batchResult.summaryThroughUaIndex,
      });

      conversation = conversationStore.getConversation(conversationId);
      uaCount = conversationStore.getUaMessageCount(conversationId);
    }

    return totalStored;
  }

  async function runExtractionBatch({
    conversationId,
    model,
    extractEvery,
    historyWindow,
    batchStart,
    batchEnd,
    conversation,
    logger: operationLogger,
  }) {
    const extractionModel = config.memory.extractionModel || model;
    const summaryResult = await ensureSummaryCoverage({
      conversationId,
      model,
      targetSummaryEndIndex: batchStart - 2,
      conversation,
      logger: operationLogger,
    });

    const messagesForBatch = [];
    if (batchStart > 0) {
      const priorMessage = conversationStore.getUaMessageByIndex({
        conversationId,
        uaIndex: batchStart - 1,
      });
      if (priorMessage) {
        messagesForBatch.push(priorMessage);
      }
    }
    messagesForBatch.push(
      ...conversationStore.getUaMessagesInRange({
        conversationId,
        startIndex: batchStart,
        endIndex: batchEnd,
      })
    );

    const memoryWindowStart = Math.max(0, batchEnd - historyWindow + 1);
    const previousGenerations = conversationStore.listActiveMemoryGenerationsBySourceRange({
      conversationId,
      windowStart: memoryWindowStart,
      windowEnd: batchStart - 1,
    });

    operationLogger.debug(
      {
        conversationId,
        extractionModel,
        batchStart,
        batchEnd,
        summaryLength: textLength(summaryResult.summaryText),
        previousGenerationCount: previousGenerations.length,
        messageCountForBatch: messagesForBatch.length,
      },
      "Starting memory extraction batch"
    );

    let extractionResponse;
    try {
      extractionResponse = await openaiClient.chat.completions.create({
        model: extractionModel,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: buildMemoryExtractionPrompt({ extractEvery }),
          },
          {
            role: "user",
            content: buildBatchPayload({
              summaryText: summaryResult.summaryText,
              previousGenerations,
              batchMessages: messagesForBatch,
              batchStart,
              batchEnd,
            }),
          },
        ],
      });
    } catch (error) {
      operationLogger.warn(
        { err: error, extractionModel, conversationId, batchStart, batchEnd },
        "Memory extraction call failed"
      );
      return {
        success: false,
        storedCount: 0,
        summaryThroughUaIndex: summaryResult.summaryThroughUaIndex,
      };
    }

    const payload = extractAssistantTextFromCompletion(extractionResponse);
    const parsed = parseBatchExtractionPayload(payload);
    if (parsed.parseError) {
      operationLogger.warn(
        {
          conversationId,
          batchStart,
          batchEnd,
          parseError: parsed.parseError,
          payloadLength: textLength(payload),
        },
        "Memory extraction payload parsing failed"
      );
      return {
        success: false,
        storedCount: 0,
        summaryThroughUaIndex: summaryResult.summaryThroughUaIndex,
      };
    }

    const hasOutOfRange = [...parsed.newMemories, ...parsed.updatedMemories].some(
      (entry) => entry.sourceMessageIndex < batchStart || entry.sourceMessageIndex > batchEnd
    );
    if (hasOutOfRange) {
      operationLogger.warn(
        {
          conversationId,
          batchStart,
          batchEnd,
        },
        "Memory extraction payload included out-of-range source_message_index values"
      );
      return {
        success: false,
        storedCount: 0,
        summaryThroughUaIndex: summaryResult.summaryThroughUaIndex,
      };
    }

    const extractionRun = conversationStore.createExtractionRun({
      conversationId,
      batchStartUaIndex: batchStart,
      batchEndUaIndex: batchEnd,
      extractionModel,
      summaryChars: textLength(summaryResult.summaryText),
    });

    let storedCount = 0;

    for (const memory of parsed.newMemories) {
      const normalizedImportance = normalizeImportanceToUnit(memory.importance);
      try {
        const memoryId = await mnemosyneClient.store({
          text: memory.text,
          ...(normalizedImportance !== null ? { importance: normalizedImportance } : {}),
          ...(memory.category ? { category: memory.category } : {}),
          ...(memory.eventTime ? { eventTime: memory.eventTime } : {}),
        });

        if (!memoryId) {
          continue;
        }

        conversationStore.addMemoryGeneration({
          conversationId,
          memoryId,
          sourceMessageIndex: memory.sourceMessageIndex,
          extractionRun,
          memoryText: memory.text,
        });
        storedCount += 1;
      } catch (error) {
        operationLogger.warn({ err: error, conversationId }, "Failed to store extracted memory entry");
      }
    }

    for (const memory of parsed.updatedMemories) {
      try {
        const existing = await findMemoryById(memory.oldMemoryId);
        if (!existing) {
          operationLogger.warn(
            { conversationId, memoryId: memory.oldMemoryId },
            "Skipping memory update because referenced memory was not found"
          );
          continue;
        }

        const normalizedImportance = normalizeImportanceToUnit(memory.importance);
        await upsertUpdatedMemory({
          existing,
          updatedMemory: memory,
          normalizedImportance,
        });

        conversationStore.deactivateActiveGenerationsByMemoryId({
          conversationId,
          memoryId: memory.oldMemoryId,
        });
        conversationStore.addMemoryGeneration({
          conversationId,
          memoryId: memory.oldMemoryId,
          sourceMessageIndex: memory.sourceMessageIndex,
          extractionRun,
          replacedMemoryId: memory.oldMemoryId,
          memoryText: memory.text,
        });
        storedCount += 1;
      } catch (error) {
        operationLogger.warn({ err: error, conversationId }, "Failed to apply extracted memory update");
      }
    }

    operationLogger.info(
      {
        conversationId,
        batchStart,
        batchEnd,
        storedCount,
        newCount: parsed.newMemories.length,
        updatedCount: parsed.updatedMemories.length,
      },
      "Finished memory extraction batch"
    );

    return {
      success: true,
      storedCount,
      summaryThroughUaIndex: summaryResult.summaryThroughUaIndex,
    };
  }

  async function ensureSummaryCoverage({
    conversationId,
    model,
    targetSummaryEndIndex,
    conversation,
    logger: operationLogger,
  }) {
    if (targetSummaryEndIndex < 0) {
      return {
        summaryText: "",
        summaryThroughUaIndex: -1,
      };
    }

    const currentSummary = conversation.summaryText || "";
    const currentThrough = Number.isInteger(conversation.summaryThroughUaIndex)
      ? conversation.summaryThroughUaIndex
      : -1;
    if (currentThrough >= targetSummaryEndIndex) {
      return {
        summaryText: currentSummary,
        summaryThroughUaIndex: currentThrough,
      };
    }

    const startIndex = currentThrough + 1;
    const newMessages = conversationStore.getUaMessagesInRange({
      conversationId,
      startIndex,
      endIndex: targetSummaryEndIndex,
    });

    if (newMessages.length === 0) {
      return {
        summaryText: currentSummary,
        summaryThroughUaIndex: currentThrough,
      };
    }

    const summaryModel = config.memory.summaryModel || config.memory.extractionModel || model;

    try {
      const response = await openaiClient.chat.completions.create({
        model: summaryModel,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: buildSummaryPrompt(),
          },
          {
            role: "user",
            content: buildSummaryInput({
              currentSummary,
              summaryThroughUaIndex: currentThrough,
              newMessages,
            }),
          },
        ],
      });

      const summaryText = extractTextContent(extractAssistantTextFromCompletion(response)).trim();
      const finalSummary = summaryText || currentSummary;
      conversationStore.updateConversationSummary({
        conversationId,
        summaryText: finalSummary,
        summaryThroughUaIndex: targetSummaryEndIndex,
      });

      return {
        summaryText: finalSummary,
        summaryThroughUaIndex: targetSummaryEndIndex,
      };
    } catch (error) {
      operationLogger.warn(
        {
          err: error,
          conversationId,
          summaryModel,
          startIndex,
          targetSummaryEndIndex,
        },
        "Failed to refresh rolling conversation summary"
      );
      return {
        summaryText: currentSummary,
        summaryThroughUaIndex: currentThrough,
      };
    }
  }

  async function findMemoryById(memoryId) {
    const sharedCollection =
      mnemosyneClient?.config?.sharedCollection || config.memory.mnemosyne.collectionName;
    const privateCollection =
      mnemosyneClient?.config?.privateCollection || "mem_private";

    const shared = await mnemosyneClient.db.getPoint(sharedCollection, memoryId);
    if (shared) {
      return { entry: shared, collection: sharedCollection };
    }

    const privateEntry = await mnemosyneClient.db.getPoint(privateCollection, memoryId);
    if (privateEntry) {
      return { entry: privateEntry, collection: privateCollection };
    }

    return null;
  }

  async function upsertUpdatedMemory({ existing, updatedMemory, normalizedImportance }) {
    const previous = existing.entry;
    const now = new Date().toISOString();
    const vector = await mnemosyneClient.embeddings.embed(updatedMemory.text);
    const metadata = {
      ...(previous.metadata && typeof previous.metadata === "object" ? previous.metadata : {}),
      ...(updatedMemory.eventUpdateTime
        ? {
            event_update_time: updatedMemory.eventUpdateTime,
          }
        : {}),
    };

    await mnemosyneClient.db.store(updatedMemory.text, vector, {
      id: previous.id,
      memoryType: previous.memoryType,
      classification: previous.classification,
      agentId: previous.agentId,
      userId: previous.userId,
      scope: previous.scope,
      urgency: previous.urgency,
      domain: previous.domain,
      confidence: previous.confidence,
      confidenceTag: previous.confidenceTag,
      priorityScore: previous.priorityScore,
      importance: normalizedImportance !== null ? normalizedImportance : previous.importance,
      linkedMemories: previous.linkedMemories,
      accessTimes: previous.accessTimes,
      accessCount: previous.accessCount,
      eventTime: previous.eventTime,
      ingestedAt: now,
      createdAt: previous.createdAt,
      category: updatedMemory.category || previous.category,
      metadata,
    });
  }

  async function getMemoriesForTool({ query, topK, logger: requestLogger }) {
    const operationLogger = requestLogger || serviceLogger;
    const safeTopK =
      Number.isInteger(topK) && topK >= 1 && topK <= 20 ? topK : config.memory.topK;

    const recalled = await mnemosyneClient.recall({
      query,
      topK: safeTopK,
    });

    operationLogger.debug(
      {
        queryLength: textLength(query),
        topK: safeTopK,
        recallCount: Array.isArray(recalled) ? recalled.length : 0,
      },
      "Retrieved memories for tool"
    );

    const entries = Array.isArray(recalled) ? recalled : [];
    return entries.map((memory) => {
      const entry = memory?.entry || {};
      return {
        text: typeof entry.text === "string" ? entry.text : "",
        confidence_tag: entry.confidenceTag || null,
        memory_type: entry.memoryType || null,
        decay_status: entry.decayStatus || null,
        updated_at: entry.updatedAt || null,
      };
    });
  }

  async function addMemoryFromTool({ text, importance, category, eventTime, logger: requestLogger }) {
    const operationLogger = requestLogger || serviceLogger;
    const normalizedImportance = normalizeImportanceToUnit(importance);
    await mnemosyneClient.store({
      text,
      ...(normalizedImportance !== null ? { importance: normalizedImportance } : {}),
      ...(category ? { category } : {}),
      ...(eventTime ? { eventTime } : {}),
    });

    operationLogger.info(
      {
        textLength: textLength(text),
        importance: normalizedImportance,
        category,
        hasEventTime: Boolean(eventTime),
      },
      "Stored memory from tool call"
    );

    return {
      text,
      importance: normalizedImportance,
      category: category ?? null,
      event_time: eventTime ?? null,
    };
  }

  return {
    recallRelevantMemories,
    formatMemoryContext,
    extractAndStoreMemories,
    getMemoriesForTool,
    addMemoryFromTool,
  };
}

function buildSummaryPrompt() {
  return [
    "You maintain a rolling summary of a conversation.",
    "Merge the existing summary with the new message span.",
    "Keep it factual, concise, and focused on context needed for future memory extraction.",
    "Return plain text only.",
  ].join("\n");
}

function buildSummaryInput({ currentSummary, summaryThroughUaIndex, newMessages }) {
  const serializedMessages = newMessages
    .map((message) => `message ${message.uaIndex} [${message.role}]: ${message.content}`)
    .join("\n");

  return [
    `Current summary (covers through message index ${summaryThroughUaIndex}):`,
    currentSummary || "(empty)",
    "",
    "New messages to include:",
    serializedMessages,
    "",
    "Return the updated summary text.",
  ].join("\n");
}

function buildMemoryExtractionPrompt({ extractEvery }) {
  return [
    "You extract long-term memories from a conversation batch.",
    `Only extract memories from the target batch of ${extractEvery} user/assistant messages.`,
    "You are provided with:",
    "1) A summary of older excluded messages.",
    "2) Previously extracted memories with IDs and source message indexes.",
    "3) Recent messages including one immediate pre-batch context message.",
    "Avoid duplicate memories when an existing memory already captures the same fact.",
    "If new information updates/clarifies/contradicts an existing memory, output it in updated[].",
    "Return JSON only with this exact shape:",
    '{"new":[{"source_message_index":0,"text":"concise memory text","importance":0.8,"category":"category","eventTime":"ISO timestamp or null"}],"updated":[{"source_message_index":0,"old_memory_id":"memory-id","text":"updated concise memory text","importance":0.8,"category":"category","eventUpdateTime":"ISO timestamp or null"}]}',
    "importance should be between 0 and 1 (if uncertain use null).",
  ].join("\n");
}

function buildBatchPayload({ summaryText, previousGenerations, batchMessages, batchStart, batchEnd }) {
  const formattedPrevious =
    previousGenerations.length > 0
      ? previousGenerations
          .map(
            (memory) =>
              `generation ${memory.generationOrder} | memory_id=${memory.memoryId} | source_message_index=${memory.sourceMessageIndex} | text=${memory.memoryText}`
          )
          .join("\n")
      : "(none)";

  const formattedMessages = batchMessages
    .map((message) => `message ${message.uaIndex} [${message.role}]: ${message.content}`)
    .join("\n");

  return [
    `Target extraction range: source_message_index ${batchStart}..${batchEnd}`,
    "",
    "Conversation summary for excluded history:",
    summaryText || "(empty)",
    "",
    "Previously extracted memories in scope:",
    formattedPrevious,
    "",
    "Recent messages (context + target range):",
    formattedMessages,
  ].join("\n");
}

function parseBatchExtractionPayload(payload) {
  const raw = extractTextContent(payload).trim();
  if (!raw) {
    return {
      newMemories: [],
      updatedMemories: [],
      parseError: null,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      newMemories: [],
      updatedMemories: [],
      parseError: "invalid_json",
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      newMemories: [],
      updatedMemories: [],
      parseError: "invalid_shape",
    };
  }

  if (Array.isArray(parsed.memories)) {
    return {
      newMemories: [],
      updatedMemories: [],
      parseError: "legacy_shape_not_supported",
    };
  }

  if (!Array.isArray(parsed.new) || !Array.isArray(parsed.updated)) {
    return {
      newMemories: [],
      updatedMemories: [],
      parseError: "invalid_shape",
    };
  }

  const newMemories = [];
  for (const item of parsed.new) {
    const normalized = normalizeNewMemory(item);
    if (!normalized) {
      return {
        newMemories: [],
        updatedMemories: [],
        parseError: "invalid_new_entry",
      };
    }
    newMemories.push(normalized);
  }

  const updatedMemories = [];
  for (const item of parsed.updated) {
    const normalized = normalizeUpdatedMemory(item);
    if (!normalized) {
      return {
        newMemories: [],
        updatedMemories: [],
        parseError: "invalid_updated_entry",
      };
    }
    updatedMemories.push(normalized);
  }

  return {
    newMemories,
    updatedMemories,
    parseError: null,
  };
}

function normalizeNewMemory(memory) {
  if (!memory || typeof memory !== "object") {
    return null;
  }

  const sourceMessageIndex = Number.parseInt(memory.source_message_index, 10);
  const text = typeof memory.text === "string" ? memory.text.trim() : "";
  if (!Number.isInteger(sourceMessageIndex) || sourceMessageIndex < 0 || !text) {
    return null;
  }

  return {
    sourceMessageIndex,
    text,
    importance: memory.importance,
    category: typeof memory.category === "string" && memory.category.trim() ? memory.category.trim() : null,
    eventTime: typeof memory.eventTime === "string" && memory.eventTime.trim() ? memory.eventTime.trim() : null,
  };
}

function normalizeUpdatedMemory(memory) {
  if (!memory || typeof memory !== "object") {
    return null;
  }

  const sourceMessageIndex = Number.parseInt(memory.source_message_index, 10);
  const oldMemoryId = typeof memory.old_memory_id === "string" ? memory.old_memory_id.trim() : "";
  const text = typeof memory.text === "string" ? memory.text.trim() : "";
  if (!Number.isInteger(sourceMessageIndex) || sourceMessageIndex < 0 || !oldMemoryId || !text) {
    return null;
  }

  return {
    sourceMessageIndex,
    oldMemoryId,
    text,
    importance: memory.importance,
    category: typeof memory.category === "string" && memory.category.trim() ? memory.category.trim() : null,
    eventUpdateTime:
      typeof memory.eventUpdateTime === "string" && memory.eventUpdateTime.trim()
        ? memory.eventUpdateTime.trim()
        : null,
  };
}

function normalizeImportanceToUnit(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (numeric >= 0 && numeric <= 1) {
    return Number(numeric.toFixed(4));
  }
  if (numeric > 1 && numeric <= 10) {
    return Number((numeric / 10).toFixed(4));
  }

  return null;
}

function formatTimestamp(value) {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

function summarizeMemoryMetadata(memories, fieldName) {
  const values = new Set();
  for (const memory of memories) {
    const value = memory?.entry?.[fieldName];
    if (typeof value === "string" && value.trim()) {
      values.add(value.trim());
    }
  }
  return Array.from(values).slice(0, 20);
}

export { createMemoryService };
