// Overnight self-improving retrieval loop — orchestrator (spec §5/§6/§7/§8/§12).
//
// Phases:
//   --phase gates : generate -> launch bench Sage (epoch 1) -> Gate 0 -> populate
//                   -> Gates 1-3 -> (optional grid). Foreground; leaves Sage up.
//   --phase run   : adopt Sage -> grid (if pending) -> mutation loop + checkpoints
//                   -> reports. Detached overnight process.
//   --dry-run     : gates + grid + a few loop iters on the throwaway stack, then
//                   tears the bench Sage down. No detached launch, no model calls.
//
// Inner loop + grid are generation-free (zero model calls). The capped end-to-end
// checkpoint is the only model-calling step (60-run AND $40 ceiling, whichever first).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SageClient, QdrantClient } from "./lib/sage-client.js";
import { RunStore, readJson, writeJson, configKey } from "./lib/archive.js";
import { Rng } from "./lib/rng.js";
import { generateDataset } from "./generate.js";
import {
  benchEnv, launchSage, readBoot, isAlive, killSage, waitForHealth,
  populate, verifyCompleteness, sleep,
} from "./lib/supervisor.js";
import { runGate0, runGate1, runGate2, runGate3, evalConfig, applyConfig } from "./gates.js";
import { scoreSet, computeUtility } from "./lib/score.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RUNS_DIR = path.join(REPO_ROOT, "overnight", "runs");

const KNOB_BOUNDS = {
  semanticTopK: [1, 30],
  episodicTopK: [0, 20],
  contextMaxTokens: [200, 4000],
};
const GRID = {
  semanticTopK: [1, 3, 5, 10, 20, 30],
  episodicTopK: [0, 3, 10],
  contextMaxTokens: [400, 800, 1200, 2000, 4000],
};

// ---------------------------------------------------------------- args + log
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        a[key] = true;
      } else {
        a[key] = next;
        i += 1;
      }
    } else {
      a._.push(t);
    }
  }
  return a;
}

function makeLogger(logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const stream = fs.createWriteStream(logFile, { flags: "a" });
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    process.stdout.write(`${line}\n`);
    stream.write(`${line}\n`);
  };
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// ---------------------------------------------------------------- config object
function collectionFor(runid, epoch) {
  return `bench_${runid}_e${epoch}`;
}

function clamp(v, [lo, hi]) {
  return Math.max(lo, Math.min(hi, v));
}

function loadOrCreateCredential(store) {
  const p = path.join(store.runDir, "bench-credential.json");
  const existing = readJson(p);
  if (existing?.apiKey) return existing.apiKey;
  const apiKey = `bench-${crypto.randomUUID()}`;
  writeJson(p, { apiKey, createdAt: new Date().toISOString() });
  return apiKey;
}

function makeContext(args) {
  const phase = args["dry-run"] ? "dry" : args.phase || "dry";
  const isDry = phase === "dry";
  let runid = args.run;
  if (!runid) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
    runid = `r${stamp}_${crypto.randomBytes(2).toString("hex")}${isDry ? "_dry" : ""}`;
  }
  const runDir = path.join(RUNS_DIR, runid);
  const store = new RunStore(runDir);
  const log = makeLogger(path.join(store.logsDir, "loop.log"));
  const benchKey = loadOrCreateCredential(store);

  const benchPort = num(args["bench-port"], 8799);
  const realPort = num(args["real-port"], 8787);
  const qdrantBenchUrl = args["qdrant-bench"] || "http://127.0.0.1:6344";
  const qdrantRealUrl = args["qdrant-real"] || "http://127.0.0.1:6333";
  const cacheBenchUrl = args["cache-bench"] || "redis://127.0.0.1:6345";
  const graphBenchUrl = args["graph-bench"] || "redis://127.0.0.1:6346";

  return {
    phase, isDry, runid, runDir, store, log, benchKey,
    benchPort, realPort, qdrantBenchUrl, qdrantRealUrl, cacheBenchUrl, graphBenchUrl,
    scorerModel: args["score-model"] || "gpt-4o-mini", // stable tiktoken encoder for retrieval scoring
    checkpointModel: args["checkpoint-model"] || "gpt-5.2",
    seedDev: num(args["seed-dev"], 1337),
    seedHeldout: num(args["seed-heldout"], 7331),
    lambda: num(args.lambda, 0.00005),
    maxIterations: isDry ? num(args.iterations, 3) : num(args.iterations, 1000),
    wallClockMs: num(args["wall-clock-hours"], 8) * 3600 * 1000,
    convergence: num(args.convergence, 100),
    concurrency: num(args.concurrency, 3),
    grid: Boolean(args.grid),
    checkpointBudget: num(args["checkpoint-budget"], 60),
    checkpointCostCeilingUsd: num(args["checkpoint-cost-ceiling"], 40),
    checkpointThrottleIters: num(args["checkpoint-throttle"], 20),
    checkpointSliceSize: num(args["checkpoint-slice"], 8),
    // Conservative (upper-bound) gpt-5.2 rates so the $ ceiling triggers BEFORE
    // real spend reaches it. Logged for morning recompute.
    rateInUsdPer1M: num(args["rate-in"], 3),
    rateOutUsdPer1M: num(args["rate-out"], 15),
    noCheckpointModelCalls: Boolean(args["no-checkpoint-model-calls"]) || isDry,
    clients: {
      sage: new SageClient({ baseUrl: `http://127.0.0.1:${benchPort}`, apiKey: benchKey, model: args["score-model"] || "gpt-4o-mini" }),
      qdrantBench: new QdrantClient({ url: qdrantBenchUrl }),
      qdrantReal: new QdrantClient({ url: qdrantRealUrl }),
    },
  };
}

