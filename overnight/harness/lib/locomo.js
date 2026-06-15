// LoCoMo checkpoint (spec §7) — the real-benchmark validation that replaces
// night one's synthetic-only e2e checkpoint. Public, CC BY-NC 4.0 (internal eval
// only; never shipped). Lives in its OWN isolated collection/scope namespace so it
// never bleeds into the synthetic store.
//
// Two scoring signals:
//   1. Evidence-recall (FREE, deterministic): does the retrieved context contain the
//      gold `evidence` dia_ids? No model calls — run often.
//   2. Judged accuracy (CAPPED, billed): Sage retrieves -> a cheap CLOUD answerer
//      answers -> a LOCAL Qwen3 judge grades CORRECT/WRONG with a calibrated,
//      category-aware, semantic-equivalence prompt (LoCoMo-Refined methodology).
//      Answerer != judge. Only the answerer is billed.

import fs from "node:fs";
import { runPool } from "./score.js";

// Memory-relevant categories: 1=multi-hop, 2=temporal, 4=single-hop.
// Excluded: 3=open-domain knowledge (not memory), 5=adversarial (spec §7).
const MEMORY_CATEGORIES = new Set([1, 2, 4]);
const CATEGORY_NAME = { 1: "multi-hop", 2: "temporal", 4: "single-hop" };

function loadLocomo(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// Build the ingest list (scope per conversation, dia_id embedded in each turn so
// evidence-recall can match) and the filtered QA set for the first `numConvs`.
function buildLocomo({ data, runid, numConvs, qaPerConv = Infinity }) {
  const scopePrefix = `bench_locomo_${runid}`;
  const convs = data.slice(0, Math.min(numConvs, data.length));
  const ingests = [];
  const qas = [];
  const scopes = [];
  convs.forEach((sample, ci) => {
    const scope = `${scopePrefix}_${ci}`;
    scopes.push(scope);
    const conv = sample.conversation || {};
    const sessKeys = Object.keys(conv)
      .filter((k) => /^session_\d+$/.test(k))
      .sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]));
    let turn = 0;
    for (const sk of sessKeys) {
      const dt = conv[`${sk}_date_time`] || "";
      for (const t of conv[sk] || []) {
        const base = (t.text || "").trim();
        const cap = t.blip_caption ? ` [shared an image: ${t.blip_caption}]` : "";
        if (!base && !cap) continue;
        // dia_id bracket-tagged so evidence-recall matches it verbatim in the
        // retrieved contextBlock (cleanStoredText does NOT strip [dia:...]).
        const text = `[dia:${t.dia_id}] (${dt}) ${t.speaker}: ${base}${cap}`;
        ingests.push({ scope, conversationId: `${scope}__${sk}`, turnIndex: turn, text, dia_id: t.dia_id });
        turn += 1;
      }
    }
    let added = 0;
    for (const q of sample.qa || []) {
      if (!MEMORY_CATEGORIES.has(q.category)) continue;
      if (!Array.isArray(q.evidence) || q.evidence.length === 0) continue;
      if (added >= qaPerConv) break;
      qas.push({
        id: `locomo-${ci}-${added}`,
        scope,
        convIndex: ci,
        question: q.question,
        answer: String(q.answer ?? ""),
        evidence: q.evidence,
        category: q.category,
        categoryName: CATEGORY_NAME[q.category] || String(q.category),
      });
      added += 1;
    }
  });
  return { scopePrefix, scopes, ingests, qas };
}

async function retrieveOnce(client, qa, model, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await client.adminRetrieve({ query: qa.question, scope: qa.scope, model });
    } catch (error) {
      lastErr = error;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  return { contextBlock: "", semanticMemories: [], _failed: true, _error: lastErr?.message };
}

// Evidence-recall (FREE): fraction of each QA's gold evidence dia_ids present in
// the retrieved post-trim context. Caller applies the config first.
async function evidenceRecall({ client, qas, model, concurrency = 4 }) {
  const per = await runPool(
    qas,
    async (qa) => {
      const r = await retrieveOnce(client, qa, model);
      const block = r.contextBlock || "";
      const hits = qa.evidence.filter((d) => block.includes(`[dia:${d}]`));
      return {
        id: qa.id, category: qa.categoryName,
        evidenceRecall: qa.evidence.length ? hits.length / qa.evidence.length : 0,
        allPresent: hits.length === qa.evidence.length,
        failed: Boolean(r._failed),
      };
    },
    concurrency
  );
  const n = per.length;
  const mean = (sel) => (n ? per.reduce((a, p) => a + sel(p), 0) / n : 0);
  return {
    n,
    meanEvidenceRecall: mean((p) => p.evidenceRecall),
    fullRecallRate: mean((p) => (p.allPresent ? 1 : 0)),
    per,
  };
}

