// Deterministic retrieval scoring (spec §6). The PRIMARY signal is computed on
// the post-trim contextBlock (what the model would actually see), not the
// pre-trim buckets. Pre-trim buckets are recorded for diagnosis (MRR).

function markerPresent(block, marker) {
  return typeof block === "string" && block.includes(marker);
}

// Rank of the first required gold marker within the returned semanticMemories
// ordering (the bucket semanticTopK controls). 1/rank, or 0 if absent.
function computeMrr(semanticMemories, requiredMarkers) {
  if (!Array.isArray(semanticMemories) || requiredMarkers.length === 0) return 0;
  for (let i = 0; i < semanticMemories.length; i += 1) {
    const text = semanticMemories[i]?.text || "";
    if (requiredMarkers.some((m) => text.includes(m))) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

// Returns null for abstention (excluded from inner-loop scoring).
function scoreQuestion(retrieveResult, question) {
  if (question.type === "abstention") return null;
  const block = retrieveResult.contextBlock || "";
  const required = question.requiredMarkers || [];
  const forbidden = question.forbiddenMarkers || [];
  const presentRequired = required.filter((m) => markerPresent(block, m));
  const presentForbidden = forbidden.filter((m) => markerPresent(block, m));

  let recall;
  if (question.type === "temporal") {
    // binary: updated present AND stale absent
    const updatedPresent = presentRequired.length === required.length && required.length > 0;
    const stalePresent = presentForbidden.length > 0;
    recall = updatedPresent && !stalePresent ? 1 : 0;
  } else {
    recall = required.length === 0 ? 0 : presentRequired.length / required.length;
  }

  return {
    id: question.id,
    type: question.type,
    recall,
    mrr: computeMrr(retrieveResult.semanticMemories, required),
    tokens: Number(retrieveResult.contextTokenCount || 0),
    cacheHit: Boolean(retrieveResult.cacheHit),
    failed: Boolean(retrieveResult._failed),
    // NB: `partial` is true on every retrieve here because Zep (graph) is disabled
    // (partial = !graph.ok || ...). The meaningful timeout/warmup signal is
    // budgetExceeded (deadline exceeded). Gate logic keys on budgetExceeded.
    partial: Boolean(retrieveResult.partial),
    budgetExceeded: Boolean(retrieveResult.budgetExceeded),
    requiredMarkers: required,
    missingMarkers: required.filter((m) => !markerPresent(block, m)),
    staleLeaked: presentForbidden,
  };
}

// Resilient retrieve: transient Ollama/Qdrant latency spikes under sustained load
// can abort a single retrieve. Retry a few times; if all fail, return a synthetic
// empty result (counts as a miss) so one bad retrieve never crashes a grid/loop run.
// Only a timeout/deadline exhaustion is a true budget-exceeded; connection/auth/
// server errors are hard failures with different gate-diagnosis semantics.
function isBudgetExceededError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("deadline") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("budget")
  );
}

async function retrieveWithRetry(client, q, model, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await client.adminRetrieve({ query: q.query, scope: q.scope, model });
    } catch (error) {
      lastErr = error;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  return {
    contextBlock: "",
    semanticMemories: [],
    episodicSummaries: [],
    graphMemories: [],
    identityMemories: [],
    contextTokenCount: 0,
    partial: true,
    cacheHit: false,
    budgetExceeded: isBudgetExceededError(lastErr),
    _failed: true,
    _error: lastErr ? lastErr.message : "unknown",
  };
}

async function runPool(items, worker, concurrency = 5) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  // Clamp concurrency to a positive integer: 0/negative/NaN would produce zero
  // lanes and silently return an array of undefineds (no workers ever run).
  const laneCount = Math.max(
    1,
    Math.min(items.length, Number.isFinite(concurrency) ? Math.floor(concurrency) : 5)
  );
  let next = 0;
  async function lane() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }
  const lanes = Array.from({ length: laneCount }, () => lane());
  await Promise.all(lanes);
  return results;
}

/**
 * Score a question set against the CURRENT live config (caller applies config
 * first). Excludes abstention from the aggregate.
 */
async function scoreSet({ client, questions, model, concurrency = 5 }) {
  const scored = questions.filter((q) => q.type !== "abstention");
  const perQuestion = await runPool(
    scored,
    async (q) => {
      const res = await retrieveWithRetry(client, q, model);
      return scoreQuestion(res, q);
    },
    concurrency
  );

  const n = perQuestion.length;
  const sum = (sel) => perQuestion.reduce((acc, p) => acc + sel(p), 0);
  const meanRecall = n ? sum((p) => p.recall) / n : 0;
  const meanTokens = n ? sum((p) => p.tokens) / n : 0;
  const meanMrr = n ? sum((p) => p.mrr) / n : 0;
  const cacheHits = perQuestion.filter((p) => p.cacheHit).length;
  const partials = perQuestion.filter((p) => p.partial).length;
  const budgetExceededCount = perQuestion.filter((p) => p.budgetExceeded).length;
  const failed = perQuestion.filter((p) => p.failed).length;

  return {
    n,
    meanRecall,
    meanTokens,
    meanMrr,
    cacheHits,
    partials,
    budgetExceededCount,
    failed,
    perfectQuestions: perQuestion.filter((p) => p.recall >= 1).length,
    perQuestion,
  };
}

function computeUtility(agg, lambda) {
  // Cost term is MANDATORY: utility = mean(recall@ctx) - lambda * mean(contextTokenCount)
  return agg.meanRecall - lambda * agg.meanTokens;
}

export { scoreQuestion, scoreSet, computeUtility, computeMrr, markerPresent, runPool };
