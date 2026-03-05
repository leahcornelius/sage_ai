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
    const response = await client.graph.search({
      userId: scopeKey,
      query,
      limit,
    });
    const edges = Array.isArray(response?.edges) ? response.edges : [];
    return edges.map((edge) => ({
      text: edge?.fact || edge?.name || "",
      score: Number.isFinite(edge?.score) ? edge.score : null,
      source: "zep",
      relation: edge?.fact_name || null,
      metadata: edge?.attributes || null,
    }));
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

export { createZepAdapter };
