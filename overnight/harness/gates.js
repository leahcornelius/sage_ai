// Gates 0-3 (spec §8) + the §8.1 transient-retry policy.
//   Gate 0 (isolation): NEVER retried; any failure halts.
//   Gates 1-3 (mechanical): bounded auto-retry (<=3) ONLY on transient conditions
//     (async writes not settled, cold/partial warmup, transient backend errors).
//     Structural failures halt immediately (no retry, no config/code change).

import { HttpError } from "./lib/sage-client.js";
import { scoreSet, computeUtility } from "./lib/score.js";
import { verifyCompleteness, sleep } from "./lib/supervisor.js";

const CONFIG_KEYS = ["semanticTopK", "episodicTopK", "graphMaxResults", "contextMaxTokens"];
const NOISE_BAND_CAP = 0.02; // above this, scoring is unreliable -> structural halt

function fullConfig(c) {
  const out = {};
  for (const k of CONFIG_KEYS) out[k] = c[k];
  return out;
}

async function applyConfig(client, config) {
  return client.adminMemoryConfig(fullConfig(config));
}

async function evalConfig({ client, questions, model, lambda, config, concurrency }) {
  await applyConfig(client, config);
  const agg = await scoreSet({ client, questions, model, concurrency });
  return { config: fullConfig(config), agg, utility: computeUtility(agg, lambda) };
}

function isTransientError(err) {
  if (err instanceof HttpError) {
    if (err.status && err.status >= 500) return true;
    if (!err.status) return true; // network / abort / connection refused
  }
  return false;
}

// Mechanical-gate runner: retry ONLY on transient signals, max `attempts`.
async function runMechanicalGate(name, fn, { attempts = 3, log = () => {} }) {
  let lastEvidence = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fn(attempt);
      if (result.pass) {
        if (attempt > 1) result.retries = attempt - 1;
        return { name, ...result };
      }
      if (result.transient && attempt < attempts) {
        log(`  [${name}] transient: ${result.reason} — retry ${attempt}/${attempts - 1} after backoff`);
        await sleep(1500 * attempt);
        lastEvidence = result;
        continue;
      }
      // structural OR exhausted
      return { name, ...result, retries: attempt - 1 };
    } catch (error) {
      if (isTransientError(error) && attempt < attempts) {
        log(`  [${name}] transient error: ${error.message} — retry ${attempt}/${attempts - 1}`);
        await sleep(1500 * attempt);
        lastEvidence = { reason: error.message };
        continue;
      }
      return { name, pass: false, structural: true, reason: `error: ${error.message}`, retries: attempt - 1 };
    }
  }
  return { name, pass: false, structural: true, reason: "exhausted retries", evidence: lastEvidence };
}

// ---- Gate 0: isolation preflight (NO retry) -------------------------------
async function runGate0({ benchClient, qdrantBench, qdrantReal, collection, baseCollection, dataset, benchPort, realPort, scopePrefix, log }) {
  const checks = [];
  const fail = (reason, extra) => ({ name: "Gate0", pass: false, structural: true, reason, checks, ...extra });

  // 1) bench instance healthy; mem0 + zep disabled
  let health;
  try {
    health = await benchClient.health();
  } catch (error) {
    return fail(`bench Sage health unreachable: ${error.message}`);
  }
  checks.push({ check: "bench-health", ok: health?.status === "ok", health });
  if (health?.status !== "ok") return fail("bench Sage not healthy");
  const mem0Off = health.memory?.mem0?.status === "disabled";
  const zepOff = health.memory?.zep?.status === "disabled";
  checks.push({ check: "mem0-disabled", ok: mem0Off, status: health.memory?.mem0?.status });
  checks.push({ check: "zep-disabled", ok: zepOff, status: health.memory?.zep?.status });
  if (!mem0Off) return fail("mem0 is not disabled on the benchmark instance");
  if (!zepOff) return fail("zep is not disabled on the benchmark instance");

  // 2) isolated collection exists in the BENCH qdrant and NOT in the REAL qdrant
  let benchHas;
  let realHas;
  let realCols = [];
  try {
    benchHas = await qdrantBench.hasCollection(collection);
    realCols = await qdrantReal.listCollections();
    realHas = realCols.includes(collection);
  } catch (error) {
    return fail(`qdrant isolation probe failed: ${error.message}`);
  }
  const realHasAnyBench = realCols.some((n) => n.startsWith(baseCollection));
  checks.push({ check: "bench-qdrant-has-collection", ok: benchHas, collection });
  checks.push({ check: "real-qdrant-lacks-collection", ok: !realHas && !realHasAnyBench, realCollections: realCols });
  if (!benchHas) return fail(`bench collection ${collection} not found in isolated qdrant (${qdrantBench.url})`);
  if (realHas || realHasAnyBench) {
    return fail(`real qdrant (${qdrantReal.url}) contains a bench collection — isolation breached`);
  }

  // 3) isolated qdrant URL differs from the real one; bench port differs
  const distinctQdrant = qdrantBench.url !== qdrantReal.url;
  const distinctPort = String(benchPort) !== String(realPort);
  checks.push({ check: "distinct-qdrant-url", ok: distinctQdrant, bench: qdrantBench.url, real: qdrantReal.url });
  checks.push({ check: "distinct-port", ok: distinctPort, benchPort, realPort });
  if (!distinctQdrant) return fail("bench qdrant URL equals the real qdrant URL");
  if (!distinctPort) return fail(`bench port ${benchPort} equals real port ${realPort}`);

  // 4) effective collection is not the real one
  if (collection === "sage_mem_v2") return fail("effective collection is the real sage_mem_v2");

  // 5) no real user scope in generated data
  const badScopes = dataset.scopes.filter((s) => !s.startsWith(scopePrefix));
  checks.push({ check: "all-scopes-run-prefixed", ok: badScopes.length === 0, badScopes });
  if (badScopes.length > 0) return fail(`generated scopes not run-prefixed: ${badScopes.join(", ")}`);

  log("  Gate0 isolation: PASS");
  return { name: "Gate0", pass: true, checks };
}

