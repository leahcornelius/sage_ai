function createMnemosyneAdapter({ mnemosyneClient, config, logger }) {
  const adapterLogger = logger.child({ component: "mnemosyne-adapter" });
  const enabled = config.memory.mode !== "off" && Boolean(mnemosyneClient);
  const seenMessageIds = new Set();
  const canonicalFacts = new Map();
  const recentEpisodicByScope = new Map();
  const maxEpisodicPerScope = 20;

  function rememberEpisodic(scopeKey, entry) {
    const entries = recentEpisodicByScope.get(scopeKey) || [];
    entries.push(entry);
    if (entries.length > maxEpisodicPerScope) {
      entries.splice(0, entries.length - maxEpisodicPerScope);
    }
    recentEpisodicByScope.set(scopeKey, entries);
  }

  async function hasMessageId(messageId) {
    if (!enabled || !messageId) {
      return false;
    }

    if (seenMessageIds.has(messageId)) {
      return true;
    }

    const recalled = await mnemosyneClient.recall({
      query: `message_id:${messageId}`,
      topK: 1,
    });
    const exists = Array.isArray(recalled)
      && recalled.some((entry) => String(entry?.entry?.text || "").includes(`message_id:${messageId}`));
    if (exists) {
      seenMessageIds.add(messageId);
    }
    return exists;
  }

  async function storeEpisodic({
    scopeKey,
    conversationId,
    role,
    messageText,
    messageId,
    turnIndex,
    timestamp,
  }) {
    if (!enabled || !messageText) {
      return null;
    }

    // Embedding hygiene: embed the CLEAN message content, not a boilerplate-laden
    // string. Previously the stored text prepended ~60-80 tokens of structural tags
    // ([scope][conversation][role][turn][message_id:HASH][timestamp]) which dominated
    // the semantic vector and made content-based recall ineffective (the durable
    // semantic channel could not surface a specific fact among similar ones). The
    // structural fields now live in `metadata` (a Qdrant payload, NOT embedded) so the
    // cosine is driven by content while scope/turn/etc. remain available — e.g. for
    // the scope filter, which reads metadata.scopeKey. This is a principled,
    // unconditional production fix (no flag): content should drive retrieval.
    const metadata = {
      memoryClass: "episodic",
      scopeKey,
      conversationId,
      role,
      turnIndex,
      messageId,
      timestamp,
    };

    let memoryId;
    if (config.memory.episodicRawStore) {
      // Raw episodic store (default OFF; benchmark-only). mnemosyneClient.store()
      // routes through fullStorePipeline, which runs an UNCONDITIONAL 0.85-cosine
      // dedup/merge (no config flag): on a hit it keeps the LATER turn's text,
      // soft-deletes the earlier point, and overwrites its metadata (dropping
      // scopeKey). For intentionally-similar distinct memories that collapses the
      // store and — because earlier-planted facts are the merge losers — deletes
      // them before any retrieval runs. Episodic turns are raw events that must
      // never be merged with each other, so write the point directly via the raw
      // QdrantDB handle mnemosy-ai exposes, embedding the clean content with the
      // same embedder. classification "public" -> the shared collection (where
      // recall/searchSemantic look); memoryType "semantic" matches how factual
      // turns classify, keeping the unfiltered recall arm comparable.
      const vector = await mnemosyneClient.embeddings.embed(messageText);
      const cell = await mnemosyneClient.db.store(messageText, vector, {
        memoryType: "semantic",
        classification: "public",
        scope: "public",
        eventTime: timestamp,
        metadata,
      });
      memoryId = cell?.id || null;
    } else {
      memoryId = await mnemosyneClient.store({
        text: messageText,
        category: "episodic",
        eventTime: timestamp,
        metadata,
      });
    }
    seenMessageIds.add(messageId);
    rememberEpisodic(scopeKey, {
      text: messageText,
      role,
      turnIndex,
      timestamp,
      messageId,
    });
    return memoryId;
  }

  async function upsertSemanticFacts({ scopeKey, facts }) {
    if (!enabled || !Array.isArray(facts) || facts.length === 0) {
      return [];
    }

    const results = [];
    for (const rawFact of facts) {
      const normalized = normalizeFact(rawFact, scopeKey, canonicalFacts);
      const storageText = [
        `[scope:${scopeKey}]`,
        `[fact_key:${normalized.factKey}]`,
        `[version:${normalized.version}]`,
        `[status:${normalized.status}]`,
        `[confidence:${normalized.confidence ?? "unknown"}]`,
        `[event_time:${normalized.eventTime || "unknown"}]`,
        `[ingested_at:${normalized.ingestedAt}]`,
        normalized.text,
      ].join(" ");

      const memoryId = await mnemosyneClient.store({
        text: storageText,
        category: normalized.category || "semantic",
        ...(normalized.eventTime ? { eventTime: normalized.eventTime } : {}),
        ...(normalized.confidence !== null ? { importance: normalized.confidence } : {}),
      });

      results.push({
        memoryId: memoryId || normalized.factId,
        factId: normalized.factId,
        factKey: normalized.factKey,
        version: normalized.version,
        status: normalized.status,
      });
    }

    return results;
  }

  async function searchSemantic({ scopeKey, query, topK, scopeFilter = false }) {
    if (!enabled || !query) {
      return [];
    }
    // scopeFilter selects between two semantic-recall paths that share the same
    // embedder/vector space, so the only difference is WHERE the search happens:
    //
    //   OFF (default): mnemosy-ai's recall() searches the whole shared collection
    //     with no scope param, so a different scope's lookalike can outrank the
    //     in-scope gold (cross-scope bleed). recall() honors `limit` (not `topK`),
    //     so pass limit=topK to make the semanticTopK knob control the count.
    //
    //   ON: search the Qdrant collection DIRECTLY, restricted to in-scope points
    //     via a payload filter on metadata.scopeKey (where storeEpisodic puts the
    //     scope — embedding hygiene moved it out of the embedded text). Within a
    //     scope the in-scope gold ranks high; globally it is swamped by ~similar
    //     cross-scope lookalikes that a post-filter could never recover (they keep
    //     the gold out of mnemosy-ai's candidate set entirely). mnemosy-ai exposes
    //     its own QdrantDB + embedder, so this reuses Sage's embedder (query and
    //     stored vectors share a space) with NO extra dependency. Raw vector search:
    //     no rerank/dedup/query-rewrite; minScore stays recall's 0.3 default
    //     (within-scope cosines clear it). Mirrors mnemosy-ai's own search(query,
    //     filters) helper, but limited to semanticTopK.
    let results;
    if (scopeFilter && scopeKey) {
      const vector = await mnemosyneClient.embeddings.embed(query);
      const collection = mnemosyneClient.config.sharedCollection;
      const hits = await mnemosyneClient.db.search(collection, vector, topK, 0.3, {
        "metadata.scopeKey": scopeKey,
      });
      results = Array.isArray(hits) ? hits : [];
    } else {
      const recalled = await mnemosyneClient.recall({ query, limit: topK, topK });
      results = Array.isArray(recalled) ? recalled : [];
    }
    return results.map((memory) => {
      const entry = memory?.entry || {};
      return {
        text: cleanStoredText(entry.text),
        source: "mnemosyne",
        memoryType: entry.memoryType || null,
        confidenceTag: entry.confidenceTag || null,
        decayStatus: entry.decayStatus || null,
        updatedAt: entry.updatedAt || null,
      };
    });
  }

  async function getIdentityContext({ scopeKey }) {
    if (!enabled) {
      return [];
    }

    const facts = [];
    for (const fact of canonicalFacts.values()) {
      if (fact.scopeKey !== scopeKey) {
        continue;
      }
      if (!isIdentityCategory(fact.category)) {
        continue;
      }
      facts.push({
        text: fact.text,
        source: "mnemosyne",
        category: fact.category,
      });
    }
    return facts;
  }

  async function hasScopeMemories({ scopeKey }) {
    if (!enabled || !scopeKey) {
      return false;
    }
    const recalled = await mnemosyneClient.recall({
      query: scopeKey,
      topK: 1,
    });
    return Array.isArray(recalled) && recalled.length > 0;
  }

  async function getEpisodicSummaries({ scopeKey, maxItems = 5 }) {
    const entries = recentEpisodicByScope.get(scopeKey) || [];
    return entries
      .slice(-Math.max(1, maxItems))
      .reverse()
      .map((item) => ({
        text: `${item.role} turn ${item.turnIndex}: ${item.text}`,
        source: "mnemosyne-episodic",
      }));
  }

  async function ping() {
    if (!enabled) {
      return "DISABLED";
    }
    await mnemosyneClient.recall({
      query: "healthcheck",
      topK: 1,
    });
    return "OK";
  }

  return {
    enabled,
    hasMessageId,
    storeEpisodic,
    upsertSemanticFacts,
    searchSemantic,
    getIdentityContext,
    hasScopeMemories,
    getEpisodicSummaries,
    ping,
  };
}

