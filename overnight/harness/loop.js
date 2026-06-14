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
import { runGate0, runGate1, runGate1b, runGate2, runGate3, evalConfig, applyConfig } from "./gates.js";
import { scoreSet, computeUtility } from "./lib/score.js";
import { OllamaClient } from "./lib/ollama.js";
import { loadLocomo, buildLocomo, evidenceRecall, judgedAccuracy } from "./lib/locomo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RUNS_DIR = path.join(REPO_ROOT, "overnight", "runs");

const KNOB_BOUNDS = {
  semanticTopK: [1, 30],
  episodicTopK: [0, 20],
  contextMaxTokens: [200, 4000],
  scopeFilter: [0, 1], // P1 boolean knob (0=off, 1=on)
};
const GRID = {
  semanticTopK: [1, 3, 5, 10, 20, 30],
  episodicTopK: [0, 3, 10],
  contextMaxTokens: [400, 800, 1200, 2000, 4000],
  scopeFilter: [0, 1], // cross the read-side knobs x scopeFilter -> clean A/B reference
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
  const locomoPort = num(args["locomo-port"], 8800);
  const qdrantBenchUrl = args["qdrant-bench"] || "http://127.0.0.1:6344";
  const qdrantRealUrl = args["qdrant-real"] || "http://127.0.0.1:6333";
  const cacheBenchUrl = args["cache-bench"] || "redis://127.0.0.1:6345";
  const graphBenchUrl = args["graph-bench"] || "redis://127.0.0.1:6346";
  const locomoCollection = `bench_locomo_${runid}`;

  return {
    phase, isDry, runid, runDir, store, log, benchKey,
    benchPort, realPort, locomoPort, qdrantBenchUrl, qdrantRealUrl, cacheBenchUrl, graphBenchUrl,
    locomoCollection,
    scorerModel: args["score-model"] || "gpt-4o-mini", // stable tiktoken encoder for retrieval scoring
    // LoCoMo checkpoint: cheap CLOUD answerer (held constant), LOCAL Qwen3 judge.
    // Never gpt-5.2-mini (404s upstream). Preflight verifies; falls back on 404.
    checkpointModel: args["checkpoint-model"] || "gpt-5.4-mini",
    checkpointModelFallback: args["checkpoint-model-fallback"] || "gpt-4.1-mini",
    judgeModel: args["judge-model"] || "qwen3:14b",
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
    // LoCoMo checkpoint sizing: ingest `locomoConvs` conversations; cap judged QA
    // (billed) to bound cost; evidence-recall (free) can use more.
    locomoFile: args["locomo-file"] || path.join(REPO_ROOT, "data", "locomo10.json"),
    locomoConvs: num(args["locomo-convs"], isDry ? 1 : 5),
    locomoJudgedQa: num(args["locomo-judged-qa"], 40),
    locomoEvidenceQa: num(args["locomo-evidence-qa"], 80),
    locomoPeriodicQa: num(args["locomo-periodic-qa"], 25),
    clients: {
      sage: new SageClient({ baseUrl: `http://127.0.0.1:${benchPort}`, apiKey: benchKey, model: args["score-model"] || "gpt-4o-mini" }),
      locomoSage: new SageClient({ baseUrl: `http://127.0.0.1:${locomoPort}`, apiKey: benchKey, model: args["score-model"] || "gpt-4o-mini" }),
      ollama: new OllamaClient({}),
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
    // Use the dataset's own scope prefix (supports --dataset reuse, where scopes
    // carry the BUILD runid; still benchuser_*, never a real scope).
    scopePrefix: dataset.meta.scopePrefix,
    locomoCollection: ctx.locomoCollection,
    locomoPort: ctx.locomoPort,
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

// ---------------------------------------------------------------- LoCoMo instance
// A SECOND isolated bench Sage on its own port + own collection (bench_locomo_<runid>)
// in the SAME isolated qdrant, so LoCoMo and the synthetic store never bleed (mnemosy-ai
// fixes the shared collection name at startup, so two collections need two instances).
async function ensureLocomoUp(ctx, { state }) {
  const { store, benchKey, locomoPort, locomoCollection, qdrantBenchUrl, cacheBenchUrl, graphBenchUrl, clients, log } = ctx;
  const boot = readBoot(store, "locomo");
  if (boot && boot.collection === locomoCollection && isAlive(boot.pid)) {
    try {
      await waitForHealth(clients.locomoSage, { timeoutMs: 6000, intervalMs: 500 });
      return { boot, fresh: false };
    } catch { /* relaunch */ }
  }
  const env = benchEnv({ collection: locomoCollection, port: locomoPort, benchKey, qdrantUrl: qdrantBenchUrl, cacheUrl: cacheBenchUrl, graphUrl: graphBenchUrl });
  log(`  launching LoCoMo bench Sage (port ${locomoPort}, collection ${locomoCollection})`);
  const newBoot = launchSage({ repoRoot: REPO_ROOT, env, store, port: locomoPort, collection: locomoCollection, epoch: 1, name: "locomo" });
  await waitForHealth(clients.locomoSage, { timeoutMs: 90000 });
  log(`  LoCoMo Sage healthy (pid ${newBoot.pid}, port ${locomoPort})`);
  return { boot: newBoot, fresh: true };
}

// Bring up LoCoMo + ingest once (idempotent via point count). Returns the built
// { scopes, ingests, qas } or null if the LoCoMo file is absent.
async function setupLocomo(ctx, { state }) {
  const { clients, log } = ctx;
  if (!fs.existsSync(ctx.locomoFile)) {
    log(`  LoCoMo file not found at ${ctx.locomoFile} — LoCoMo checkpoint will be skipped`);
    return null;
  }
  const data = loadLocomo(ctx.locomoFile);
  const built = buildLocomo({ data, runid: ctx.runid, numConvs: ctx.locomoConvs });
  log(`  LoCoMo: ${built.scopes.length} conversations, ${built.ingests.length} turns, ${built.qas.length} memory-relevant QA`);
  const up = await ensureLocomoUp(ctx, { state });
  const pc = await clients.qdrantBench.pointCount(ctx.locomoCollection);
  const need = up.fresh || !pc || pc < built.ingests.length * 0.9;
  if (need) {
    log(`  ingesting ${built.ingests.length} LoCoMo turns into ${ctx.locomoCollection}`);
    const { ingested, errors } = await populate({ client: clients.locomoSage, ingests: built.ingests, concurrency: 4, log: () => {} });
    if (errors.length) log(`  WARN: ${errors.length} LoCoMo ingest errors (sample: ${errors[0]?.error})`);
    for (let a = 1; a <= 5; a += 1) {
      await sleep(1500 * a);
      const p = await clients.qdrantBench.pointCount(ctx.locomoCollection);
      log(`  LoCoMo populate settle ${a}: points=${p}`);
      if (p >= built.ingests.length * 0.9) break;
    }
    writeJson(path.join(ctx.runDir, "locomo-meta.json"), {
      convs: built.scopes.length, ingested, turns: built.ingests.length, qaCount: built.qas.length, createdAt: new Date().toISOString(),
    });
  } else {
    log(`  LoCoMo already populated (${pc} points); adopting`);
  }
  return built;
}

// Probe the cloud answerer on the LoCoMo Sage; fall back on 404/unavailable.
// Never gpt-5.2-mini. Returns the working model or null (then judged is skipped).
async function preflightAnswerer(ctx) {
  if (ctx.noCheckpointModelCalls) { ctx.resolvedAnswerer = null; return null; }
  const candidates = [ctx.checkpointModel, ctx.checkpointModelFallback].filter(Boolean);
  for (const model of candidates) {
    try {
      const r = await ctx.clients.locomoSage.chatCompletion({
        model, messages: [{ role: "user", content: "Reply with the single word: ok" }],
        chatId: `${ctx.locomoCollection}_preflight`,
      });
      if (r?.choices?.[0]?.message) {
        ctx.resolvedAnswerer = model;
        ctx.log(`  answerer preflight OK: ${model}${model !== ctx.checkpointModel ? " (fallback)" : ""}`);
        return model;
      }
    } catch (error) {
      ctx.log(`  answerer preflight ${model} failed: ${error.message}`);
    }
  }
  ctx.resolvedAnswerer = null;
  ctx.log("  WARN: no cloud answerer resolved — LoCoMo judged accuracy SKIPPED (evidence-recall still runs free)");
  return null;
}

// LoCoMo evidence-recall for one config (FREE). Applies config on the LoCoMo Sage.
async function locomoEvidence(ctx, { built, config, qaLimit }) {
  await applyConfig(ctx.clients.locomoSage, config);
  const qas = qaLimit ? built.qas.slice(0, qaLimit) : built.qas;
  return evidenceRecall({ client: ctx.clients.locomoSage, qas, model: ctx.scorerModel, concurrency: ctx.concurrency });
}

// ---------------------------------------------------------------- mutation
function randomConfig(rng, base) {
  return {
    semanticTopK: rng.int(...KNOB_BOUNDS.semanticTopK),
    episodicTopK: rng.int(...KNOB_BOUNDS.episodicTopK),
    contextMaxTokens: clamp(rng.int(2, 40) * 100, KNOB_BOUNDS.contextMaxTokens),
    scopeFilter: rng.int(0, 1),
    graphMaxResults: base.graphMaxResults, // fixed (Zep off)
  };
}

function mutate(rng, parent, base) {
  const c = { ...parent, graphMaxResults: base.graphMaxResults };
  const knob = rng.choice(["semanticTopK", "episodicTopK", "contextMaxTokens", "scopeFilter"]);
  if (knob === "contextMaxTokens") {
    const step = (rng.int(1, 8)) * 50 * (rng.random() < 0.5 ? -1 : 1);
    c.contextMaxTokens = clamp(c.contextMaxTokens + step, KNOB_BOUNDS.contextMaxTokens);
  } else if (knob === "scopeFilter") {
    c.scopeFilter = c.scopeFilter ? 0 : 1; // flip the boolean knob
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
        for (const f of GRID.scopeFilter) {
          configs.push({ semanticTopK: s, episodicTopK: e, contextMaxTokens: c, scopeFilter: f, graphMaxResults: dataset.baseGraphMaxResults ?? 20 });
        }
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
// (Night two's model-calling checkpoint is the LoCoMo checkpoint — see lib/locomo.js
// and setupLocomo/locomoEvidence/finalReport. The night-one synthetic chat checkpoint
// is intentionally removed: the synthetic side is now retrieval-only/deterministic.)

// Scoped-vs-unscoped verdict (the headline): compare loop-best ON vs OFF across the
// real signals (held-out recall, LoCoMo evidence-recall, LoCoMo judged accuracy).
function scopedVsUnscopedVerdict(off, on) {
  if (!off || !on) return "n/a (missing scoped or unscoped best)";
  const d = (a, b) => (a == null || b == null ? null : a - b);
  const ho = d(on.hoRecall, off.hoRecall);
  const ev = d(on.locomoEvidence, off.locomoEvidence);
  const ju = d(on.locomoJudged, off.locomoJudged);
  const fmt = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
  const parts = [];
  if (ho != null) parts.push(`held-out recall ${fmt(ho)}`);
  if (ev != null) parts.push(`LoCoMo evidence ${fmt(ev)}`);
  if (ju != null) parts.push(`LoCoMo judged ${fmt(ju)}`);
  const signed = [ho, ev, ju].filter((x) => x != null);
  const avg = signed.length ? signed.reduce((a, b) => a + b, 0) / signed.length : 0;
  const overall = avg > 0.01 ? "HELPED" : avg < -0.01 ? "HURT" : "NO MEASURABLE CHANGE";
  return `${overall} (scoped − unscoped: ${parts.join(", ") || "no signals"})`;
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

  // Gate 1b — semantic channel actually exercised (THE linchpin; spec §5).
  // Failure here is the run's most important signal, not an inconvenience: halt
  // with the P0-too-weak diagnosis. Do NOT fix-and-retry to force a pass.
  const g1b = await runGate1b({ client: ctx.clients.sage, dataset, model: ctx.scorerModel, lambda: ctx.lambda, concurrency: ctx.concurrency, log });
  if (!g1b.pass) {
    writeGateFailure(ctx, { gate: g1b.p0TooWeak ? "Gate 1b — P0 too weak (semantic not exercised)" : "Gate 1b", reason: g1b.reason, evidence: g1b.evidence });
    throw new HaltError(`Gate 1b: ${g1b.reason}`);
  }
  log(`  Gate1b PASS — semantic exercised (mrrA=${g1b.evidence.meanMrrA.toFixed(3)} recallB=${g1b.evidence.meanRecallB.toFixed(3)} recallC=${g1b.evidence.meanRecallC.toFixed(3)} attrib=${g1b.evidence.attribution.toFixed(2)})`);

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
    branch: process.env.GIT_BRANCH || "overnight/retrieval-loop-v0.2",
    commitSha: process.env.GIT_SHA || null,
    benchPort: ctx.benchPort,
    benchCollection: collection,
    qdrantBenchUrl: ctx.qdrantBenchUrl,
    seeds: { dev: ctx.seedDev, heldout: ctx.seedHeldout },
    dataset: {
      scopePrefix: dataset.meta.scopePrefix,
      generation: dataset.meta.generation,
      offlinePreview: dataset.meta.offlinePreview,
    },
    setSizes: dataset.meta.counts,
    knobBounds: KNOB_BOUNDS, // incl. scopeFilter
    lambda: ctx.lambda,
    checkpoint: {
      budget: ctx.checkpointBudget, costCeilingUsd: ctx.checkpointCostCeilingUsd,
      answererModel: ctx.checkpointModel, answererFallback: ctx.checkpointModelFallback,
      judge: `local:${ctx.judgeModel}`, // answerer != judge
      rateInUsdPer1M: ctx.rateInUsdPer1M, rateOutUsdPer1M: ctx.rateOutUsdPer1M,
    },
    locomo: { collection: ctx.locomoCollection, port: ctx.locomoPort },
    runCaps: { wallClockHours: ctx.wallClockMs / 3600000, maxIterations: ctx.maxIterations, convergence: ctx.convergence },
    baselineConfig: baseline,
    noiseBand: g1.evidence.noiseBand,
    keepThreshold,
    gates: {
      gate1: g1.evidence, gate1b: g1b.evidence, gate2: g2.evidence, gate3: g3.evidence,
      gate1Retries: g1.retries || 0, gate1bRetries: g1b.retries || 0, gate2Retries: g2.retries || 0, gate3Retries: g3.retries || 0,
    },
    createdAt: new Date().toISOString(),
  };
  store.writeManifest(manifest);
  store.writeState({ ...state, baseline, keepThreshold, gatesPassed: true });
  writeJson(path.join(ctx.runDir, "gates-result.json"), { passed: true, gate1: g1, gate1b: g1b, gate2: g2, gate3: g3 });
  log("GATES 0-1b-2-3 PASS");
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

  // bring up the isolated LoCoMo instance + ingest once + preflight the answerer
  // (best-effort: the run continues without it, with LoCoMo columns marked skipped).
  let locomoBuilt = null;
  try {
    locomoBuilt = await setupLocomo(ctx, { state });
    if (locomoBuilt) await preflightAnswerer(ctx);
  } catch (error) {
    log(`  LoCoMo setup failed (continuing without LoCoMo): ${error.message}`);
    locomoBuilt = null;
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

      // periodic LoCoMo EVIDENCE-RECALL (FREE) for the current best — the cheap
      // real-benchmark signal, run often (judged accuracy is reserved for the final
      // money comparison). Uses the LoCoMo Sage client, so the synthetic config is
      // untouched. No model calls.
      if (locomoBuilt && (improved || state.iteration % 25 === 0)) {
        try {
          const ev = await locomoEvidence(ctx, { built: locomoBuilt, config: best.config, qaLimit: ctx.locomoPeriodicQa });
          log(`  [locomo-evidence] iter ${state.iteration}: best evidenceRecall=${ev.meanEvidenceRecall.toFixed(3)} fullRecall=${ev.fullRecallRate.toFixed(3)} (n=${ev.n}, scopeFilter=${best.config.scopeFilter ? "on" : "off"})`);
          store.appendArchive({ iteration: state.iteration, phase: "locomo-evidence", config: best.config, locomoEvidenceRecall: ev.meanEvidenceRecall, locomoFullRecall: ev.fullRecallRate, n: ev.n, decision: "check" });
        } catch (error) {
          log(`  [locomo-evidence] iter ${state.iteration} failed: ${error.message}`);
        }
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
    await finalReport(ctx, { dataset, baseline, best, gridBest, state, startTime, locomoBuilt });
  } catch (error) {
    log(`  finalReport failed (continuing to clean exit): ${error.message}`);
  }

  // clean exit: restore baseline config (best-effort) + stop the LoCoMo instance
  try { await applyConfig(ctx.clients.sage, baseline); } catch { /* throwaway */ }
  try {
    const lb = readBoot(store, "locomo");
    if (lb?.pid) { log(`  stopping LoCoMo Sage pid ${lb.pid}`); killSage(lb.pid); }
  } catch { /* best effort */ }
  store.writeArchiveSummary();
  store.writeState(state);
  log("RUN COMPLETE");
}

async function finalReport(ctx, { dataset, baseline, best, gridBest, state, startTime, locomoBuilt }) {
  const { clients, scorerModel, lambda, concurrency, store, log } = ctx;
  log("  computing final comparison (dev + held-out retrieval + LoCoMo evidence + judged)");

  const onDev = async (config) => {
    const r = await evalConfig({ client: clients.sage, questions: dataset.dev, model: scorerModel, lambda, config, concurrency });
    return r.utility;
  };
  const onHeldout = async (config) => {
    await applyConfig(clients.sage, config);
    const agg = await scoreSet({ client: clients.sage, questions: dataset.heldout, model: scorerModel, concurrency });
    return { meanRecall: agg.meanRecall, utility: computeUtility(agg, lambda) };
  };

  // Derive loop-best UNSCOPED (scopeFilter off) and SCOPED (on) from the loop
  // archive + the grid (the grid crosses scopeFilter, so both always exist).
  const pool = [
    ...store.readArchive().filter((r) => r.config && (r.phase === "loop" || r.phase === "baseline")),
    ...store.readGrid().filter((r) => r.config),
  ];
  const bestWith = (f) => pool
    .filter((r) => (r.config.scopeFilter ? 1 : 0) === f)
    .sort((a, b) => b.utility - a.utility)[0] || null;
  const loopBestOff = bestWith(0);
  const loopBestOn = bestWith(1);

  const rows = [
    { key: "baseline", label: "baseline (off)", config: { ...baseline, scopeFilter: 0 } },
    { key: "loopOff", label: "loop-best (unscoped, off)", config: loopBestOff?.config },
    { key: "loopOn", label: "loop-best (scoped, on)", config: loopBestOn?.config },
    { key: "grid", label: "grid-best", config: gridBest?.config },
  ];

  // dev utility + held-out retrieval for each
  for (const row of rows) {
    if (!row.config) continue;
    row.devUtility = await onDev(row.config);
    const ho = await onHeldout(row.config);
    row.hoRecall = ho.meanRecall;
    row.hoUtility = ho.utility;
  }

  // LoCoMo evidence-recall (FREE) for each row
  if (locomoBuilt) {
    for (const row of rows) {
      if (!row.config) continue;
      try {
        const ev = await locomoEvidence(ctx, { built: locomoBuilt, config: row.config, qaLimit: ctx.locomoEvidenceQa });
        row.locomoEvidence = ev.meanEvidenceRecall;
        row.locomoEvN = ev.n;
      } catch (error) {
        log(`  LoCoMo evidence ${row.key} failed: ${error.message}`);
      }
    }
  }

  // LoCoMo judged accuracy (BILLED, capped) for the money comparison: baseline / off / on
  const budgetState = { spendUsd: state.checkpoint.spendUsd, ceilingUsd: ctx.checkpointCostCeilingUsd, calls: state.checkpoint.calls, stoppedByCeiling: false };
  if (locomoBuilt && ctx.resolvedAnswerer && !ctx.noCheckpointModelCalls) {
    for (const key of ["baseline", "loopOff", "loopOn"]) {
      const row = rows.find((r) => r.key === key);
      if (!row?.config || budgetState.spendUsd >= budgetState.ceilingUsd || state.checkpoint.runs >= ctx.checkpointBudget) continue;
      await applyConfig(clients.locomoSage, row.config);
      state.checkpoint.runs += 1;
      const ja = await judgedAccuracy({
        sageClient: clients.locomoSage, ollama: clients.ollama,
        qas: locomoBuilt.qas.slice(0, ctx.locomoJudgedQa),
        answererModel: ctx.resolvedAnswerer, judgeModel: ctx.judgeModel,
        budgetState, rateInUsdPer1M: ctx.rateInUsdPer1M, rateOutUsdPer1M: ctx.rateOutUsdPer1M, log,
      });
      row.locomoJudged = ja.accuracy;
      row.locomoJudgedN = ja.n;
      log(`  [locomo-judged] ${row.label}: acc=${ja.accuracy == null ? "n/a" : ja.accuracy.toFixed(3)} (n=${ja.n}) spend~$${budgetState.spendUsd.toFixed(2)}`);
    }
  }
  state.checkpoint.spendUsd = budgetState.spendUsd;
  state.checkpoint.calls = budgetState.calls;
  if (budgetState.stoppedByCeiling) state.checkpoint.stoppedByCeiling = true;

  // loop-vs-grid (machinery) verdict, as night one
  let gridVerdict = "n/a (grid not run)";
  if (gridBest) {
    const delta = best.utility - gridBest.utility;
    const thr = state.keepThreshold || 1e-6;
    gridVerdict = delta > thr ? "BEAT" : delta < -Math.max(thr, 0.005) ? "UNDERPERFORMED" : "MATCHED";
  }
  // scoped-vs-unscoped (THE headline)
  const sfVerdict = scopedVsUnscopedVerdict(rows.find((r) => r.key === "loopOff"), rows.find((r) => r.key === "loopOn"));

  const elapsedH = ((Date.now() - startTime) / 3600000).toFixed(2);
  const fmtCfg = (c) => (c ? `s${c.semanticTopK}/e${c.episodicTopK}/c${c.contextMaxTokens}/scopeFilter=${c.scopeFilter ? "on" : "off"}` : "n/a");
  const f3 = (x) => (x == null ? "n/a" : x.toFixed(3));
  const f4 = (x) => (x == null ? "n/a" : x.toFixed(4));
  const evCell = (r) => (r.locomoEvidence == null ? "skipped" : `${f3(r.locomoEvidence)} (n=${r.locomoEvN})`);
  const juCell = (r) => (r.locomoJudged == null ? (ctx.resolvedAnswerer ? "—" : "skipped") : `${f3(r.locomoJudged)} (n=${r.locomoJudgedN})`);
  const rowLine = (r) =>
    `| ${r.label} | ${fmtCfg(r.config)} | ${f4(r.devUtility)} | ${f3(r.hoRecall)} / ${f4(r.hoUtility)} | ${evCell(r)} | ${juCell(r)} |`;

  const g1b = store.readManifest()?.gates?.gate1b;
  const gen = dataset.meta?.generation;

  const body = [
    "# RUN_REPORT.md — Semantic-stress retrieval loop + scope-filtering (V0.2)",
    "",
    `Run \`${ctx.runid}\` — ${state.iteration} iterations, ${elapsedH}h elapsed.`,
    "",
    "## Comparison (same dev / held-out / LoCoMo sets)",
    "",
    "| Config | knobs + scopeFilter | dev utility | held-out recall/utility | LoCoMo evidence-recall | LoCoMo judged acc |",
    "|---|---|---|---|---|---|",
    ...rows.map(rowLine),
    "",
    `**Scoped-vs-unscoped verdict (the headline):** scope-filtering **${sfVerdict}**.`,
    `**Loop-vs-grid (machinery):** the loop **${gridVerdict}** grid-best.`,
    "",
    "## Gate 1b — semantic channel exercised (the linchpin)",
    g1b
      ? `PASS. meanMRR(A)=${f3(g1b.meanMrrA)}; semantic-only recall(B)=${f3(g1b.meanRecallB)}; ` +
        `episodic-only recall(C)=${f3(g1b.meanRecallC)}; attribution=${f3(g1b.attribution)}; ` +
        `multi-hop recall(A)=${f3(g1b.multiRecallA)} (reported separately). ` +
        `This run measures semantic retrieval (night one had meanMRR=0).`
      : "n/a",
    "",
    "## Run facts",
    `- iterations run: ${state.iteration}`,
    `- wall-clock elapsed: ${elapsedH}h`,
    `- LoCoMo: ${locomoBuilt ? `${locomoBuilt.scopes.length} conversations, ${locomoBuilt.qas.length} memory-relevant QA` : "skipped (file absent)"}`,
    `- answerer (billed, held constant): ${ctx.resolvedAnswerer || "none resolved — judged skipped"} (fallback ${ctx.checkpointModelFallback}); judge (local, free): ${ctx.judgeModel}`,
    `- checkpoint runs: ${state.checkpoint.runs} / ${ctx.checkpointBudget}`,
    `- estimated answerer spend (CONSERVATIVE upper-bound): $${state.checkpoint.spendUsd.toFixed(2)} / $${ctx.checkpointCostCeilingUsd} ceiling${budgetState.stoppedByCeiling ? " (stopped by $ ceiling)" : ""}`,
    `- answerer rates used: in $${ctx.rateInUsdPer1M}/1M, out $${ctx.rateOutUsdPer1M}/1M`,
    `- determinism noise band: ${store.readManifest()?.noiseBand ?? 0}`,
    `- benchmark generation: ${gen ? `gold paraphrase fallback ${(gen.goldFallbackRate * 100).toFixed(1)}% (${gen.gold.fallbacks}/${gen.gold.items}), model ${gen.model}` : "n/a"}`,
    gen?.offlinePreview
      ? `- offline preview (vector-only, pre-launch): within-5 unscoped ${f3(gen.offlinePreview.within5UnscopedRate)}, scoped ${f3(gen.offlinePreview.within5ScopedRate)}, meanGoldCosine ${f3(gen.offlinePreview.meanGoldCosine)}`
      : "",
    "",
    "## Overfitting",
    "Free held-out retrieval + LoCoMo evidence-recall were logged periodically (archive `phase:heldout-retrieval`,",
    "`phase:locomo-evidence`). If dev climbed while held-out/LoCoMo stayed flat, that is a generator-quirk signal.",
    "",
    "## Night-three levers (deferred — out of V0.2 scope)",
    "- **P2 — Cross-bucket ranking / fusion before trim.** Thread similarity scores through `searchSemantic`",
    "  and rank identity/graph/semantic/episodic by relevance before the token trim (episodic→semantic).",
    "- **P3 — Dedup / rerank.** Episodic storage repeats near-identical verbose turns; dedup + a reranker",
    "  would cut wasted `contextMaxTokens` and raise effective recall per token.",
    "- **P4 — Query rewriting / multi-hop decomposition.** Decompose multi-hop into sub-queries and union.",
    "- **P5 — Temporal recency / supersession ranking.** Make 'stale absent' robust via an explicit recency",
    "  or version signal rather than phrasing.",
    "- **LongMemEval** as the broader real-benchmark checkpoint (LoCoMo only this night).",
  ].filter((l) => l !== "").join("\n");
  fs.writeFileSync(path.join(ctx.runDir, "RUN_REPORT.md"), body);
  store.writeState(state);
  log(`  RUN_REPORT.md written (scoped-vs-unscoped: ${sfVerdict}; loop-vs-grid: ${gridVerdict})`);
}

async function teardownDry(ctx, { state }) {
  for (const name of ["", "locomo"]) {
    const boot = readBoot(ctx.store, name);
    if (boot?.pid) {
      ctx.log(`  dry-run teardown: stopping ${name || "synthetic"} bench Sage pid ${boot.pid}`);
      killSage(boot.pid);
    }
  }
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ctx = makeContext(args);
  ctx.log(`=== loop.js phase=${ctx.phase} runid=${ctx.runid} ===`);

  // generate (gates/dry), reuse a frozen dataset (--dataset), or load (run)
  let dataset;
  const datasetPath = path.join(ctx.runDir, "dataset.json");
  if (ctx.phase === "run") {
    dataset = readJson(datasetPath);
    if (!dataset) { ctx.log("FATAL: dataset.json missing (run gates phase first)"); process.exit(2); }
  } else if (args.dataset) {
    // Reuse a previously-frozen dataset (e.g. the dry-run's) so a Gate 1b pass
    // transfers deterministically rather than re-rolling Qwen content (spec §3).
    const src = readJson(args.dataset);
    if (!src) { ctx.log(`FATAL: --dataset ${args.dataset} not readable`); process.exit(2); }
    dataset = src;
    writeJson(datasetPath, dataset);
    ctx.log(`  reused frozen dataset from ${args.dataset}: ${JSON.stringify(dataset.meta.counts)} (scopePrefix ${dataset.meta.scopePrefix})`);
  } else {
    dataset = await generateDataset({ runid: ctx.runid, seedDev: ctx.seedDev, seedHeldout: ctx.seedHeldout });
    writeJson(datasetPath, dataset);
    ctx.log(`  generated dataset: ${JSON.stringify(dataset.meta.counts)} goldFallbackRate=${dataset.meta.generation.goldFallbackRate}`);
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
