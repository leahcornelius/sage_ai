import crypto from "node:crypto";

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

    // Episodic turns are raw conversation events and must NEVER be semantically
    // merged with each other, so write the point DIRECTLY via mnemosy-ai's raw
    // QdrantDB handle (db.store), unconditionally. This is the proper fix for the
    // Experiment-3 merge bug (formerly behind the bench-only `episodicRawStore`
    // flag, now the only path).
    //
    // mnemosyneClient.store() routes through fullStorePipeline, which runs an
    // UNCONDITIONAL 0.85/0.92-cosine dedup/merge with no off switch (mnemosy-ai
    // dist/index.js:186-247): on a hit it keeps the LATER turn's text, soft-deletes
    // the earlier point, and overwrites its metadata (dropping scopeKey). The bury
    // mechanic plants gold early, so the gold is the merge loser — soft-deleted
    // before any retrieval runs. For N intentionally-similar distinct turns the
    // store collapses to far fewer live points. The raw path stores every turn as a
    // distinct live point and preserves metadata.scopeKey.
    //
    // KNOWN CONSEQUENCE (intentional, documented in MEMORY_CONTRACTS.md): the raw
    // path bypasses fullStorePipeline's bm25Index.addDocument (dist/index.js:293),
    // so raw-stored episodic points are VECTOR-ONLY — absent from the in-process
    // BM25 lexical index (which is private to mnemosy-ai and only re-bootstrapped
    // from Qdrant at client startup). Restoring episodic BM25 is a deferred,
    // harness-level spike (re-bootstrap post-populate), not done here.
    const vector = await mnemosyneClient.embeddings.embed(messageText);
    const cell = await mnemosyneClient.db.store(messageText, vector, {
      memoryType: "semantic",
      classification: "public",
      scope: "public",
      eventTime: timestamp,
      metadata,
    });
    const memoryId = cell?.id || null;
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
      const text = typeof rawFact?.text === "string" ? rawFact.text.trim() : "";
      if (!text) continue;

      const factKey =
        rawFact.factKey ||
        crypto.createHash("sha256").update(`${scopeKey}|${text.toLowerCase()}`).digest("hex");
      const version =
        Number.isInteger(rawFact.version) && rawFact.version > 0 ? rawFact.version : 1;
      const status = rawFact.status || "active";
      const category = rawFact.category || "semantic";
      const eventTime = rawFact.eventTime || null;
      const confidence = Number.isFinite(rawFact.confidence) ? rawFact.confidence : null;

      // CLEAN-FACT HYGIENE (Experiment 5 — resolves D3.1): embed the fact TEXT ONLY.
      // The previous path prepended ~7 structural tags ([scope][fact_key][version]…)
      // into the embedded string, polluting the vector exactly like the episodic
      // embedding-hygiene bug Exp2 fixed. Structural fields now live in the Qdrant
      // payload `metadata` (NOT embedded), so the cosine is driven by fact content
      // while scopeKey/factKey/etc. remain available for the scope filter.
      //
      // RAW STORE (Experiment 4 merge-bug fix, now applied to the semantic path):
      // write the point DIRECTLY via mnemosy-ai's raw db.store, bypassing
      // fullStorePipeline's UNCONDITIONAL 0.85/0.92 dedup/merge. The merge would
      // soft-delete distinct facts and overwrite metadata (dropping scopeKey) — both
      // corrupts the count and breaks the scope filter. Distinct atomic facts are NOT
      // duplicates: store every one as a live, scope-tagged point. They are tagged
      // metadata.memoryClass="semantic_fact" so they live in the same shared
      // collection as episodic turns and are returned by the scoped semantic search
      // (db.search filtered on metadata.scopeKey) IN ADDITION to the raw episodic ring
      // — the clean-fact layer the buried-gold experiment exists to test.
      const vector = await mnemosyneClient.embeddings.embed(text);
      const cell = await mnemosyneClient.db.store(text, vector, {
        memoryType: "semantic",
        classification: "public",
        scope: "public",
        ...(eventTime ? { eventTime } : {}),
        ...(confidence !== null ? { importance: confidence } : {}),
        metadata: {
          memoryClass: "semantic_fact",
          scopeKey,
          factKey,
          version,
          status,
          category,
          sourceMessageId: rawFact.sourceMessageId || rawFact.messageId || null,
          sourceTurnIds: Array.isArray(rawFact.sourceTurnIds) ? rawFact.sourceTurnIds : [],
          eventTime,
          ingestedAt: rawFact.ingestedAt || new Date().toISOString(),
          source: (rawFact.metadata && rawFact.metadata.source) || "local-cleanfact",
        },
      });

      // Keep identity-category facts available to getIdentityContext (unchanged behaviour).
      if (isIdentityCategory(category)) {
        canonicalFacts.set(`${scopeKey}|${factKey}`, { text, scopeKey, category });
      }

      results.push({
        memoryId: cell?.id || factKey,
        factId: rawFact.factId || factKey,
        factKey,
        version,
        status,
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

// NOTE (Experiment 5): the former normalizeFact / compareFacts / asTimestamp /
// normalizeConfidence helpers (mem0-era cross-fact conflict + versioning) were
// removed. The clean-fact path stores each distinct atomic fact as its own raw,
// scope-tagged point and does NOT run cross-fact conflict resolution — distinct
// atomic facts are not duplicates. See upsertSemanticFacts above.

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
