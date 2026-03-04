import {
  extractAssistantTextFromCompletion,
  extractTextContent,
} from "../http/serializers/openai-chat.js";
import { excerptText, textLength } from "../logging/safe-debug.js";

/**
 * Owns all long-term memory interactions so the rest of the app only needs to
 * ask for recalled context and trigger best-effort extraction after replies.
 */
function createMemoryService({ mnemosyneClient, openaiClient, config, logger }) {
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
      operationLogger.warn({ err: error }, "Memory recall failed; continuing without recalled memories");
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

  async function extractAndStoreMemories({ userMessage, assistantMessage, model, logger: requestLogger }) {
    if (!userMessage || !assistantMessage) {
      return 0;
    }

    const operationLogger = requestLogger || serviceLogger;
    const extractionModel = config.memory.extractionModel || model;
    operationLogger.debug(
      {
        extractionModel,
        userMessageLength: textLength(userMessage),
        assistantMessageLength: textLength(assistantMessage),
        userMessageExcerpt: excerptText(userMessage),
        assistantMessageExcerpt: excerptText(assistantMessage),
      },
      "Starting memory extraction"
    );

    try {
      const extractionResponse = await openaiClient.chat.completions.create({
        model: extractionModel,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: buildMemoryExtractionPrompt(),
          },
          {
            role: "user",
            content: `Conversation:\nUser: ${userMessage}\nSage: ${assistantMessage}`,
          },
        ],
      });

      const payload = extractAssistantTextFromCompletion(extractionResponse);
      const extractionResult = parseExtractedMemories(payload);
      const extractedMemories = extractionResult.memories;
      operationLogger.debug(
        {
          extractionModel,
          payloadLength: textLength(payload),
          parsedMemoryCount: extractedMemories.length,
          parseError: extractionResult.parseError,
          invalidEntryCount: extractionResult.invalidEntryCount,
        },
        "Parsed memory extraction payload"
      );
      if (extractedMemories.length === 0) {
        operationLogger.info({ extractionModel }, "No long-term memories were extracted from the completion");
        return 0;
      }

      let storedCount = 0;
      for (const memory of extractedMemories) {
        operationLogger.debug(
          {
            memoryTextExcerpt: excerptText(memory.text),
            memoryTextLength: textLength(memory.text),
            importance: memory.importance,
            category: memory.category,
            hasEventTime: Boolean(memory.eventTime),
          },
          "Attempting to store extracted memory"
        );
        try {
          await mnemosyneClient.store({
            text: memory.text,
            ...(memory.importance !== null ? { importance: memory.importance } : {}),
            ...(memory.category ? { category: memory.category } : {}),
            ...(memory.eventTime ? { eventTime: memory.eventTime } : {}),
          });
          storedCount += 1;
        } catch (error) {
          operationLogger.warn({ err: error }, "Failed to store an extracted memory");
        }
      }

      operationLogger.info(
        { extractionModel, extractedCount: extractedMemories.length, storedCount },
        "Finished long-term memory extraction"
      );
      return storedCount;
    } catch (error) {
      operationLogger.warn({ err: error, extractionModel }, "Memory extraction failed");
      return 0;
    }
  }

  return {
    recallRelevantMemories,
    formatMemoryContext,
    extractAndStoreMemories,
    getMemoriesForTool,
    addMemoryFromTool,
  };

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
    await mnemosyneClient.store({
      text,
      ...(importance !== null && importance !== undefined ? { importance } : {}),
      ...(category ? { category } : {}),
      ...(eventTime ? { eventTime } : {}),
    });

    operationLogger.info(
      {
        textLength: textLength(text),
        importance,
        category,
        hasEventTime: Boolean(eventTime),
      },
      "Stored memory from tool call"
    );

    return {
      text,
      importance: importance ?? null,
      category: category ?? null,
      event_time: eventTime ?? null,
    };
  }
}

function buildMemoryExtractionPrompt() {
  return [
    "Evaluate whether the following conversation contains information worth storing in long-term memory.",
    'The assistant may be referred to as "Sage".',
    "Only store information that is persistent, useful in future conversations, and clarifies the user or Sage.",
    "Return JSON only in this format:",
    '{"memories":[{"text":"concise memory text","importance":1,"category":"category","eventTime":"ISO timestamp or null"}]}',
    "If nothing is worth remembering, return {\"memories\": []}.",
    "Each memory should be a single concise fact and importance must be an integer from 1 to 10.",
  ].join("\n");
}

function parseExtractedMemories(payload) {
  const raw = extractTextContent(payload).trim();
  if (!raw) {
    return {
      memories: [],
      parseError: null,
      invalidEntryCount: 0,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      memories: [],
      parseError: "invalid_json",
      invalidEntryCount: 0,
    };
  }

  const memories = Array.isArray(parsed) ? parsed : parsed?.memories;
  if (!Array.isArray(memories)) {
    return {
      memories: [],
      parseError: "invalid_shape",
      invalidEntryCount: 0,
    };
  }

  const normalizedMemories = memories
    .map((memory) => normalizeMemory(memory))
    .filter(Boolean);

  return {
    memories: normalizedMemories,
    parseError: null,
    invalidEntryCount: memories.length - normalizedMemories.length,
  };
}

function normalizeMemory(memory) {
  if (!memory || typeof memory !== "object") {
    return null;
  }

  const text = typeof memory.text === "string" ? memory.text.trim() : "";
  if (!text) {
    return null;
  }

  const importance = Number.parseInt(memory.importance, 10);

  return {
    text,
    importance: Number.isInteger(importance) && importance >= 1 && importance <= 10 ? importance : null,
    category: typeof memory.category === "string" && memory.category.trim() ? memory.category.trim() : null,
    eventTime: typeof memory.eventTime === "string" && memory.eventTime.trim() ? memory.eventTime.trim() : null,
  };
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