// ---------------------------------------------------------------- sage lifecycle
async function ensureSageUp(ctx, { state }) {
  const { store, runid, benchKey, benchPort, qdrantBenchUrl, cacheBenchUrl, graphBenchUrl, clients, log } = ctx;
  const boot = readBoot(store);
  const desiredCollection = collectionFor(runid, state.epoch);

  if (boot && boot.collection === desiredCollection && isAlive(boot.pid)) {
    try {
      await waitForHealth(clients.sage, { timeoutMs: 6000, intervalMs: 500 });
      return { restarted: false, boot };
    } catch {
      /* fall through to relaunch */
    }
  }

  // (Re)launch needed. If a prior boot existed and its process is gone, this is a
  // crash-restart: roll to a FRESH collection (re-ingest is message_id-deduped and
  // cannot rebuild the in-process episodic ring buffer).
  let restarted = false;
  if (boot && !isAlive(boot.pid)) {
    state.epoch += 1;
    state.restartCount = (state.restartCount || 0) + 1;
    restarted = true;
    log(`  bench Sage restart detected -> rolling to fresh collection epoch ${state.epoch}`);
  }
  const collection = collectionFor(runid, state.epoch);
  const env = benchEnv({
    collection, port: benchPort, benchKey,
    qdrantUrl: qdrantBenchUrl, cacheUrl: cacheBenchUrl, graphUrl: graphBenchUrl,
  });
  log(`  launching bench Sage (port ${benchPort}, collection ${collection})`);
  const newBoot = launchSage({ repoRoot: REPO_ROOT, env, store, port: benchPort, collection, epoch: state.epoch });
  await waitForHealth(clients.sage, { timeoutMs: 90000 });
  log(`  bench Sage healthy (pid ${newBoot.pid})`);
  return { restarted, boot: newBoot, fresh: !boot };
}

class HaltError extends Error {}

async function gate0OrHalt(ctx, { collection, dataset }) {
  const { clients, runid, benchPort, realPort, log } = ctx;
  const result = await runGate0({
    benchClient: clients.sage,
    qdrantBench: clients.qdrantBench,
    qdrantReal: clients.qdrantReal,
    collection,
    baseCollection: `bench_${runid}`,
    dataset,
    benchPort,
    realPort,
    scopePrefix: `benchuser_${runid}`,
    log,
  });
  ctx.store.writeState({ ...(ctx.store.readState() || {}), lastGate0: result });
  if (!result.pass) {
    throw new HaltError(`Gate 0 isolation FAILED: ${result.reason}`);
  }
  return result;
}

async function populateAndVerify(ctx, { dataset, collection }) {
  const { clients, scorerModel, concurrency, log } = ctx;
  const pointBefore = await clients.qdrantBench.pointCount(collection);
  log(`  populating ${dataset.ingests.length} facts into ${collection} (points before: ${pointBefore})`);
  const { ingested, errors } = await populate({ client: clients.sage, ingests: dataset.ingests, concurrency: Math.max(2, Math.floor(concurrency / 2)), log: () => {} });
  if (errors.length > 0) {
    log(`  WARN: ${errors.length} ingest errors (sample: ${errors[0]?.error})`);
  }
  // settle: poll completeness with bounded transient retries (spec §5/§8.1)
  let completeness = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await sleep(1500 * attempt);
    completeness = await verifyCompleteness({ client: clients.sage, dataset, model: scorerModel, concurrency });
    const pc = await clients.qdrantBench.pointCount(collection);
    log(`  populate settle attempt ${attempt}: points=${pc} complete=${completeness.complete} missing=${completeness.missing.length}`);
    if (completeness.complete) break;
  }
  if (!completeness || !completeness.complete) {
    throw new HaltError(`Populate incomplete: ${completeness ? completeness.missing.length : "?"} gold markers not retrievable at generous K`);
  }
  return { ingested, errors: errors.length, pointCount: await clients.qdrantBench.pointCount(collection) };
}

// ---------------------------------------------------------------- mutation
function randomConfig(rng, base) {
  return {
    semanticTopK: rng.int(...KNOB_BOUNDS.semanticTopK),
    episodicTopK: rng.int(...KNOB_BOUNDS.episodicTopK),
    contextMaxTokens: clamp(rng.int(2, 40) * 100, KNOB_BOUNDS.contextMaxTokens),
    graphMaxResults: base.graphMaxResults, // fixed (Zep off)
  };
}

function mutate(rng, parent, base) {
  const c = { ...parent, graphMaxResults: base.graphMaxResults };
  const knob = rng.choice(["semanticTopK", "episodicTopK", "contextMaxTokens"]);
  if (knob === "contextMaxTokens") {
    const step = (rng.int(1, 8)) * 50 * (rng.random() < 0.5 ? -1 : 1);
    c.contextMaxTokens = clamp(c.contextMaxTokens + step, KNOB_BOUNDS.contextMaxTokens);
  } else {
    const step = rng.int(1, 4) * (rng.random() < 0.5 ? -1 : 1);
    c[knob] = clamp(c[knob] + step, KNOB_BOUNDS[knob]);
  }
  return c;
}

