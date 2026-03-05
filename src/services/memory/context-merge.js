import { encodingForModel, getEncoding } from "js-tiktoken";

function mergeMemoryBuckets({
  identityMemories = [],
  graphMemories = [],
  semanticMemories = [],
  episodicSummaries = [],
}) {
  return {
    identity: Array.isArray(identityMemories) ? identityMemories : [],
    graph: Array.isArray(graphMemories) ? graphMemories : [],
    semantic: Array.isArray(semanticMemories) ? semanticMemories : [],
    episodic: Array.isArray(episodicSummaries) ? episodicSummaries : [],
  };
}

function buildMemoryContextBlock({
  merged,
  modelId,
  maxTokens,
}) {
  const buckets = {
    identity: [...(merged?.identity || [])],
    graph: [...(merged?.graph || [])],
    semantic: [...(merged?.semantic || [])],
    episodic: [...(merged?.episodic || [])],
  };

  const formatter = () => formatBucketsAsContext(buckets);
  const trimOrder = ["episodic", "semantic", "graph"];
  let block = formatter();

  while (countTokens(block, modelId) > maxTokens && trimOrder.length > 0) {
    const bucketName = trimOrder[0];
    if (buckets[bucketName].length > 0) {
      buckets[bucketName].pop();
      block = formatter();
      continue;
    }
    trimOrder.shift();
  }

  if (countTokens(block, modelId) > maxTokens) {
    return "Memory context:\nIdentity memory is available but exceeds token budget.";
  }

  return block;
}

function formatBucketsAsContext(buckets) {
  const lines = ["Memory context:"];
  if (buckets.identity.length > 0) {
    lines.push("Identity memories:");
    for (const memory of buckets.identity) {
      lines.push(`- ${memory.text || ""}`);
    }
  } else {
    lines.push("Identity memories: (none)");
  }

  if (buckets.graph.length > 0) {
    lines.push("Graph facts:");
    for (const fact of buckets.graph) {
      lines.push(`- ${fact.text || ""}`);
    }
  } else {
    lines.push("Graph facts: (none)");
  }

  if (buckets.semantic.length > 0) {
    lines.push("Semantic memories:");
    for (const memory of buckets.semantic) {
      lines.push(`- ${memory.text || ""}`);
    }
  } else {
    lines.push("Semantic memories: (none)");
  }

  if (buckets.episodic.length > 0) {
    lines.push("Episodic summaries:");
    for (const item of buckets.episodic) {
      lines.push(`- ${item.text || ""}`);
    }
  } else {
    lines.push("Episodic summaries: (none)");
  }

  return lines.join("\n");
}

function countTokens(text, modelId) {
  const safeText = typeof text === "string" ? text : "";
  try {
    const encoding = encodingForModel(modelId || "gpt-4o-mini");
    return encoding.encode(safeText).length;
  } catch {
    try {
      const fallback = getEncoding("cl100k_base");
      return fallback.encode(safeText).length;
    } catch {
      return safeText.split(/\s+/).filter(Boolean).length;
    }
  }
}

export {
  buildMemoryContextBlock,
  mergeMemoryBuckets,
  countTokens,
};