// ---- Gate 1: non-degenerate / deterministic / complete / uncached ---------
async function runGate1({ client, dataset, model, baselineConfig, lambda, concurrency, log }) {
  return runMechanicalGate(
    "Gate1",
    async () => {
      // (a) populate-completeness at generous K (transient if writes not settled)
      const completeness = await verifyCompleteness({ client, dataset, model, concurrency });
      if (!completeness.complete) {
        return {
          pass: false,
          transient: true,
          reason: `not all gold markers retrievable yet (${completeness.missing.length} missing)`,
          evidence: { missing: completeness.missing.slice(0, 6) },
        };
      }

      // (b) baseline scoring twice for determinism + cacheHit + non-degeneracy
      const run1 = await evalConfig({ client, questions: dataset.dev, model, lambda, config: baselineConfig, concurrency });
      const run2 = await evalConfig({ client, questions: dataset.dev, model, lambda, config: baselineConfig, concurrency });

      // cold/timeout warmup -> transient retry (budgetExceeded, NOT partial:
      // partial is always true here because Zep/graph is disabled)
      if (run1.agg.budgetExceededCount > 0 || run2.agg.budgetExceededCount > 0) {
        return { pass: false, transient: true, reason: "budget exceeded on some retrievals (warmup)", evidence: { be1: run1.agg.budgetExceededCount, be2: run2.agg.budgetExceededCount } };
      }

      // uncached: structural if any cache hit
      if (run1.agg.cacheHits > 0 || run2.agg.cacheHits > 0) {
        return { pass: false, structural: true, reason: `cacheHit=true during scoring (cache not disabled): ${run1.agg.cacheHits}+${run2.agg.cacheHits}` };
      }

      // non-degenerate: not all-zero, not all-identical across questions
      const recalls = run1.agg.perQuestion.map((p) => p.recall);
      const allZero = recalls.every((r) => r === 0);
      const allIdentical = recalls.every((r) => r === recalls[0]);
      if (allZero) return { pass: false, structural: true, reason: "all-zero recall (degenerate)" };
      if (allIdentical) return { pass: false, structural: true, reason: `all-identical recall=${recalls[0]} (degenerate)` };

      // deterministic: utilities + per-question identical
      const noiseBand = Math.abs(run1.utility - run2.utility);
      const perQIdentical = recalls.every((r, i) => r === run2.agg.perQuestion[i].recall);
      let keepThreshold = 1e-6;
      let deterministic = noiseBand === 0 && perQIdentical;
      if (!deterministic) {
        if (noiseBand > NOISE_BAND_CAP) {
          return { pass: false, structural: true, reason: `non-transient determinism mismatch, noiseBand=${noiseBand.toFixed(5)} > ${NOISE_BAND_CAP}` };
        }
        keepThreshold = noiseBand + 1e-6; // widen beyond measured noise (spec §6)
        log(`  Gate1 noise band ${noiseBand.toFixed(6)} -> widened keepThreshold ${keepThreshold.toFixed(6)}`);
      }

      return {
        pass: true,
        evidence: {
          baselineUtility: run1.utility,
          meanRecall: run1.agg.meanRecall,
          meanTokens: run1.agg.meanTokens,
          meanMrr: run1.agg.meanMrr,
          deterministic,
          noiseBand,
          keepThreshold,
          cacheHits: 0,
          recallSpread: { min: Math.min(...recalls), max: Math.max(...recalls) },
        },
      };
    },
    { log }
  );
}

