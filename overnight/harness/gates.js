// Gates 0-3 (spec §8) + the §8.1 transient-retry policy.
//   Gate 0 (isolation): NEVER retried; any failure halts.
//   Gates 1-3 (mechanical): bounded auto-retry (<=3) ONLY on transient conditions
//     (async writes not settled, cold/partial warmup, transient backend errors).
//     Structural failures halt immediately (no retry, no config/code change).

import { HttpError } from "./lib/sage-client.js";
import { scoreSet, scoreQuestion, computeUtility } from "./lib/score.js";
import { verifyCompleteness, sleep } from "./lib/supervisor.js";

const CONFIG_KEYS = ["semanticTopK", "episodicTopK", "graphMaxResults", "contextMaxTokens"];
const NOISE_BAND_CAP = 0.02; // above this, scoring is unreliable -> structural halt

function fullConfig(c) {
  const out = {};
  for (const k of CONFIG_KEYS) out[k] = c[k];
  // scopeFilter is the one boolean knob; send it as 0/1, default OFF when unset.
  out.scopeFilter = c.scopeFilter ? 1 : 0;
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
async function runGate0({ benchClient, qdrantBench, qdrantReal, collection, baseCollection, dataset, benchPort, realPort, scopePrefix, locomoCollection, locomoPort, log }) {
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

  // 4b) LoCoMo store isolation: its collection is distinct from the synthetic store
  // and the real store, lives in the isolated qdrant (not real), and runs on its own
  // port. (The LoCoMo Sage process/port is also verified at bring-up, §7.)
  if (locomoCollection) {
    const locomoDistinct =
      locomoCollection !== collection && locomoCollection !== "sage_mem_v2";
    const locomoNotReal = !realCols.includes(locomoCollection);
    const locomoPortDistinct =
      String(locomoPort) !== String(realPort) && String(locomoPort) !== String(benchPort);
    checks.push({ check: "locomo-collection-distinct", ok: locomoDistinct, locomoCollection, synthetic: collection });
    checks.push({ check: "locomo-not-in-real-qdrant", ok: locomoNotReal });
    checks.push({ check: "locomo-port-distinct", ok: locomoPortDistinct, locomoPort, benchPort, realPort });
    if (!locomoDistinct) return fail(`LoCoMo collection ${locomoCollection} collides with synthetic/real store`);
    if (!locomoNotReal) return fail(`LoCoMo collection ${locomoCollection} already exists in the real qdrant`);
    if (!locomoPortDistinct) return fail(`LoCoMo port ${locomoPort} collides with bench/real port`);
  }

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
      const semanticEvidence = {
        lowK: { len: r1.semanticMemories?.length, tokens: r1.contextTokenCount, goldPresent: goldAt1 },
        highK: { len: r2.semanticMemories?.length, tokens: r2.contextTokenCount, goldPresent: goldAt30 },
        lenChanged, tokChanged, recallChanged,
      };
      if (!changed) {
        return { pass: false, structural: true, reason: "semanticTopK=1 vs 30 changed nothing (knob ignored or cache masking)", evidence: { semantic: semanticEvidence } };
      }

      // ---- scopeFilter toggle changes SEARCH behaviour (spec §6; V0.3) ----
      // Fixture: in-scope gold + same-attribute lookalikes in a SECOND scope. The toggle
      // now switches the search itself, not a post-filter: OFF = global recall over the
      // whole collection (cross-scope lookalikes appear); ON = a within-scope Qdrant
      // payload-filter search (only in-scope points), so the returned semantic
      // ids/length/tokens / gold-presence change (same crispness as the K check).
      const sfQ = dataset.scopeFilterGate.question;
      const sfOff = { semanticTopK: 10, episodicTopK: 0, graphMaxResults: 20, contextMaxTokens: 4000, scopeFilter: 0 };
      const sfOn = { ...sfOff, scopeFilter: 1 };
      await applyConfig(client, sfOff);
      const r3 = await client.adminRetrieve({ query: sfQ.query, scope: sfQ.scope, model });
      await applyConfig(client, sfOn);
      const r4 = await client.adminRetrieve({ query: sfQ.query, scope: sfQ.scope, model });
      if (r3.budgetExceeded || r4.budgetExceeded) {
        return { pass: false, transient: true, reason: "budget exceeded (scopeFilter warmup)" };
      }
      if (r3.cacheHit || r4.cacheHit) {
        return { pass: false, structural: true, reason: "cacheHit=true (cache masking scopeFilter effect)" };
      }
      const offTexts = (r3.semanticMemories || []).map((m) => m.text);
      const onTexts = (r4.semanticMemories || []).map((m) => m.text);
      const goldSf = sfQ.requiredMarkers[0];
      const sfLenChanged = offTexts.length !== onTexts.length;
      const sfSetChanged = JSON.stringify(offTexts) !== JSON.stringify(onTexts);
      const sfTokChanged = r3.contextTokenCount !== r4.contextTokenCount;
      const sfMrrChanged =
        ((r3.contextBlock || "").includes(goldSf)) !== ((r4.contextBlock || "").includes(goldSf));
      const sfChanged = sfLenChanged || sfSetChanged || sfTokChanged || sfMrrChanged;
      const scopeFilterEvidence = {
        off: { len: offTexts.length, tokens: r3.contextTokenCount },
        on: { len: onTexts.length, tokens: r4.contextTokenCount },
        sfLenChanged, sfSetChanged, sfTokChanged, sfMrrChanged,
      };
      if (!sfChanged) {
        return {
          pass: false, structural: true,
          reason: "scopeFilter off vs on changed nothing (flag inert)",
          evidence: { semantic: semanticEvidence, scopeFilter: scopeFilterEvidence },
        };
      }
      return { pass: true, evidence: { semantic: semanticEvidence, scopeFilter: scopeFilterEvidence } };
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

      // ---- scopeFilter forced toggle: exercise the NEW knob through the decision path ----
      // strong-scoped vs strong-unscoped; a decision is recorded either way (we do not
      // require scoped to win — that is the experiment's outcome, not a gate).
      const strongScoped = { ...strong, scopeFilter: 1 };
      const ssEval = await evalConfig({ client, questions: dataset.dev, model, lambda, config: strongScoped, concurrency });
      if (ssEval.agg.budgetExceededCount > 0) {
        return { pass: false, transient: true, reason: "budget exceeded (scopeFilter forced eval)" };
      }
      if (ssEval.agg.cacheHits > 0) {
        return { pass: false, structural: true, reason: "cacheHit during scopeFilter forced eval" };
      }
      const scopeFilterDecision = decide(sEval.utility, ssEval.utility, keepThreshold);
      store.appendArchive({
        iteration: "gate3-forced-scopefilter", phase: "gate3", config: fullConfig(strongScoped),
        utility: ssEval.utility, meanRecall: ssEval.agg.meanRecall, meanTokens: ssEval.agg.meanTokens,
        meanMrr: ssEval.agg.meanMrr, parentUtility: sEval.utility, decision: scopeFilterDecision,
      });

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
        scopeFilter: {
          unscopedUtility: sEval.utility, scopedUtility: ssEval.utility,
          decision: scopeFilterDecision,
        },
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

// ---- Gate 1b: the SCOPED semantic channel carries the gold (spec §5; V0.3 reframe) ---
// The linchpin, reframed for Experiment 3. Exp2 proved the UNFILTERED channel cannot
// surface a buried fact among homogeneous cross-scope lookalikes — that is the premise
// of scope-filtering, not a failure to fix. So Gate 1b now tests the channel actually
// being used: the within-scope payload-filter (scopeFilter ON). Its purpose is unchanged
// — prove SEMANTIC, not the 20-turn episodic buffer, does the work — at a GENEROUS
// contextMaxTokens (2000) so we measure channel attribution, not the cost-tuned trim.
// Deterministic, no model calls. Probes on the dev set:
//   A   = s5/e3  scopeFilter ON   (scoped, both channels)
//   B'  = s5/e0  scopeFilter ON   (scoped, semantic-isolated; episodic floors at 1
//                                  filler turn, which burial guarantees)
//   C   = s0/e3  scopeFilter OFF  (episodic-isolated; semanticTopK=0 returns [])
//   B_unscoped = s5/e0 scopeFilter OFF (unscoped semantic via the recall pipeline; the
//                                  contrast that defines the headline gap)
//   B_dbsearch_unscoped = raw unscoped db.search (harness control probe, measurement-only,
//                                  $0, NOT a pass/fail criterion): isolates the headline
//                                  gap into pure-scoping vs recall-pipeline effects.
// Floors on single-hop + temporal (multi reported separately: computeMrr ranks only the
// first marker, and multi needs ALL markers). On failure: HALT with the scoped-channel
// diagnosis. Do NOT fix-and-retry to force a pass.
const GATE1B = {
  contextMaxTokens: 2000,
  meanMrrAMin: 0.2,
  meanRecallBMin: 0.5,
  meanRecallCMax: 0.1,
  scopedGapMin: 0.3,
  attributionMin: 0.7,
};

// Control probe (measurement-only): raw unscoped vector search mirroring the ON path's
// db.search but WITHOUT the scope filter, scored identically to the live probes via
// scoreQuestion on a synthetic retrieve result. Same embedder (Ollama nomic-embed-text
// via /v1/embeddings) and same collection as Sage, so vectors share a space. $0, local,
// introduces no Sage/production behaviour. Returns a Map id -> { recall, mrr }.
async function dbSearchUnscopedProbe({ qdrant, collection, ollama, embedModel, questions, topK, log }) {
  const out = new Map();
  for (const q of questions) {
    let recall = 0;
    let mrr = 0;
    try {
      const [vector] = await ollama.embed({ model: embedModel, input: q.query });
      const hits = await qdrant.search(collection, vector, { limit: topK, minScore: 0.3 });
      const synthetic = {
        semanticMemories: hits.map((h) => ({ text: h.text })),
        contextBlock: hits.map((h) => h.text).join("\n"),
        contextTokenCount: 0,
      };
      const scored = scoreQuestion(synthetic, q);
      recall = scored?.recall ?? 0;
      mrr = scored?.mrr ?? 0;
    } catch (error) {
      log(`  [Gate1b control probe] ${q.id} raw db.search failed: ${error.message}`);
    }
    out.set(q.id, { recall, mrr });
  }
  return out;
}

async function runGate1b({ client, dataset, model, lambda, concurrency, qdrant, collection, ollama, embedModel = "nomic-embed-text", log }) {
  return runMechanicalGate(
    "Gate1b",
    async () => {
      const cm = GATE1B.contextMaxTokens;
      const cfgA = { semanticTopK: 5, episodicTopK: 3, graphMaxResults: 20, contextMaxTokens: cm, scopeFilter: 1 }; // scoped, both
      const cfgB = { ...cfgA, episodicTopK: 0 }; // B': scoped, semantic-isolated
      const cfgC = { ...cfgA, semanticTopK: 0, scopeFilter: 0 }; // episodic-isolated (unscoped; sf moot at s0)
      const cfgBu = { ...cfgA, episodicTopK: 0, scopeFilter: 0 }; // B_unscoped: unscoped semantic via the recall pipeline
      const dev = dataset.dev;

      const A = await evalConfig({ client, questions: dev, model, lambda, config: cfgA, concurrency });
      const B = await evalConfig({ client, questions: dev, model, lambda, config: cfgB, concurrency });
      const C = await evalConfig({ client, questions: dev, model, lambda, config: cfgC, concurrency });
      const Bu = await evalConfig({ client, questions: dev, model, lambda, config: cfgBu, concurrency });

      const runs = [A, B, C, Bu];
      if (runs.some((r) => r.agg.budgetExceededCount > 0)) {
        return { pass: false, transient: true, reason: "budget exceeded on some retrievals (warmup)" };
      }
      if (runs.some((r) => r.agg.cacheHits > 0)) {
        return { pass: false, structural: true, reason: "cacheHit=true during Gate1b scoring (cache not disabled)" };
      }

      const byId = (agg) => new Map(agg.perQuestion.map((p) => [p.id, p]));
      const Aq = byId(A.agg);
      const Bq = byId(B.agg);
      const Cq = byId(C.agg);
      const Buq = byId(Bu.agg);
      const floorQs = dev.filter(
        (q) => (q.type === "single" || q.type === "temporal") && q.requiredMarkers.length > 0
      );
      const meanOf = (qs, m, key) => {
        if (!qs.length) return 0;
        return qs.reduce((acc, q) => acc + (m.get(q.id)?.[key] ?? 0), 0) / qs.length;
      };

      const meanMrrA = meanOf(floorQs, Aq, "mrr");
      const meanRecallB = meanOf(floorQs, Bq, "recall"); // B' scoped semantic-only
      const meanRecallC = meanOf(floorQs, Cq, "recall");
      const meanRecallBu = meanOf(floorQs, Buq, "recall"); // B_unscoped

      // Control probe (measurement-only, $0, not a criterion): raw unscoped db.search.
      // pureScoping  = B' - B_dbsearch_unscoped (same db.search primitive, +/- the filter)
      // pipeline     = B_dbsearch_unscoped - B_unscoped (raw db.search vs recall pipeline's
      //                diversity-rerank/intent). Their sum is the headline gap B'-B_unscoped.
      const dbq = await dbSearchUnscopedProbe({ qdrant, collection, ollama, embedModel, questions: floorQs, topK: cfgB.semanticTopK, log });
      const meanRecallBdb = meanOf(floorQs, dbq, "recall");
      const pureScopingEffect = meanRecallB - meanRecallBdb;
      const pipelineEffect = meanRecallBdb - meanRecallBu;

      // per-question attribution (on scoped A): of recall_A==1 items, the fraction with
      // mrr_A>0 (guards the "recall present but MRR=0" pathology per-question).
      const recall1 = floorQs.filter((q) => (Aq.get(q.id)?.recall ?? 0) === 1);
      const attribution = recall1.length
        ? recall1.filter((q) => (Aq.get(q.id)?.mrr ?? 0) > 0).length / recall1.length
        : 0;

      // multi-hop reported separately (scoped)
      const multiQs = dev.filter((q) => q.type === "multi");
      const multiRecallA = meanOf(multiQs, Aq, "recall");
      const multiRecallB = meanOf(multiQs, Bq, "recall");

      // per-item ranks across all probes (evidence for the halt write-up)
      const perItem = floorQs.map((q) => ({
        id: q.id,
        type: q.type,
        A: { recall: Aq.get(q.id)?.recall ?? 0, mrr: Aq.get(q.id)?.mrr ?? 0 },
        Bprime: { recall: Bq.get(q.id)?.recall ?? 0, mrr: Bq.get(q.id)?.mrr ?? 0 },
        C: { recall: Cq.get(q.id)?.recall ?? 0 },
        Bunscoped: { recall: Buq.get(q.id)?.recall ?? 0, mrr: Buq.get(q.id)?.mrr ?? 0 },
        BdbsearchUnscoped: { recall: dbq.get(q.id)?.recall ?? 0, mrr: dbq.get(q.id)?.mrr ?? 0 },
      }));

      const scopedGap = meanRecallB - meanRecallBu; // the headline gap
      const criteria = {
        meanMrrA: meanMrrA >= GATE1B.meanMrrAMin,
        meanRecallB: meanRecallB >= GATE1B.meanRecallBMin,
        meanRecallC: meanRecallC <= GATE1B.meanRecallCMax,
        scopedGap: scopedGap >= GATE1B.scopedGapMin,
        attribution: attribution >= GATE1B.attributionMin,
      };
      const evidence = {
        configs: { A: fullConfig(cfgA), Bprime: fullConfig(cfgB), C: fullConfig(cfgC), Bunscoped: fullConfig(cfgBu) },
        meanMrrA,
        meanRecallBprime: meanRecallB,
        meanRecallC,
        meanRecallBunscoped: meanRecallBu,
        scopedGap,
        controlProbe: {
          meanRecallBdbsearchUnscoped: meanRecallBdb,
          pureScopingEffect,
          pipelineEffect,
          note: "measurement-only; raw unscoped db.search; NOT a pass/fail criterion",
        },
        attribution,
        recall1Count: recall1.length,
        multiRecallA,
        multiRecallBprime: multiRecallB,
        floorCount: floorQs.length,
        thresholds: GATE1B,
        criteria,
        perItem,
        offlinePreview: dataset.meta?.offlinePreview,
      };

      const passed = Object.values(criteria).every(Boolean);
      if (!passed) {
        const failed = Object.entries(criteria).filter(([, v]) => !v).map(([k]) => k);
        return {
          pass: false,
          structural: true,
          scopedChannelWeak: true,
          reason:
            `Gate1b (reframed, scoped channel) FAILED [${failed.join(", ")}]. ` +
            `scoped: mrrA=${meanMrrA.toFixed(3)} recallB'(scoped semantic)=${meanRecallB.toFixed(3)} ` +
            `recallC(episodic-only)=${meanRecallC.toFixed(3)} attrib=${attribution.toFixed(2)}; ` +
            `headline gap B'-B_unscoped=${scopedGap.toFixed(3)} (>=${GATE1B.scopedGapMin}); ` +
            `control B_dbsearch_unscoped=${meanRecallBdb.toFixed(3)} ` +
            `(pureScoping=${pureScopingEffect.toFixed(3)} pipeline=${pipelineEffect.toFixed(3)}). ` +
            `The within-scope payload-filter did not carry the gold in the live pipeline (the offline ` +
            `rank-1-2 evidence did not transfer) or the scoping gap is insufficient. ` +
            `Per the run rule: accept the halt, do NOT fix-and-retry.`,
          evidence,
        };
      }
      log(
        `  Gate1b (scoped): mrrA=${meanMrrA.toFixed(3)} recallB'=${meanRecallB.toFixed(3)} ` +
          `recallC=${meanRecallC.toFixed(3)} gap=${scopedGap.toFixed(3)} (Bdb=${meanRecallBdb.toFixed(3)} ` +
          `pureScope=${pureScopingEffect.toFixed(3)} pipe=${pipelineEffect.toFixed(3)}) attrib=${attribution.toFixed(2)}`
      );
      return { pass: true, evidence };
    },
    { log }
  );
}

export { runGate0, runGate1, runGate1b, runGate2, runGate3, evalConfig, applyConfig, fullConfig, CONFIG_KEYS };