function normalizeFact(fact, scopeKey, canonicalFacts) {
  const now = new Date().toISOString();
  const normalized = {
    ...fact,
    scopeKey,
    ingestedAt: fact.ingestedAt || now,
    confidence: normalizeConfidence(fact.confidence),
    category: fact.category || "semantic",
    status: fact.status || "active",
    version: Number.isInteger(fact.version) && fact.version > 0 ? fact.version : 1,
    text: typeof fact.text === "string" ? fact.text.trim() : "",
  };

  const conflictKey = `${scopeKey}|${normalized.subject || ""}|${normalized.predicate || ""}`;
  const previous = canonicalFacts.get(conflictKey);
  if (!previous) {
    canonicalFacts.set(conflictKey, normalized);
    return normalized;
  }

  const winner = compareFacts(previous, normalized) >= 0 ? previous : normalized;
  if (winner === normalized) {
    normalized.version = previous.version + 1;
    normalized.status = "active";
    canonicalFacts.set(conflictKey, normalized);
    return normalized;
  }

  normalized.version = previous.version + 1;
  normalized.status = "conflict";
  return normalized;
}

function compareFacts(existing, incoming) {
  const existingEvent = asTimestamp(existing.eventTime);
  const incomingEvent = asTimestamp(incoming.eventTime);
  if (incomingEvent !== existingEvent) {
    return incomingEvent - existingEvent;
  }

  const existingIngested = asTimestamp(existing.ingestedAt);
  const incomingIngested = asTimestamp(incoming.ingestedAt);
  if (incomingIngested !== existingIngested) {
    return incomingIngested - existingIngested;
  }

  const existingConfidence = Number.isFinite(existing.confidence) ? existing.confidence : -1;
  const incomingConfidence = Number.isFinite(incoming.confidence) ? incoming.confidence : -1;
  if (incomingConfidence !== existingConfidence) {
    return incomingConfidence - existingConfidence;
  }

  return 0;
}

function asTimestamp(value) {
  if (!value) {
    return -1;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? -1 : date.getTime();
}

function normalizeConfidence(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

function isIdentityCategory(category) {
  const normalized = String(category || "").toLowerCase();
  return ["identity", "profile", "pinned", "long_term"].includes(normalized);
}

function cleanStoredText(text) {
  return String(text || "")
    .replace(/\[(scope|fact_key|version|status|confidence|event_time|ingested_at):[^\]]+\]\s*/g, "")
    .trim();
}

export { createMnemosyneAdapter };