// ---- Gate 2: knobs change retrieval behaviour -----------------------------
async function runGate2({ client, dataset, model, log }) {
  return runMechanicalGate(
    "Gate2",
    async () => {
      const q = dataset.gate2.question;
      const lowK = { semanticTopK: 1, episodicTopK: 0, graphMaxResults: 20, contextMaxTokens: 4000 };
      const highK = { semanticTopK: 30, episodicTopK: 0, graphMaxResults: 20, contextMaxTokens: 4000 };

      await applyConfig(client, lowK);
      const r1 = await client.adminRetrieve({ query: q.query, scope: q.scope, model });
      await applyConfig(client, highK);
      const r2 = await client.adminRetrieve({ query: q.query, scope: q.scope, model });

      if (r1.budgetExceeded || r2.budgetExceeded) {
        return { pass: false, transient: true, reason: "budget exceeded (warmup)" };
      }
      if (r1.cacheHit || r2.cacheHit) {
        return { pass: false, structural: true, reason: "cacheHit=true (cache masking knob effect)" };
      }

      const lenChanged = (r1.semanticMemories?.length || 0) !== (r2.semanticMemories?.length || 0);
      const tokChanged = r1.contextTokenCount !== r2.contextTokenCount;
      const gold = q.requiredMarkers[0];
      const goldAt1 = (r1.contextBlock || "").includes(gold);
      const goldAt30 = (r2.contextBlock || "").includes(gold);
      const recallChanged = goldAt1 !== goldAt30;

      const changed = lenChanged || tokChanged || recallChanged;
      const evidence = {
        lowK: { len: r1.semanticMemories?.length, tokens: r1.contextTokenCount, goldPresent: goldAt1 },
        highK: { len: r2.semanticMemories?.length, tokens: r2.contextTokenCount, goldPresent: goldAt30 },
        lenChanged, tokChanged, recallChanged,
      };
      if (!changed) {
        return { pass: false, structural: true, reason: "semanticTopK=1 vs 30 changed nothing (knob ignored or cache masking)", evidence };
      }
      return { pass: true, evidence };
    },
    { log }
  );
}

// ---- Gate 3: both keep and revert branches fire (forced candidates) -------
function decide(currentUtility, candidateUtility, keepThreshold) {
  return candidateUtility > currentUtility + keepThreshold ? "keep" : "revert";
}

async function runGate3({ client, dataset, model, lambda, keepThreshold, store, concurrency, log }) {
  return runMechanicalGate(
    "Gate3",
    async () => {
      const regressive = { semanticTopK: 0, episodicTopK: 0, graphMaxResults: 20, contextMaxTokens: 200 };
      const strong = { semanticTopK: 20, episodicTopK: 10, graphMaxResults: 20, contextMaxTokens: 4000 };

      const rEval = await evalConfig({ client, questions: dataset.dev, model, lambda, config: regressive, concurrency });
      const sEval = await evalConfig({ client, questions: dataset.dev, model, lambda, config: strong, concurrency });

      if (rEval.agg.budgetExceededCount > 0 || sEval.agg.budgetExceededCount > 0) {
        return { pass: false, transient: true, reason: "budget exceeded (warmup)" };
      }
      if (rEval.agg.cacheHits > 0 || sEval.agg.cacheHits > 0) {
        return { pass: false, structural: true, reason: "cacheHit=true during forced-candidate scoring" };
      }
      if (!(sEval.utility > rEval.utility + keepThreshold)) {
        return {
          pass: false,
          structural: true,
          reason: `strong config does not beat regressive (s=${sEval.utility.toFixed(4)} <= r=${rEval.utility.toFixed(4)}+thr) — knobs do not separate`,
          evidence: { strong: sEval.utility, regressive: rEval.utility },
        };
      }

      // Forced decisions exercise BOTH branches deterministically.
      const revertDecision = decide(sEval.utility, rEval.utility, keepThreshold); // expect revert
      const keepDecision = decide(rEval.utility, sEval.utility, keepThreshold); // expect keep

      // Record both in the archive as gate-forced candidates.
      store.appendArchive({
        iteration: "gate3-forced-revert", phase: "gate3", config: regressive,
        utility: rEval.utility, meanRecall: rEval.agg.meanRecall, meanTokens: rEval.agg.meanTokens,
        meanMrr: rEval.agg.meanMrr, parentUtility: sEval.utility, decision: revertDecision,
      });
      store.appendArchive({
        iteration: "gate3-forced-keep", phase: "gate3", config: strong,
        utility: sEval.utility, meanRecall: sEval.agg.meanRecall, meanTokens: sEval.agg.meanTokens,
        meanMrr: sEval.agg.meanMrr, parentUtility: rEval.utility, decision: keepDecision,
      });

      const bothFired = revertDecision === "revert" && keepDecision === "keep";
      const evidence = {
        regressiveUtility: rEval.utility, strongUtility: sEval.utility,
        revertDecision, keepDecision, keepThreshold,
      };
      if (!bothFired) {
        return { pass: false, structural: true, reason: `keep/revert did not both fire: ${JSON.stringify({ revertDecision, keepDecision })}`, evidence };
      }
      log(`  Gate3: revert(${rEval.utility.toFixed(4)}) + keep(${sEval.utility.toFixed(4)}) both fired`);
      return { pass: true, evidence };
    },
    { log }
  );
}

export { runGate0, runGate1, runGate2, runGate3, evalConfig, applyConfig, fullConfig, CONFIG_KEYS };
