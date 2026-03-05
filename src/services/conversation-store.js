import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

function createConversationStore({ config, logger }) {
  const storeLogger = logger.child({ service: "conversation-store" });
  const dbPath = config.memory.conversationDbPath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_extracted_ua_count INTEGER NOT NULL DEFAULT 0,
      summary_text TEXT NOT NULL DEFAULT '',
      summary_through_ua_index INTEGER NOT NULL DEFAULT -1
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      conversation_id TEXT NOT NULL,
      message_order INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      message_json TEXT NOT NULL,
      ua_index INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, message_order),
      FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_messages_ua
      ON conversation_messages(conversation_id, ua_index);

    CREATE TABLE IF NOT EXISTS memory_generations (
      conversation_id TEXT NOT NULL,
      generation_order INTEGER NOT NULL,
      memory_id TEXT NOT NULL,
      source_message_index INTEGER NOT NULL,
      extraction_run INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      replaced_memory_id TEXT,
      memory_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, generation_order),
      FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_memory_generations_lookup
      ON memory_generations(conversation_id, source_message_index, is_active, generation_order);

    CREATE TABLE IF NOT EXISTS memory_extraction_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      batch_start_ua_index INTEGER NOT NULL,
      batch_end_ua_index INTEGER NOT NULL,
      extraction_model TEXT NOT NULL,
      summary_chars INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
    );
  `);

  const upsertConversationStmt = db.prepare(`
    INSERT INTO conversations (
      conversation_id, created_at, updated_at, last_extracted_ua_count, summary_text, summary_through_ua_index
    ) VALUES (?, ?, ?, 0, '', -1)
    ON CONFLICT(conversation_id) DO UPDATE SET updated_at = excluded.updated_at
  `);
  const getConversationStmt = db.prepare(`
    SELECT
      conversation_id AS conversationId,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_extracted_ua_count AS lastExtractedUaCount,
      summary_text AS summaryText,
      summary_through_ua_index AS summaryThroughUaIndex
    FROM conversations
    WHERE conversation_id = ?
  `);
  const deleteConversationMessagesStmt = db.prepare(`
    DELETE FROM conversation_messages WHERE conversation_id = ?
  `);
  const insertConversationMessageStmt = db.prepare(`
    INSERT INTO conversation_messages (
      conversation_id, message_order, role, content, message_json, ua_index, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const getMaxMessageOrderStmt = db.prepare(`
    SELECT MAX(message_order) AS maxOrder
    FROM conversation_messages
    WHERE conversation_id = ?
  `);
  const getMaxUaIndexStmt = db.prepare(`
    SELECT MAX(ua_index) AS maxUaIndex
    FROM conversation_messages
    WHERE conversation_id = ?
      AND ua_index IS NOT NULL
  `);
  const countUaMessagesStmt = db.prepare(`
    SELECT COUNT(*) AS total
    FROM conversation_messages
    WHERE conversation_id = ?
      AND ua_index IS NOT NULL
  `);
  const getUaMessageByIndexStmt = db.prepare(`
    SELECT
      ua_index AS uaIndex,
      role,
      content
    FROM conversation_messages
    WHERE conversation_id = ?
      AND ua_index = ?
    LIMIT 1
  `);
  const getUaMessagesInRangeStmt = db.prepare(`
    SELECT
      ua_index AS uaIndex,
      role,
      content
    FROM conversation_messages
    WHERE conversation_id = ?
      AND ua_index BETWEEN ? AND ?
    ORDER BY ua_index ASC
  `);
  const updateConversationProgressStmt = db.prepare(`
    UPDATE conversations
    SET
      last_extracted_ua_count = ?,
      summary_through_ua_index = ?,
      updated_at = ?
    WHERE conversation_id = ?
  `);
  const updateConversationSummaryStmt = db.prepare(`
    UPDATE conversations
    SET
      summary_text = ?,
      summary_through_ua_index = ?,
      updated_at = ?
    WHERE conversation_id = ?
  `);
  const insertExtractionRunStmt = db.prepare(`
    INSERT INTO memory_extraction_runs (
      conversation_id,
      batch_start_ua_index,
      batch_end_ua_index,
      extraction_model,
      summary_chars,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const getActiveMemoryGenerationsStmt = db.prepare(`
    SELECT
      conversation_id AS conversationId,
      generation_order AS generationOrder,
      memory_id AS memoryId,
      source_message_index AS sourceMessageIndex,
      extraction_run AS extractionRun,
      replaced_memory_id AS replacedMemoryId,
      memory_text AS memoryText,
      created_at AS createdAt
    FROM memory_generations
    WHERE conversation_id = ?
      AND is_active = 1
      AND source_message_index BETWEEN ? AND ?
    ORDER BY generation_order ASC
  `);
  const getNextGenerationOrderStmt = db.prepare(`
    SELECT COALESCE(MAX(generation_order), -1) + 1 AS nextGenerationOrder
    FROM memory_generations
    WHERE conversation_id = ?
  `);
  const insertMemoryGenerationStmt = db.prepare(`
    INSERT INTO memory_generations (
      conversation_id,
      generation_order,
      memory_id,
      source_message_index,
      extraction_run,
      is_active,
      replaced_memory_id,
      memory_text,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deactivateActiveGenerationByMemoryIdStmt = db.prepare(`
    UPDATE memory_generations
    SET is_active = 0
    WHERE conversation_id = ?
      AND memory_id = ?
      AND is_active = 1
  `);

  function ensureConversation(conversationId) {
    const now = new Date().toISOString();
    upsertConversationStmt.run(conversationId, now, now);
  }

  const replaceConversationMessagesTx = db.transaction(({ conversationId, messages }) => {
    ensureConversation(conversationId);
    const existing = getConversationStmt.get(conversationId);
    deleteConversationMessagesStmt.run(conversationId);

    let uaIndex = 0;
    for (let messageOrder = 0; messageOrder < messages.length; messageOrder += 1) {
      const message = messages[messageOrder];
      const isUa = message?.role === "user" || message?.role === "assistant";
      insertConversationMessageStmt.run(
        conversationId,
        messageOrder,
        message?.role || "user",
        typeof message?.content === "string" ? message.content : "",
        JSON.stringify(message || {}),
        isUa ? uaIndex : null,
        new Date().toISOString()
      );
      if (isUa) {
        uaIndex += 1;
      }
    }

    const clampedExtractedCount = Math.min(existing?.lastExtractedUaCount || 0, uaIndex);
    const clampedSummaryThrough = Math.min(
      existing?.summaryThroughUaIndex ?? -1,
      uaIndex - 1
    );
    updateConversationProgressStmt.run(
      clampedExtractedCount,
      clampedSummaryThrough,
      new Date().toISOString(),
      conversationId
    );
  });

  function replaceConversationMessagesFromClient({ conversationId, messages }) {
    replaceConversationMessagesTx({ conversationId, messages });
  }

  const appendAssistantMessageTx = db.transaction(({ conversationId, content }) => {
    ensureConversation(conversationId);
    const maxOrder = getMaxMessageOrderStmt.get(conversationId)?.maxOrder;
    const nextOrder = Number.isInteger(maxOrder) ? maxOrder + 1 : 0;
    const maxUaIndex = getMaxUaIndexStmt.get(conversationId)?.maxUaIndex;
    const nextUaIndex = Number.isInteger(maxUaIndex) ? maxUaIndex + 1 : 0;
    const now = new Date().toISOString();
    const message = {
      role: "assistant",
      content,
    };
    insertConversationMessageStmt.run(
      conversationId,
      nextOrder,
      "assistant",
      content,
      JSON.stringify(message),
      nextUaIndex,
      now
    );
    upsertConversationStmt.run(conversationId, now, now);
  });

  function appendAssistantMessage({ conversationId, content }) {
    appendAssistantMessageTx({ conversationId, content });
  }

  function getConversation(conversationId) {
    return (
      getConversationStmt.get(conversationId) || {
        conversationId,
        lastExtractedUaCount: 0,
        summaryText: "",
        summaryThroughUaIndex: -1,
      }
    );
  }

  function getUaMessageCount(conversationId) {
    return countUaMessagesStmt.get(conversationId)?.total || 0;
  }

  function getUaMessageByIndex({ conversationId, uaIndex }) {
    return getUaMessageByIndexStmt.get(conversationId, uaIndex) || null;
  }

  function getUaMessagesInRange({ conversationId, startIndex, endIndex }) {
    if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || endIndex < startIndex) {
      return [];
    }
    return getUaMessagesInRangeStmt.all(conversationId, startIndex, endIndex);
  }

  function updateConversationProgress({
    conversationId,
    lastExtractedUaCount,
    summaryThroughUaIndex,
  }) {
    updateConversationProgressStmt.run(
      lastExtractedUaCount,
      summaryThroughUaIndex,
      new Date().toISOString(),
      conversationId
    );
  }

  function updateConversationSummary({ conversationId, summaryText, summaryThroughUaIndex }) {
    updateConversationSummaryStmt.run(
      summaryText || "",
      Number.isInteger(summaryThroughUaIndex) ? summaryThroughUaIndex : -1,
      new Date().toISOString(),
      conversationId
    );
  }

  function createExtractionRun({
    conversationId,
    batchStartUaIndex,
    batchEndUaIndex,
    extractionModel,
    summaryChars,
  }) {
    const result = insertExtractionRunStmt.run(
      conversationId,
      batchStartUaIndex,
      batchEndUaIndex,
      extractionModel,
      summaryChars,
      new Date().toISOString()
    );
    return Number(result.lastInsertRowid);
  }

  function listActiveMemoryGenerationsBySourceRange({
    conversationId,
    windowStart,
    windowEnd,
  }) {
    if (windowEnd < windowStart) {
      return [];
    }
    return getActiveMemoryGenerationsStmt.all(conversationId, windowStart, windowEnd);
  }

  function addMemoryGeneration({
    conversationId,
    memoryId,
    sourceMessageIndex,
    extractionRun,
    replacedMemoryId = null,
    memoryText,
    isActive = true,
  }) {
    const nextGenerationOrder =
      getNextGenerationOrderStmt.get(conversationId)?.nextGenerationOrder || 0;
    insertMemoryGenerationStmt.run(
      conversationId,
      nextGenerationOrder,
      memoryId,
      sourceMessageIndex,
      extractionRun,
      isActive ? 1 : 0,
      replacedMemoryId,
      memoryText || "",
      new Date().toISOString()
    );
    return nextGenerationOrder;
  }

  function deactivateActiveGenerationsByMemoryId({ conversationId, memoryId }) {
    deactivateActiveGenerationByMemoryIdStmt.run(conversationId, memoryId);
  }

  function close() {
    db.close();
    storeLogger.info({ dbPath }, "Closed conversation store");
  }

  return {
    replaceConversationMessagesFromClient,
    appendAssistantMessage,
    getConversation,
    getUaMessageCount,
    getUaMessageByIndex,
    getUaMessagesInRange,
    updateConversationProgress,
    updateConversationSummary,
    createExtractionRun,
    listActiveMemoryGenerationsBySourceRange,
    addMemoryGeneration,
    deactivateActiveGenerationsByMemoryId,
    close,
  };
}

export { createConversationStore };
