import { ZepClient } from "@getzep/zep-cloud";

function createZepAdapter({ config, logger }) {
  const adapterLogger = logger.child({ component: "zep-adapter" });
  const enabled = config.memory.zepEnabled !== false && config.memory.mode !== "off";
  let client = null;

  if (enabled && config.memory.zep.apiKey) {
    client = new ZepClient({
      apiKey: config.memory.zep.apiKey,
      baseUrl: config.memory.zep.baseUrl,
    });
  }

  async function upsertFacts({ scopeKey, facts }) {
    if (!enabled || !client || !Array.isArray(facts) || facts.length === 0) {
      return 0;
    }

    let updated = 0;
    for (const fact of facts) {
      const payload = {
        userId: scopeKey,
        fact: fact.text,
        factName: normalizeFactName(fact.predicate || "RELATED_TO"),
        sourceNodeName: fact.subject || scopeKey,
        targetNodeName: fact.object || fact.text,
        sourceNodeSummary: fact.text,
        targetNodeSummary: fact.text,
        edgeAttributes: {
          factKey: fact.factKey,
          messageId: fact.messageId,
          confidence: fact.confidence,
          category: fact.category,
          version: fact.version,
          status: fact.status,
          source: "sage",
        },
        createdAt: fact.ingestedAt,
        validAt: fact.eventTime || undefined,
      };
      await client.graph.addFactTriple(payload);
      updated += 1;
    }
    return updated;
  }

  async function search({ scopeKey, query, limit }) {
    if (!enabled || !client || !query) {
      return [];
    }
    try {
      const response = await client.graph.search({
        userId: scopeKey,
        query,
        limit,
      });
      const edges = Array.isArray(response?.edges) ? response.edges : [];
      return mapSearchEdges(edges, limit);
    } catch (error) {
      if (isZepNotFound(error)) {
        adapterLogger.warn(
          {
            statusCode: error?.statusCode,
            scopeKey,
          },
          "Zep graph.search returned 404; falling back to edge.getByUserId"
        );
        const edgeLimit = Math.max(Number(limit) || 20, 20);
        const fallbackEdges = await client.graph.edge.getByUserId(scopeKey, {
          limit: edgeLimit,
        });
        return mapFallbackEdges(fallbackEdges, query, edgeLimit);
      }
      throw error;
    }
  }

  async function ping() {
    if (!enabled || !client) {
      return "DISABLED";
    }
    await client.graph.listAll({ pageSize: 1 });
    return "OK";
  }

  return {
    enabled,
    upsertFacts,
    search,
    ping,
  };
}

function normalizeFactName(name) {
  const normalized = String(name || "RELATED_TO")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();
  return normalized || "RELATED_TO";
}

function isZepNotFound(error) {
  return Number(error?.statusCode) === 404;
}

function mapSearchEdges(edges, limit) {
  const safeEdges = Array.isArray(edges) ? edges : [];
  return safeEdges.slice(0, Math.max(1, Number(limit) || safeEdges.length)).map((edge) => ({
    text: edge?.fact || edge?.name || "",
    score: Number.isFinite(edge?.score) ? edge.score : null,
    source: "zep",
    relation: edge?.fact_name || edge?.name || null,
    metadata: edge?.attributes || null,
  }));
}

function mapFallbackEdges(edges, query, limit) {
  const safeEdges = Array.isArray(edges) ? edges : [];
  const terms = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const scored = safeEdges.map((edge) => {
    const text = String(edge?.fact || edge?.name || "").trim();
    if (!text) {
      return null;
    }
    const haystack = text.toLowerCase();
    const termMatches = terms.reduce(
      (acc, term) => (haystack.includes(term) ? acc + 1 : acc),
      0
    );
    const score = Number.isFinite(edge?.score)
      ? edge.score
      : Number((termMatches / Math.max(terms.length, 1)).toFixed(4));
    return {
      text,
      score,
      source: "zep",
      relation: edge?.name || null,
      metadata: edge?.attributes || null,
    };
  }).filter(Boolean);

  scored.sort((a, b) => (b.score || 0) - (a.score || 0));
  return scored.slice(0, Math.max(1, Number(limit) || scored.length));
}

export { createZepAdapter };