function proposeCandidate({ runid, iteration, best, archive, base, noImprove }) {
  const rng = new Rng(`${runid}:propose:${iteration}`);
  // explore-on-stagnation: periodic random restart
  if (noImprove > 0 && noImprove % 25 === 0) {
    return { config: randomConfig(rng, base), parentUtility: null, mode: "restart" };
  }
  const exploit = rng.random() < 0.7;
  let parent = best.config;
  if (!exploit && archive.length > 0) {
    parent = rng.choice(archive).config || best.config;
  }
  return { config: mutate(rng, parent, base), parentUtility: best.utility, mode: exploit ? "exploit" : "explore" };
}

// ---------------------------------------------------------------- grid
async function runGrid(ctx, { dataset }) {
  const { clients, scorerModel, lambda, concurrency, store, log } = ctx;
  const done = new Set(store.readGrid().map((r) => configKey(r.config)));
  const configs = [];
  for (const s of GRID.semanticTopK) {
    for (const e of GRID.episodicTopK) {
      for (const c of GRID.contextMaxTokens) {
        configs.push({ semanticTopK: s, episodicTopK: e, contextMaxTokens: c, graphMaxResults: dataset.baseGraphMaxResults ?? 20 });
      }
    }
  }
  log(`  grid: ${configs.length} configs (${done.size} already done)`);
  let best = null;
  for (const grid of store.readGrid()) {
    if (!best || grid.utility > best.utility) best = grid;
  }
  let gridFailures = 0;
  for (const cfg of configs) {
    if (done.has(configKey(cfg))) continue;
    try {
      const { agg, utility } = await evalConfig({ client: clients.sage, questions: dataset.dev, model: scorerModel, lambda, config: cfg, concurrency });
      const rec = { phase: "grid", config: cfg, utility, meanRecall: agg.meanRecall, meanTokens: agg.meanTokens, meanMrr: agg.meanMrr, cacheHits: agg.cacheHits, failed: agg.failed };
      store.appendGrid(rec);
      if (!best || utility > best.utility) {
        best = rec;
        log(`  grid new best: ${configKey(cfg)} u=${utility.toFixed(4)} recall=${agg.meanRecall.toFixed(3)} tok=${agg.meanTokens.toFixed(0)}`);
      }
    } catch (error) {
      gridFailures += 1;
      log(`  grid eval ${configKey(cfg)} FAILED (skipping): ${error.message}`);
    }
  }
  if (gridFailures > 0) log(`  grid completed with ${gridFailures} skipped config(s)`);
  return best;
}

