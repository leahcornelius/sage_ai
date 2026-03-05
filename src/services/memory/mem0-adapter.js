import crypto from "node:crypto";

import { MemoryClient } from "mem0ai";

function createMem0Adapter({ config, logger }) {
  const adapterLogger = logger.child({ component: "mem0-adapter" });
  const enabled = config.memory.mem0Enabled !== false && config.memory.mode !== "off";
  let client = null;

  if (enabled && config.memory.mem0.apiKey) {
    client = new MemoryClient({
      apiKey: config.memory.mem0.apiKey,
      host: config.memory.mem0.baseUrl,
      organizationId: config.memory.mem0.organizationId || undefined,
      projectId: config.memory.mem0.projectId || undefined,
    });
  }

  async function extractFacts({
    scopeKey,
    conversationId,
    role,
    messageText,
    messageId,
    timestamp,
  }) {
    if (!enabled || !client || !messageText) {
      return [];
    }

    const response = await client.add(
      [
        {
          role,
          content: messageText,
        },
      ],
      {
        user_id: scopeKey,
        metadata: {
          conversation_id: conversationId,
          message_id: messageId,
          role,
          timestamp,
        },
      }
    );

    return normalizeMem0Facts({
      response,
      scopeKey,
      conversationId,
      role,
      messageText,
      messageId,
      timestamp,
    });
  }

  async function ping() {
    if (!enabled || !client) {
      return "DISABLED";
    }
    await client.ping();
    return "OK";
  }

  return {
    enabled,
    extractFacts,
    ping,
  };
}

function normalizeMem0Facts({
  response,
  scopeKey,
  conversationId,
  role,
  messageText,
  messageId,
  timestamp,
}) {
  if (!Array.isArray(response)) {
    return [];
  }

  return response
    .map((entry) => {
      const text = extractMemoryText(entry).trim();
      if (!text) {
        return null;
      }

      const predicate = inferPredicate(text);
      const objectValue = extractObjectValue(text);
      const category =
        Array.isArray(entry?.categories) && entry.categories.length > 0
          ? String(entry.categories[0])
          : "fact";

      return {
        factId: String(entry?.id || buildFactHash(`${scopeKey}|${text}`)),
        factKey: buildFactHash(`${scopeKey}|${predicate}|${objectValue}`),
        version: 1,
        status: "active",
        subject: scopeKey,
        predicate,
        object: objectValue,
        text,
        confidence: normalizeScore(entry?.score),
        category,
        eventTime: timestamp || null,
        scopeKey,
        role,
        conversationId,
        messageText,
        messageId,
        sourceMessageId: messageId,
        ingestedAt: new Date().toISOString(),
        metadata: {
          source: "mem0",
          mem0Hash: entry?.hash || null,
        },
      };
    })
    .filter(Boolean);
}

function extractMemoryText(entry) {
  if (typeof entry?.memory === "string") {
    return entry.memory;
  }
  if (typeof entry?.data?.memory === "string") {
    return entry.data.memory;
  }
  return "";
}

function inferPredicate(text) {
  const normalized = text.toLowerCase();
  if (normalized.includes("prefers")) {
    return "PREFERS";
  }
  if (normalized.includes("likes")) {
    return "LIKES";
  }
  if (normalized.includes("works")) {
    return "WORKS_AT";
  }
  return "KNOWS";
}

function extractObjectValue(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  const parts = compact.split(" ");
  return parts.slice(Math.max(1, parts.length - 4)).join(" ");
}

function normalizeScore(score) {
  if (!Number.isFinite(score)) {
    return null;
  }
  if (score <= 0) {
    return 0;
  }
  if (score >= 1) {
    return 1;
  }
  return Number(score.toFixed(4));
}

function buildFactHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export { createMem0Adapter };
