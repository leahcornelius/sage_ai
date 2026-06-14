// Bench-Sage lifecycle + isolated backend env + population (spec §2/§5).
// The bench Sage is launched DETACHED so it survives the foreground gate run and
// is adopted by the detached overnight loop. On any relaunch the caller rolls to
// a fresh collection (see loop.js) because re-ingest is message_id-deduped and
// cannot rebuild the in-process episodic ring buffer.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { writeJson, readJson } from "./archive.js";
import { scoreSet } from "./score.js";

// Generous, FIXED retrieval budget (never tuned by the loop). The window is
// cached at controller init, so this must be set at launch.
const BUDGET_MS = "8000";

function benchEnv({ collection, port, benchKey, qdrantUrl, cacheUrl, graphUrl }) {
  return {
    MNEMOSYNE_VECTOR_DB_URL: qdrantUrl,
    MNEMOSYNE_CACHE_URL: cacheUrl,
    MNEMOSYNE_GRAPH_DB_URL: graphUrl,
    MNEMOSYNE_COLLECTION_NAME: collection,
    SAGE_MEM0_ENABLED: "false",
    SAGE_ZEP_ENABLED: "false",
    // Query cache is disabled via SAGE_REDIS_ENABLED=false: when the redis adapter
    // is disabled the controller short-circuits getQueryContext/setQueryContext
    // entirely (never reaching the in-memory fallback), so cacheHit is always false.
    // NB: the spec's literal SAGE_MEMORY_QUERY_CACHE_TTL_SEC=0 is REJECTED by Sage's
    // config validator (parsePositiveInteger requires > 0), so this is the faithful
    // realization of "query cache disabled" — Gate 1 verifies cacheHit=false.
    SAGE_REDIS_ENABLED: "false",
    SAGE_MEMORY_RETRIEVAL_BUDGET_MS: BUDGET_MS,
    SAGE_MEMORY_RETRIEVAL_TIMEOUT_MS: BUDGET_MS,
    SAGE_MEMORY_TIMEOUT_MNEMOSYNE_MS: BUDGET_MS,
    SAGE_MEMORY_MODE: "soft",
    // P1 scope-filter starts OFF; the loop toggles it live via /admin/memory-config.
    SAGE_MEMORY_SCOPE_FILTER_ENABLED: "false",
    // Benchmark-only: write episodic turns directly to Qdrant, bypassing mnemosy-ai's
    // unconditional 0.85 dedup/merge which otherwise soft-deletes the (early-planted)
    // gold facts and strips scopeKey before any retrieval runs. Production stays OFF.
    SAGE_MEMORY_EPISODIC_RAW_STORE: "true",
    SAGE_HOST: "127.0.0.1",
    SAGE_PORT: String(port),
    SAGE_ADMIN_ENABLED: "true",
    SAGE_API_KEY: benchKey,
    SAGE_DEFAULT_MODEL: "gpt-5.2",
    WEB_SEARCH_ENABLED: "false",
  };
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // exists but not signalable
  }
}

// `name` distinguishes concurrent instances (e.g. the LoCoMo Sage). The default
// "" keeps the synthetic instance's files exactly as night one (sage.boot.json,
// sage.pid, sage.out/err.log); a name suffixes them (sage.locomo.boot.json, ...).
function launchSage({ repoRoot, env, store, port, collection, epoch, name = "" }) {
  const sfx = name ? `.${name}` : "";
  const out = fs.openSync(path.join(store.logsDir, `sage${sfx}.out.log`), "a");
  const err = fs.openSync(path.join(store.logsDir, `sage${sfx}.err.log`), "a");
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
  });
  child.unref();
  const boot = {
    pid: child.pid,
    port,
    collection,
    epoch,
    name: name || "synthetic",
    startedAt: new Date().toISOString(),
  };
  writeJson(path.join(store.runDir, `sage${sfx}.boot.json`), boot);
  fs.writeFileSync(path.join(store.runDir, `sage${sfx}.pid`), String(child.pid));
  return boot;
}

function readBoot(store, name = "") {
  const sfx = name ? `.${name}` : "";
  return readJson(path.join(store.runDir, `sage${sfx}.boot.json`));
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(client, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const h = await client.health();
      if (h && h.status === "ok") return h;
    } catch (error) {
      lastErr = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Sage did not become healthy within ${timeoutMs}ms: ${lastErr?.message || "unknown"}`);
}

function killSage(pid) {
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
}

// Populate generation-free via /admin/ingest. Order preserved within a scope by
// running scope-serial; different scopes can run concurrently.
async function populate({ client, ingests, concurrency = 4, log = () => {} }) {
  const byScope = new Map();
  for (const ing of ingests) {
    if (!byScope.has(ing.scope)) byScope.set(ing.scope, []);
    byScope.get(ing.scope).push(ing);
  }
  const scopes = [...byScope.keys()];
  let ingested = 0;
  const errors = [];

  let next = 0;
  async function lane() {
    while (true) {
      const idx = next++;
      if (idx >= scopes.length) return;
      const scope = scopes[idx];
      for (const ing of byScope.get(scope)) {
        try {
          await client.adminIngest({
            scope: ing.scope,
            text: ing.text,
            conversationId: ing.conversationId,
            turnIndex: ing.turnIndex,
          });
          ingested += 1;
        } catch (error) {
          errors.push({ scope: ing.scope, text: ing.text, error: error.message });
        }
      }
      log(`  populated scope ${scope} (${ingested}/${ingests.length})`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, scopes.length) }, () => lane()));
  return { ingested, errors };
}

const GENEROUS_CONFIG = { semanticTopK: 30, episodicTopK: 20, graphMaxResults: 20, contextMaxTokens: 4000 };

// Populate-completeness (spec §5 step 4): every gold marker retrievable at
// generous K. Returns { complete, missing[] }.
//
// Experiment 3 (V0.3): verify through the SCOPED channel (scopeFilter ON) — the
// channel the within-scope payload-filter actually uses. The unfiltered channel
// cannot surface a specific buried fact among homogeneous cross-scope lookalikes
// (the Experiment-2 finding: ~49/60 missing), so an unfiltered completeness check
// would halt here before the reframed Gate 1b can adjudicate. This is a
// MEASUREMENT-ONLY reframe (the same scoped-channel reframe as Gate 1b); the only
// behavioural change is the payload-filter itself. The ~100% bar is unchanged: if
// scoped retrieval still cannot carry the gold at generous K, completeness halts —
// a real "scoped retrieval doesn't transfer" finding, accepted, not tuned. The
// unfiltered channel is still measured honestly as Gate 1b's B_unscoped contrast.
async function verifyCompleteness({ client, dataset, model, concurrency = 5 }) {
  await client.adminMemoryConfig({ ...GENEROUS_CONFIG, scopeFilter: 1 });
  const questions = [...dataset.dev, ...dataset.heldout, dataset.gate2.question].filter(
    (q) => q.requiredMarkers.length > 0
  );
  const agg = await scoreSet({ client, questions, model, concurrency });
  const missing = agg.perQuestion
    .filter((p) => p.missingMarkers.length > 0)
    .map((p) => ({ id: p.id, missing: p.missingMarkers }));
  return { complete: missing.length === 0, missing, agg };
}

export {
  benchEnv,
  launchSage,
  readBoot,
  isAlive,
  killSage,
  waitForHealth,
  populate,
  verifyCompleteness,
  sleep,
  GENEROUS_CONFIG,
  BUDGET_MS,
};