// ---------------------------------------------------------------- checkpoint
function isAbstentionAnswer(text) {
  return /\b(don'?t know|do not know|no (information|record|data|details)|not (sure|aware|able)|cannot (find|determine|locate)|unable to|no relevant)\b/i.test(text || "");
}

async function checkpointSlice(ctx, { config, questions, budgetState }) {
  const { clients, checkpointModel, rateInUsdPer1M, rateOutUsdPer1M, log } = ctx;
  await applyConfig(clients.sage, config);
  const results = [];
  for (const q of questions) {
    if (budgetState.spendUsd >= budgetState.ceilingUsd) {
      budgetState.stoppedByCeiling = true;
      log(`  checkpoint: $ ceiling reached ($${budgetState.spendUsd.toFixed(2)}) — stopping model calls`);
      break;
    }
    let resp;
    try {
      resp = await clients.sage.chatCompletion({ model: checkpointModel, messages: [{ role: "user", content: q.query }], chatId: q.scope });
    } catch (error) {
      results.push({ id: q.id, type: q.type, error: error.message });
      continue;
    }
    const usage = resp.usage || {};
    const cost = ((usage.prompt_tokens || 0) / 1e6) * rateInUsdPer1M + ((usage.completion_tokens || 0) / 1e6) * rateOutUsdPer1M;
    budgetState.spendUsd += cost;
    budgetState.calls += 1;
    const answer = resp.choices?.[0]?.message?.content || "";
    let correct;
    if (q.type === "abstention") {
      correct = isAbstentionAnswer(answer) && !/\b[0-9A-Z]{8}\b/.test(answer);
    } else {
      correct = q.requiredMarkers.every((m) => answer.includes(m));
    }
    results.push({ id: q.id, type: q.type, correct, costUsd: cost, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens });
  }
  const graded = results.filter((r) => typeof r.correct === "boolean");
  return {
    n: graded.length,
    correct: graded.filter((r) => r.correct).length,
    accuracy: graded.length ? graded.filter((r) => r.correct).length / graded.length : null,
    results,
  };
}

function heldoutCheckpointSlice(ctx, dataset) {
  // include abstention items in the e2e checkpoint
  return dataset.heldout.slice(0, ctx.checkpointSliceSize);
}

// ---------------------------------------------------------------- run status
function writeRunStatus(ctx, { state, best, gridBest, extra = {} }) {
  const { store, runid, benchPort, runDir } = ctx;
  const boot = readBoot(store) || {};
  const spend = state.checkpoint?.spendUsd || 0;
  const runs = state.checkpoint?.runs || 0;
  const lines = [
    "# RUN_STATUS.md — overnight retrieval loop",
    "",
    `- run id: ${runid}`,
    `- phase: ${ctx.phase}`,
    `- loop PID: ${process.pid}`,
    `- bench Sage PID: ${boot.pid || "?"} (port ${benchPort})`,
    `- bench collection: ${boot.collection || collectionFor(runid, state.epoch)} (epoch ${state.epoch})`,
    `- restartCount: ${state.restartCount || 0}`,
    `- iteration: ${state.iteration || 0} / ${ctx.maxIterations}`,
    `- best: ${best ? `${configKey(best.config)} utility=${best.utility.toFixed(4)}` : "n/a"}`,
    `- grid-best: ${gridBest ? `${configKey(gridBest.config)} utility=${gridBest.utility.toFixed(4)}` : "n/a"}`,
    `- checkpoint spend (CONSERVATIVE est, upper-bound): $${spend.toFixed(2)} / $${ctx.checkpointCostCeilingUsd} ceiling`,
    `- checkpoint runs: ${runs} / ${ctx.checkpointBudget}`,
    `- checkpoint model: ${ctx.checkpointModel} (rates in $${ctx.rateInUsdPer1M}/1M, out $${ctx.rateOutUsdPer1M}/1M)`,
    `- run dir: ${runDir}`,
    `- stdout/err: ${path.join(store.logsDir, "loop.out.log")} / ${path.join(store.logsDir, "loop.err.log")}`,
    `- sage logs: ${path.join(store.logsDir, "sage.out.log")} / sage.err.log`,
    "",
    "## resume",
    "```powershell",
    `node overnight/harness/loop.js --phase run --run ${runid}`,
    "```",
    "## stop",
    "```powershell",
    `Stop-Process -Id ${process.pid} -Force   # the loop`,
    `Stop-Process -Id ${boot.pid || "<sagePID>"} -Force   # the bench Sage`,
    "docker rm -f qdrant_bench redis_bench falkordb_bench   # throwaway backends",
    "```",
    ...(extra.note ? ["", `> ${extra.note}`] : []),
  ];
  fs.writeFileSync(path.join(runDir, "RUN_STATUS.md"), lines.join("\n"));
}

function writeGateFailure(ctx, { gate, reason, evidence }) {
  const { runDir, runid } = ctx;
  const body = [
    "# GATE_FAILURE.md",
    "",
    `Run ${runid} HALTED before launch — a gate did not pass. Nothing was launched.`,
    "",
    `- failed gate: **${gate}**`,
    `- reason: ${reason}`,
    "",
    "## evidence",
    "```json",
    JSON.stringify(evidence || {}, null, 2),
    "```",
    "",
    "## diagnosis / next step",
    "Review the evidence above and the loop log under logs/. The harness made no",
    "code/config changes to force a pass. Fix the root cause, then re-run the gates",
    `phase: \`node overnight/harness/loop.js --phase gates --run ${runid}\`.`,
  ].join("\n");
  fs.writeFileSync(path.join(runDir, "GATE_FAILURE.md"), body);
}

// ---------------------------------------------------------------- phases
async function snapshotBaseline(ctx) {
  // read-only GET of the live read-side knobs (before any mutation)
  const r = await fetch(`http://127.0.0.1:${ctx.benchPort}/admin/memory-config`, {
    headers: { authorization: `Bearer ${ctx.benchKey}` },
  });
  if (!r.ok) throw new Error(`GET /admin/memory-config -> ${r.status}`);
  const j = await r.json();
  return j.effective;
}

async function doGatesPhase(ctx, { dataset, state }) {
  const { store, log } = ctx;
  const up = await ensureSageUp(ctx, { state });
  const collection = collectionFor(ctx.runid, state.epoch);

  // Gate 0 — isolation BEFORE any write
  await gate0OrHalt(ctx, { collection, dataset });

  // snapshot baseline config (before any mutation)
  const baseline = await snapshotBaseline(ctx);
  dataset.baseGraphMaxResults = baseline.graphMaxResults;
  log(`  baseline config: ${JSON.stringify(baseline)}`);

  // populate once + completeness
  const pop = await populateAndVerify(ctx, { dataset, collection });
  log(`  populated: ${pop.ingested} ingests, ${pop.pointCount} points`);

  // Gate 1
  const g1 = await runGate1({ client: ctx.clients.sage, dataset, model: ctx.scorerModel, baselineConfig: baseline, lambda: ctx.lambda, concurrency: ctx.concurrency, log });
  if (!g1.pass) { writeGateFailure(ctx, { gate: "Gate 1", reason: g1.reason, evidence: g1.evidence }); throw new HaltError(`Gate 1: ${g1.reason}`); }
  const keepThreshold = g1.evidence.keepThreshold;
  log(`  Gate1 PASS (baselineUtility=${g1.evidence.baselineUtility.toFixed(4)}, deterministic=${g1.evidence.deterministic}, keepThreshold=${keepThreshold})`);

  // Gate 2
  const g2 = await runGate2({ client: ctx.clients.sage, dataset, model: ctx.scorerModel, log });
  if (!g2.pass) { writeGateFailure(ctx, { gate: "Gate 2", reason: g2.reason, evidence: g2.evidence }); throw new HaltError(`Gate 2: ${g2.reason}`); }
  log(`  Gate2 PASS (${JSON.stringify(g2.evidence)})`);

  // Gate 3
  const g3 = await runGate3({ client: ctx.clients.sage, dataset, model: ctx.scorerModel, lambda: ctx.lambda, keepThreshold, store, concurrency: ctx.concurrency, log });
  if (!g3.pass) { writeGateFailure(ctx, { gate: "Gate 3", reason: g3.reason, evidence: g3.evidence }); throw new HaltError(`Gate 3: ${g3.reason}`); }
  log(`  Gate3 PASS (${JSON.stringify(g3.evidence)})`);

  // restore baseline config after gate mutations
  await applyConfig(ctx.clients.sage, baseline);

  const manifest = {
    runid: ctx.runid,
    branch: process.env.GIT_BRANCH || "overnight/retrieval-loop-v0.1",
    commitSha: process.env.GIT_SHA || null,
    benchPort: ctx.benchPort,
    benchCollection: collection,
    qdrantBenchUrl: ctx.qdrantBenchUrl,
    seeds: { dev: ctx.seedDev, heldout: ctx.seedHeldout },
    setSizes: dataset.meta.counts,
    knobBounds: KNOB_BOUNDS,
    lambda: ctx.lambda,
    checkpoint: { budget: ctx.checkpointBudget, costCeilingUsd: ctx.checkpointCostCeilingUsd, model: ctx.checkpointModel, rateInUsdPer1M: ctx.rateInUsdPer1M, rateOutUsdPer1M: ctx.rateOutUsdPer1M },
    runCaps: { wallClockHours: ctx.wallClockMs / 3600000, maxIterations: ctx.maxIterations, convergence: ctx.convergence },
    baselineConfig: baseline,
    noiseBand: g1.evidence.noiseBand,
    keepThreshold,
    gates: { gate1: g1.evidence, gate2: g2.evidence, gate3: g3.evidence, gate1Retries: g1.retries || 0, gate2Retries: g2.retries || 0, gate3Retries: g3.retries || 0 },
    createdAt: new Date().toISOString(),
  };
  store.writeManifest(manifest);
  store.writeState({ ...state, baseline, keepThreshold, gatesPassed: true });
  writeJson(path.join(ctx.runDir, "gates-result.json"), { passed: true, gate1: g1, gate2: g2, gate3: g3 });
  log("GATES 0-3 PASS");
  return { baseline, keepThreshold, manifest };
}

async function doRunPhase(ctx) {
  const { store, log } = ctx;
  const dataset = readJson(path.join(ctx.runDir, "dataset.json"));
  if (!dataset) throw new HaltError("dataset.json missing — run the gates phase first");
  const manifest = store.readManifest();
  let state = store.readState() || {};
  state.epoch = state.epoch || 1;
  state.iteration = state.iteration || 0;
  state.restartCount = state.restartCount || 0;
  state.checkpoint = state.checkpoint || { runs: 0, spendUsd: 0, calls: 0, lastIter: -9999, stoppedByCeiling: false };
  const baseline = state.baseline || manifest.baselineConfig;
  const keepThreshold = state.keepThreshold ?? manifest.keepThreshold ?? 1e-6;
  dataset.baseGraphMaxResults = baseline.graphMaxResults;

  // adopt or relaunch Sage; re-run Gate 0 on any (re)launch; populate if needed
  const up = await ensureSageUp(ctx, { state });
  const collection = collectionFor(ctx.runid, state.epoch);
  await gate0OrHalt(ctx, { collection, dataset });
  const pc = await ctx.clients.qdrantBench.pointCount(collection);
  if (up.restarted || up.fresh || !pc) {
    await populateAndVerify(ctx, { dataset, collection });
  } else {
    const completeness = await verifyCompleteness({ client: ctx.clients.sage, dataset, model: ctx.scorerModel, concurrency: ctx.concurrency });
    if (!completeness.complete) await populateAndVerify(ctx, { dataset, collection });
  }

  // Write RUN_STATUS.md immediately (the grid below can take ~40 min) so the
  // status file exists from launch with PIDs + stop/resume commands.
  store.writeState(state);
  writeRunStatus(ctx, { state, best: store.readBest(), gridBest: null, extra: { note: "grid + loop starting" } });

  // grid (required comparison baseline)
  let gridBest = null;
  if (ctx.grid || store.readGrid().length > 0) {
    gridBest = await runGrid(ctx, { dataset });
  }

  // initialise / resume current + best
  await applyConfig(ctx.clients.sage, baseline);
  let best = store.readBest();
  let current;
  if (best) {
    current = state.current || best;
    log(`  resuming: best=${configKey(best.config)} u=${best.utility.toFixed(4)} at iter ${state.iteration}`);
  } else {
    const baseEval = await evalConfig({ client: ctx.clients.sage, questions: dataset.dev, model: ctx.scorerModel, lambda: ctx.lambda, config: baseline, concurrency: ctx.concurrency });
    best = { config: baseEval.config, utility: baseEval.utility, meanRecall: baseEval.agg.meanRecall, meanTokens: baseEval.agg.meanTokens, meanMrr: baseEval.agg.meanMrr, iteration: 0 };
    current = best;
    store.appendArchive({ iteration: 0, phase: "baseline", config: best.config, utility: best.utility, meanRecall: best.meanRecall, meanTokens: best.meanTokens, meanMrr: best.meanMrr, decision: "keep" });
    store.writeBest(best);
  }

  const startTime = Date.now();
  let noImprove = state.noImprove || 0;
  writeRunStatus(ctx, { state, best, gridBest });

  while (true) {
    if (state.iteration >= ctx.maxIterations) { log(`  STOP: iteration cap ${ctx.maxIterations}`); break; }
    if (Date.now() - startTime > ctx.wallClockMs) { log("  STOP: wall-clock cap"); break; }
    if (noImprove >= ctx.convergence) { log(`  STOP: convergence (${noImprove} no-improve)`); break; }

    state.iteration += 1;
    try {
      // restart-safe guard
      const guard = await ensureSageUp(ctx, { state });
      if (guard.restarted) {
        await gate0OrHalt(ctx, { collection: collectionFor(ctx.runid, state.epoch), dataset });
        await populateAndVerify(ctx, { dataset, collection: collectionFor(ctx.runid, state.epoch) });
        await applyConfig(ctx.clients.sage, current.config);
      }

      const archive = store.readArchive().filter((r) => r.config);
      const proposal = proposeCandidate({ runid: ctx.runid, iteration: state.iteration, best, archive, base: baseline, noImprove });
      const ev = await evalConfig({ client: ctx.clients.sage, questions: dataset.dev, model: ctx.scorerModel, lambda: ctx.lambda, config: proposal.config, concurrency: ctx.concurrency });

      if (ev.agg.cacheHits > 0) {
        log(`  WARN iter ${state.iteration}: cacheHit during scoring (unexpected)`);
      }
      const decision = ev.utility > current.utility + keepThreshold ? "keep" : "revert";
      if (decision === "keep") current = { config: ev.config, utility: ev.utility };

      let improved = false;
      if (ev.utility > best.utility + keepThreshold) {
        best = { config: ev.config, utility: ev.utility, meanRecall: ev.agg.meanRecall, meanTokens: ev.agg.meanTokens, meanMrr: ev.agg.meanMrr, iteration: state.iteration };
        store.writeBest(best);
        improved = true;
        noImprove = 0;
      } else {
        noImprove += 1;
      }

      store.appendArchive({
        iteration: state.iteration, phase: "loop", mode: proposal.mode, config: ev.config,
        utility: ev.utility, meanRecall: ev.agg.meanRecall, meanTokens: ev.agg.meanTokens, meanMrr: ev.agg.meanMrr,
        parentUtility: proposal.parentUtility, currentUtility: current.utility, decision,
      });

      // free held-out retrieval overfitting check (every 25 iters)
      if (state.iteration % 25 === 0) {
        await applyConfig(ctx.clients.sage, best.config);
        const ho = await scoreSet({ client: ctx.clients.sage, questions: dataset.heldout, model: ctx.scorerModel, concurrency: ctx.concurrency });
        const hoUtil = computeUtility(ho, ctx.lambda);
        log(`  [heldout-retrieval] iter ${state.iteration}: dev-best=${best.utility.toFixed(4)} heldout=${hoUtil.toFixed(4)} recall=${ho.meanRecall.toFixed(3)}`);
        store.appendArchive({ iteration: state.iteration, phase: "heldout-retrieval", config: best.config, utility: hoUtil, meanRecall: ho.meanRecall, meanTokens: ho.meanTokens, meanMrr: ho.meanMrr, decision: "check" });
        await applyConfig(ctx.clients.sage, current.config);
      }

      // capped e2e checkpoint (model calls) — only on improvement, throttled, under caps
      if (
        improved && !ctx.noCheckpointModelCalls &&
        state.checkpoint.runs < ctx.checkpointBudget - 2 &&
        state.checkpoint.spendUsd < ctx.checkpointCostCeilingUsd &&
        state.iteration - state.checkpoint.lastIter >= ctx.checkpointThrottleIters
      ) {
        state.checkpoint.runs += 1;
        state.checkpoint.lastIter = state.iteration;
        const budgetState = { spendUsd: state.checkpoint.spendUsd, ceilingUsd: ctx.checkpointCostCeilingUsd, calls: state.checkpoint.calls, stoppedByCeiling: false };
        const cp = await checkpointSlice(ctx, { config: best.config, questions: heldoutCheckpointSlice(ctx, dataset), budgetState });
        state.checkpoint.spendUsd = budgetState.spendUsd;
        state.checkpoint.calls = budgetState.calls;
        if (budgetState.stoppedByCeiling) state.checkpoint.stoppedByCeiling = true;
        log(`  [checkpoint] run ${state.checkpoint.runs}: best e2e acc=${cp.accuracy} (n=${cp.n}) spend~$${state.checkpoint.spendUsd.toFixed(2)}`);
        store.appendArchive({ iteration: state.iteration, phase: "checkpoint", config: best.config, e2eAccuracy: cp.accuracy, n: cp.n, decision: "check" });
        await applyConfig(ctx.clients.sage, current.config);
      }

      if (state.iteration % 10 === 0 || improved) {
        state.noImprove = noImprove;
        state.current = current;
        store.writeState(state);
        writeRunStatus(ctx, { state, best, gridBest });
      }
      if (state.iteration % 20 === 0 || improved) {
        log(`  iter ${state.iteration}: cand=${configKey(ev.config)} u=${ev.utility.toFixed(4)} ${decision}${improved ? " *BEST*" : ""} (best=${best.utility.toFixed(4)}, noImprove=${noImprove})`);
      }
    } catch (error) {
      log(`  iter ${state.iteration} ERROR (continuing): ${error.message}`);
      if (error instanceof HaltError) throw error;
      await sleep(2000);
    }
  }

  // ---- final apples-to-apples comparison + report
  try {
    await finalReport(ctx, { dataset, baseline, best, gridBest, state, startTime });
  } catch (error) {
    log(`  finalReport failed (continuing to clean exit): ${error.message}`);
  }

  // clean exit: restore baseline config (best-effort)
  try { await applyConfig(ctx.clients.sage, baseline); } catch { /* throwaway */ }
  store.writeArchiveSummary();
  store.writeState(state);
  log("RUN COMPLETE");
}

async function finalReport(ctx, { dataset, baseline, best, gridBest, state, startTime }) {
  const { clients, scorerModel, lambda, concurrency, store, log } = ctx;
  log("  computing final comparison (held-out retrieval + capped e2e checkpoints)");

  async function heldoutRetrieval(config) {
    await applyConfig(clients.sage, config);
    const agg = await scoreSet({ client: clients.sage, questions: dataset.heldout, model: scorerModel, concurrency });
    return { meanRecall: agg.meanRecall, meanTokens: agg.meanTokens, utility: computeUtility(agg, lambda) };
  }

  await applyConfig(clients.sage, baseline);
  const baseDevAgg = await scoreSet({ client: clients.sage, questions: dataset.dev, model: scorerModel, concurrency });
  const baselineDevUtility = computeUtility(baseDevAgg, lambda);

  const baselineHO = await heldoutRetrieval(baseline);
  const gridHO = gridBest ? await heldoutRetrieval(gridBest.config) : null;
  const loopHO = await heldoutRetrieval(best.config);

  // reserved final checkpoints (count against the 60 / $40 caps)
  const budgetState = { spendUsd: state.checkpoint.spendUsd, ceilingUsd: ctx.checkpointCostCeilingUsd, calls: state.checkpoint.calls, stoppedByCeiling: false };
  let gridCP = null;
  let loopCP = null;
  if (!ctx.noCheckpointModelCalls) {
    if (gridBest && state.checkpoint.runs < ctx.checkpointBudget && budgetState.spendUsd < ctx.checkpointCostCeilingUsd) {
      state.checkpoint.runs += 1;
      gridCP = await checkpointSlice(ctx, { config: gridBest.config, questions: heldoutCheckpointSlice(ctx, dataset), budgetState });
    }
    if (state.checkpoint.runs < ctx.checkpointBudget && budgetState.spendUsd < ctx.checkpointCostCeilingUsd) {
      state.checkpoint.runs += 1;
      loopCP = await checkpointSlice(ctx, { config: best.config, questions: heldoutCheckpointSlice(ctx, dataset), budgetState });
    }
  }
  state.checkpoint.spendUsd = budgetState.spendUsd;
  state.checkpoint.calls = budgetState.calls;

  let verdict = "n/a (grid not run)";
  if (gridBest) {
    const delta = best.utility - gridBest.utility;
    const thr = state.keepThreshold || 1e-6;
    if (delta > thr) verdict = "BEAT";
    else if (delta < -Math.max(thr, 0.005)) verdict = "UNDERPERFORMED";
    else verdict = "MATCHED";
  }

  const elapsedH = ((Date.now() - startTime) / 3600000).toFixed(2);
  const fmtCfg = (c) => `semanticTopK=${c.semanticTopK}, episodicTopK=${c.episodicTopK}, contextMaxTokens=${c.contextMaxTokens}, graphMaxResults=${c.graphMaxResults}`;
  const cpStr = (cp) => (cp ? `acc=${cp.accuracy == null ? "n/a" : cp.accuracy.toFixed(3)} (n=${cp.n})` : "skipped");

  const restartSection = (state.restartCount || 0) > 0
    ? [
        "",
        "## Bench-Sage restarts",
        `The bench Sage restarted **${state.restartCount}** time(s) during the run. On each restart the loop`,
        "rolled to a FRESH collection and full-re-populated (re-ingest into the same collection is",
        "`message_id`-deduped and cannot rebuild the in-process episodic ring buffer). The durable semantic",
        "channel is unaffected; any cross-restart score discontinuity should be read in that light.",
      ]
    : [];

  const body = [
    "# RUN_REPORT.md — Overnight retrieval loop (V0.1)",
    "",
    `Run \`${ctx.runid}\` — ${state.iteration} iterations, ${elapsedH}h elapsed.`,
    "",
    "## Comparison (same dev set / held-out set / checkpoint)",
    "",
    "| Config | Knobs | Dev utility | Held-out retrieval (recall / utility) | e2e checkpoint (gpt-5.2) |",
    "|---|---|---|---|---|",
    `| baseline | ${fmtCfg(baseline)} | ${baselineDevUtility.toFixed(4)} | ${baselineHO.meanRecall.toFixed(3)} / ${baselineHO.utility.toFixed(4)} | — |`,
    `| grid-best | ${gridBest ? fmtCfg(gridBest.config) : "n/a"} | ${gridBest ? gridBest.utility.toFixed(4) : "n/a"} | ${gridHO ? `${gridHO.meanRecall.toFixed(3)} / ${gridHO.utility.toFixed(4)}` : "n/a"} | ${cpStr(gridCP)} |`,
    `| loop-best | ${fmtCfg(best.config)} | ${best.utility.toFixed(4)} | ${loopHO.meanRecall.toFixed(3)} / ${loopHO.utility.toFixed(4)} | ${cpStr(loopCP)} |`,
    "",
    `**Verdict:** the loop **${verdict}** grid-best (§7.1: rediscovering grid-best is a PASS — it proves the loop behaves correctly in a known-small space).`,
    "",
    `- iterations run: ${state.iteration}`,
    `- wall-clock elapsed: ${elapsedH}h`,
    `- checkpoint runs: ${state.checkpoint.runs} / ${ctx.checkpointBudget}`,
    `- estimated checkpoint spend (CONSERVATIVE upper-bound): $${state.checkpoint.spendUsd.toFixed(2)} / $${ctx.checkpointCostCeilingUsd} ceiling${budgetState.stoppedByCeiling ? " (stopped by $ ceiling)" : ""}`,
    `- checkpoint rates used: in $${ctx.rateInUsdPer1M}/1M, out $${ctx.rateOutUsdPer1M}/1M (gpt-5.2)`,
    `- determinism noise band: ${state.noiseBand ?? store.readManifest()?.noiseBand ?? 0}`,
    "",
    "## Overfitting",
    "Free held-out retrieval checks were logged every 25 iterations (see archive `phase:heldout-retrieval`).",
    "If dev climbed while held-out stayed flat, that is logged as a generator-quirk overfitting signal.",
    ...restartSection,
    "",
    "## External benchmarks",
    "LoCoMo / LongMemEval were **skipped** (not present locally; spec marks them optional). The required",
    "synthetic held-out checkpoint above is the authoritative end-to-end signal.",
    "",
    "## Night-two levers (code-level retrieval — out of V0.1 scope)",
    "- **Scope-filter the semantic recall.** Today `mnemosyneClient.recall` is NOT scope-filtered, so a",
    "  query retrieves across all scopes in the collection. Per-scope filtering would cut cross-scope noise",
    "  and raise precision (and make `semanticTopK` more effective).",
    "- **Cross-bucket ranking / fusion.** Identity/graph/semantic/episodic are concatenated then trimmed",
    "  episodic→semantic→graph. A unified relevance ranking before trim would keep the best items per token.",
    "- **Dedup / rerank.** Episodic storage repeats near-identical turns; dedup + a reranker would reduce",
    "  wasted context tokens and improve `contextMaxTokens` efficiency.",
    "- **Query rewriting / multi-hop decomposition.** Multi-hop questions need both facts; decomposing the",
    "  query into sub-queries would raise multi-hop recall beyond what a single top-K pass achieves.",
    "- **Temporal recency ranking.** Temporal-update items rely on phrasing to suppress the stale marker;",
    "  an explicit recency/supersession signal would make 'stale absent' robust.",
  ].join("\n");
  fs.writeFileSync(path.join(ctx.runDir, "RUN_REPORT.md"), body);
  store.writeState(state);
  log(`  RUN_REPORT.md written (verdict: ${verdict})`);
}

async function teardownDry(ctx, { state }) {
  const boot = readBoot(ctx.store);
  if (boot?.pid) {
    ctx.log(`  dry-run teardown: stopping bench Sage pid ${boot.pid}`);
    killSage(boot.pid);
  }
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ctx = makeContext(args);
  ctx.log(`=== loop.js phase=${ctx.phase} runid=${ctx.runid} ===`);

  // generate (gates/dry) or load (run)
  let dataset;
  const datasetPath = path.join(ctx.runDir, "dataset.json");
  if (ctx.phase === "run") {
    dataset = readJson(datasetPath);
    if (!dataset) { ctx.log("FATAL: dataset.json missing (run gates phase first)"); process.exit(2); }
  } else {
    dataset = generateDataset({ runid: ctx.runid, seedDev: ctx.seedDev, seedHeldout: ctx.seedHeldout });
    writeJson(datasetPath, dataset);
    ctx.log(`  generated dataset: ${JSON.stringify(dataset.meta.counts)}`);
  }

  const state = ctx.store.readState() || { epoch: 1, iteration: 0, restartCount: 0, checkpoint: { runs: 0, spendUsd: 0, calls: 0, lastIter: -9999, stoppedByCeiling: false } };
  state.epoch = state.epoch || 1;

  try {
    if (ctx.phase === "gates") {
      await doGatesPhase(ctx, { dataset, state });
      ctx.log("Gates phase complete — bench Sage left running for the run phase.");
      process.exit(0);
    } else if (ctx.phase === "run") {
      await doRunPhase(ctx);
      process.exit(0);
    } else {
      // dry-run: gates + grid + a few loop iters, then teardown
      const { baseline, keepThreshold } = await doGatesPhase(ctx, { dataset, state });
      state.baseline = baseline; state.keepThreshold = keepThreshold; state.gatesPassed = true;
      ctx.store.writeState(state);
      // grid included in dry-run when --grid passed (canonical: --dry-run --grid)
      await doRunPhase(ctx);
      await teardownDry(ctx, { state });
      ctx.log("DRY-RUN complete.");
      process.exit(0);
    }
  } catch (error) {
    if (error instanceof HaltError) {
      ctx.log(`HALT: ${error.message}`);
      if (!fs.existsSync(path.join(ctx.runDir, "GATE_FAILURE.md"))) {
        writeGateFailure(ctx, { gate: "preflight", reason: error.message, evidence: {} });
      }
      if (ctx.isDry) await teardownDry(ctx, { state });
      process.exit(3);
    }
    ctx.log(`FATAL: ${error.stack || error.message}`);
    if (ctx.isDry) {
      try { await teardownDry(ctx, { state }); } catch { /* best effort */ }
    }
    process.exit(1);
  }
}

main();