// Calibrated, category-aware, semantic-equivalence judge prompt (LoCoMo-Refined).
function judgePrompt(qa, answer) {
  return (
    `/no_think You are a strict but fair grader for a long-term conversational-memory QA ` +
    `benchmark (LoCoMo). Decide whether the MODEL ANSWER is correct given the GOLD ANSWER.\n\n` +
    `Grading rules (judge MEANING, not wording):\n` +
    `- Accept paraphrases and answers that contain the gold information without contradicting it.\n` +
    `- DATE/TIME: accept any unambiguous reference to the same date ("7 May 2023" = "May 7, 2023" = ` +
    `"5/7/2023"). If the gold is a full date, a year-only answer is WRONG; match the gold's granularity.\n` +
    `- NUMBERS: accept equivalent values/units.\n` +
    `- The model answer may add extra context; it is correct if the gold information is present and correct.\n` +
    `- WRONG if it omits the gold information, hedges without answering, or states a contradicting fact.\n` +
    `- Question category: ${qa.categoryName} (single-hop = one fact; multi-hop = must combine facts; ` +
    `temporal = a date/time or ordering).\n\n` +
    `Return ONLY a JSON object: {"verdict": "CORRECT" | "WRONG", "reason": "<one short clause>"}.\n\n` +
    `QUESTION: ${qa.question}\n` +
    `GOLD ANSWER: ${qa.answer}\n` +
    `MODEL ANSWER: ${answer}`
  );
}

async function judgeAnswer(ollama, judgeModel, qa, answer) {
  try {
    const { parsed } = await ollama.chatJson({
      model: judgeModel,
      temperature: 0,
      messages: [{ role: "user", content: judgePrompt(qa, answer) }],
    });
    const verdict = String(parsed?.verdict || "").toUpperCase();
    return { correct: verdict === "CORRECT", verdict, reason: parsed?.reason || "" };
  } catch (error) {
    return { correct: false, verdict: "ERROR", reason: error.message };
  }
}

// Judged accuracy (CAPPED, billed): Sage retrieves (current config) -> cloud
// answerer answers -> local Qwen3 judge grades. Sequential to honour the $ ceiling.
async function judgedAccuracy({
  sageClient, ollama, qas, answererModel, judgeModel, budgetState, rateInUsdPer1M, rateOutUsdPer1M, log = () => {},
}) {
  const results = [];
  for (const qa of qas) {
    if (budgetState.spendUsd >= budgetState.ceilingUsd) {
      budgetState.stoppedByCeiling = true;
      log(`  LoCoMo judged: $ ceiling reached ($${budgetState.spendUsd.toFixed(2)}) — stopping`);
      break;
    }
    let resp;
    try {
      resp = await sageClient.chatCompletion({
        model: answererModel,
        messages: [{ role: "user", content: qa.question }],
        chatId: qa.scope,
      });
    } catch (error) {
      results.push({ id: qa.id, category: qa.categoryName, error: error.message });
      continue;
    }
    const usage = resp.usage || {};
    const cost =
      ((usage.prompt_tokens || 0) / 1e6) * rateInUsdPer1M +
      ((usage.completion_tokens || 0) / 1e6) * rateOutUsdPer1M;
    budgetState.spendUsd += cost;
    budgetState.calls += 1;
    const answer = resp.choices?.[0]?.message?.content || "";
    const judged = await judgeAnswer(ollama, judgeModel, qa, answer);
    results.push({
      id: qa.id, category: qa.categoryName, correct: judged.correct,
      verdict: judged.verdict, reason: judged.reason, costUsd: cost,
    });
  }
  const graded = results.filter((r) => typeof r.correct === "boolean");
  return {
    n: graded.length,
    correct: graded.filter((r) => r.correct).length,
    accuracy: graded.length ? graded.filter((r) => r.correct).length / graded.length : null,
    results,
  };
}

export { loadLocomo, buildLocomo, evidenceRecall, judgedAccuracy, judgeAnswer, MEMORY_CATEGORIES };
