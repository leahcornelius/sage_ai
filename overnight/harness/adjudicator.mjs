// Autonomous Adjudicator machinery for Experiment 5 (spec §3/§6/§7/§8).
//
// The Adjudicator stands in for the human reviewer (Nyx) on every breached gate.
// Per Leah's revision 1, caps must bind STRUCTURALLY IN CODE, not depend on the
// Builder remembering them: every REAL adjudication goes through `claude -p` via
// this module's capped helper, which persists counters in adjudicator-state.json
// and HARD-REFUSES past any cap (spawn-count 20 / rounds-per-gate 3 / 24h wall
// clock). The Agent tool is used only once, in Phase 0, as a live agentic proof —
// never for a real adjudication (a Node process cannot enforce caps on a tool only
// the main agent can call).
//
// No third-party deps — Node 24 + child_process.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const RUNS_DIR = path.join(REPO_ROOT, "overnight", "runs");

export const CAPS = {
  maxSpawns: 20,
  maxRoundsPerGate: 3,
  wallClockMs: 24 * 3600 * 1000,
  cloudSpendUsd: 80,
};

export const ALLOWED_DECISIONS = new Set([
  "APPROVE",
  "REQUEST_CHANGES",
  "REDIRECT",
  "ACCEPT_HALT_FALLBACK",
  "HALT_ENTIRELY",
]);

// The verbatim Adjudicator prompt (spec §7). Prepended to every spawn.
export const ADJUDICATOR_PROMPT = `You are the **Adjudicator** for an autonomous self-improvement experiment on "Sage", a hobby memory-retrieval server. You are standing in for a human reviewer (Nyx) who has overseen four prior experiments. **Your job is to protect the integrity of the result — not to make progress.** A true negative or a clean fallback is a SUCCESS. A flattering but unverified positive is a FAILURE.

**What you are reviewing:** the Builder agent has hit a benchmark gate. You will receive (a) a static context pack summarizing the project arc and its hard-won lessons, (b) a rolling carryover from prior adjudications this run, and (c) this gate's failure: the numbers, the Builder's proposed plan, and the relevant diffs/artifacts. You may read the repository and run read-only commands to verify claims.

**Non-negotiable discipline (from the arc):**
1. **Verifiable success only.** If success can't be measured cleanly, it doesn't count.
2. **Never game a gate.** Do not weaken a threshold, do not reframe a miss as a win, do not recruit a confound to explain away a miss. Changing the *measurement* to be more honest is allowed; changing it to pass is forbidden. The test: *does this change the system, or just the scoreboard?*
3. **One principled change per round; each round a DISTINCT hypothesis.** No tuning toward the threshold. If you cannot state a genuinely new hypothesis, choose \`ACCEPT_HALT_FALLBACK\`.
4. **Accept findings.** "It doesn't help" is a real result. Report it; don't bury it.
5. **Scope discipline.** Stay on the memory-retrieval substrate + harness. Don't sprawl.
6. **Bias to fallback on interpretive calls.** When a judgement is genuinely ambiguous, choose the safe fallback over a creative forward reframe. Prefer fallback over total-halt — the fallback always yields a result.

**Lessons you must apply (the arc earned these):**
- Recall can come entirely from the episodic ring buffer while semantic contributes nothing (meanMRR=0). Demand evidence the semantic/clean-fact channel is actually exercised before crediting it.
- Offline within-scope cosine rank is **not** a proxy for live retrieval. Trust live numbers.
- A silent ingest-time merge once soft-deleted the gold and invalidated a diagnosis; always check the substrate is doing what it claims (the contract suite is your friend).
- Scope-filtering turned out **incremental**, not dramatic — don't assume a lever is big because it's plausible. Let the benchmark decide.
- A confident diagnosis was once flat wrong (Exp2). Hold your own conclusions loosely; prefer the boring verified explanation.

**Your authority and limits:** your decision **binds the Builder for this gate**. You **cannot** merge to main, ship, or alter a gate's definition. Everything stays on the branch. You **must** log your rationale.

**Escape hatches (use narrowly):**
- \`ACCEPT_HALT_FALLBACK\`: choose this when ≤3 rounds are exhausted, when no new principled hypothesis exists, or when proceeding would require a **genuine human-only action** you cannot perform (e.g. an external secret/API key/account the sandbox can't provision — note that the Builder *can* run commands and install models, so this set is small).
- \`HALT_ENTIRELY\`: only if even the defined fallback is pointless or compromised. This should essentially never fire below Phase 0.

**Output EXACTLY this structure (no code fences, these four fields, in this order):**
DECISION: <APPROVE | REQUEST_CHANGES | REDIRECT | ACCEPT_HALT_FALLBACK | HALT_ENTIRELY>
HYPOTHESIS: <if REDIRECT: the distinct, principled hypothesis for this round; else "n/a">
RATIONALE: <why — cite the specific numbers/diffs/lessons; name any gaming smell you rejected; if you're biasing to fallback, say so and why>
CARRYOVER: <what the NEXT adjudicator must know: current state, hypotheses tried and rejected this run and WHY, open concerns, anything that smells off, round count used>

Be terse and technical. No flattery. Decide.`;

// ---------------------------------------------------------------------------
// State + caps
// ---------------------------------------------------------------------------

export function runDirFor(runid) {
  return path.join(RUNS_DIR, runid);
}

export function loadState(runDir) {
  const p = path.join(runDir, "adjudicator-state.json");
  if (!fs.existsSync(p)) {
    throw new Error(`adjudicator-state.json missing at ${p} (startTimeIso must be stamped at prereq time)`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function saveState(runDir, state) {
  const p = path.join(runDir, "adjudicator-state.json");
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

// Pure cap check. Returns { ok:true } or { ok:false, reason }. Never spawns.
export function checkCaps(state, gate, now = Date.now()) {
  const spawnCount = state.spawnCount || 0;
  const rounds = (state.roundsByGate && state.roundsByGate[gate]) || 0;
  const start = Date.parse(state.startTimeIso);
  const elapsed = Number.isFinite(start) ? now - start : 0;
  const spend = state.spendUsd || 0;
  if (spawnCount >= CAPS.maxSpawns) {
    return { ok: false, reason: `spawn-cap: ${spawnCount}/${CAPS.maxSpawns} adjudicator spawns used` };
  }
  if (rounds >= CAPS.maxRoundsPerGate) {
    return { ok: false, reason: `round-cap: gate ${gate} already used ${rounds}/${CAPS.maxRoundsPerGate} rounds` };
  }
  if (elapsed >= CAPS.wallClockMs) {
    return { ok: false, reason: `wallclock-cap: ${(elapsed / 3.6e6).toFixed(2)}h >= ${CAPS.wallClockMs / 3.6e6}h since ${state.startTimeIso}` };
  }
  if (spend >= CAPS.cloudSpendUsd) {
    return { ok: false, reason: `spend-cap: $${spend} >= $${CAPS.cloudSpendUsd}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Decision parsing (strict, tolerant of arrow forms + code fences)
// ---------------------------------------------------------------------------

function normalizeDecisionToken(tok) {
  return String(tok || "")
    .trim()
    .replace(/[`*]/g, "")
    .toUpperCase()
    .replace(/ACCEPT[_\s-]*HALT\s*(?:→|->|—|-|_)\s*FALLBACK/i, "ACCEPT_HALT_FALLBACK")
    .replace(/\s+/g, "_")
    .replace(/[^A-Z_]/g, "");
}

export function parseDecision(text) {
  const raw = String(text || "");
  const field = (name, stopNames) => {
    const stop = stopNames.map((n) => `${n}:`).join("|");
    const re = new RegExp(`${name}:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${stop})|$)`, "i");
    const m = raw.match(re);
    return m ? m[1].trim() : "";
  };
  const decisionRaw = field("DECISION", ["HYPOTHESIS", "RATIONALE", "CARRYOVER"]);
  const hypothesis = field("HYPOTHESIS", ["DECISION", "RATIONALE", "CARRYOVER"]);
  const rationale = field("RATIONALE", ["DECISION", "HYPOTHESIS", "CARRYOVER"]);
  const carryover = field("CARRYOVER", ["DECISION", "HYPOTHESIS", "RATIONALE"]);
  const decision = normalizeDecisionToken(decisionRaw.split(/\s|\n/)[0]);
  const valid = ALLOWED_DECISIONS.has(decision) && rationale.length > 0;
  return { decision, hypothesis, rationale, carryover, valid, raw };
}

// ---------------------------------------------------------------------------
// Static context pack (spec §8) — assembled once, prepended to every spawn
// ---------------------------------------------------------------------------

const LESSONS_DIGEST = `## Lessons digest (apply these)
- Recall can come entirely from the episodic ring buffer while semantic contributes nothing (meanMRR=0). Demand evidence the semantic/clean-fact channel is actually exercised before crediting it.
- Offline within-scope cosine rank is NOT a proxy for live retrieval. Trust live numbers.
- A silent ingest-time merge once soft-deleted the gold and invalidated a diagnosis; always check the substrate is doing what it claims (the contract suite is your friend).
- Scope-filtering turned out INCREMENTAL, not dramatic — don't assume a lever is big because it's plausible. Let the benchmark decide.
- A confident diagnosis was once flat wrong (Exp2). Hold conclusions loosely; prefer the boring verified explanation.`;

const FALLBACK_LADDER = `## Fallback ladder (spec §1 — bias to fallback over total-halt)
- Phase 0 (machinery) fails -> HALT + report (only correct total-halt).
- Phase 1 (substrate) fails -> disable clean-fact path, run Phase 2 on the CURRENT substrate (Exp3-style result).
- Phase 2 (loop gate) fails -> revert the failing change, report the honest negative + best config.
A true negative or a clean fallback is a SUCCESS. Prefer fallback over total-halt; total-halt only if even the fallback is compromised.`;

const ROUND_DISCIPLINE = `## Round discipline (spec §6, hard)
Each round is a GENUINELY NEW principled hypothesis with a stated rationale — NOT the same change tuned toward the threshold. Max 3 rounds per gate. If you cannot articulate a new hypothesis, return ACCEPT_HALT_FALLBACK rather than burning a round on a tweak. This is the anti-"iterate-until-green" rule.`;

const ARC_ONELINERS = `## Exp1-4 one-liners (spec §8)
- Exp1: EvolveMem loop machinery proven; but recall was episodic-only, semantic meanMRR=0.
- Exp2: buried-gold semantic-stress HALT — the unfiltered channel cannot surface a buried fact among homogeneous cross-scope lookalikes (~49/60 missing).
- Exp3 (V0.3): scope-filter works (scoped 0.72) but the gap vs unscoped is INCREMENTAL — Gate 1b reframed; halted at scopedGap 0.125 (pure-scoping +0.25, pipeline -0.125). $0.
- Exp4: substrate + harness characterized; merge bug fixed (130->620 live points, scopeKey preserved); partial-flag fixed; mem0/episodicTopK=0-floor/D3.1 flagged for decision.`;

export function assembleStaticPack({ runDir } = {}) {
  const readSafe = (rel, capChars) => {
    try {
      const t = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      return capChars && t.length > capChars ? t.slice(0, capChars) + "\n…[truncated]…" : t;
    } catch {
      return `(missing: ${rel})`;
    }
  };
  const pack = [
    "# STATIC CONTEXT PACK — Sage memory-retrieval arc (Experiment 5)",
    "",
    "Note: overnight/journal.txt does not exist; the arc summary below is assembled from the outcome docs.",
    "",
    LESSONS_DIGEST,
    "",
    FALLBACK_LADDER,
    "",
    ROUND_DISCIPLINE,
    "",
    ARC_ONELINERS,
    "",
    "## MEMORY_CONTRACTS.md (validated substrate contracts)",
    readSafe("overnight/MEMORY_CONTRACTS.md"),
    "",
    "## DEFECT_INVENTORY.md (known landmines)",
    readSafe("overnight/DEFECT_INVENTORY.md"),
    "",
    "## EXPERIMENT_4_OUTCOME.md (substrate readiness — TL;DR + readiness only)",
    readSafe("overnight/EXPERIMENT_4_OUTCOME.md", 4000),
  ].join("\n");
  if (runDir) {
    try {
      fs.writeFileSync(path.join(runDir, "static-context-pack.md"), pack);
    } catch {
      /* best-effort */
    }
  }
  return pack;
}

// ---------------------------------------------------------------------------
// Package + prompt assembly + logging
// ---------------------------------------------------------------------------

export function packageGateFailure({ gateId, numbers, builderPlan, artifacts, carryover }) {
  const lines = [
    `### GATE FAILURE PACKAGE — ${gateId}`,
    "",
    "**Numbers:**",
    "```json",
    JSON.stringify(numbers ?? {}, null, 2),
    "```",
    "",
    "**Builder's proposed plan:**",
    builderPlan || "(no plan — need direction)",
    "",
    "**Relevant artifacts:**",
    artifacts || "(none attached)",
    "",
    "**Rolling carryover from prior adjudications this run:**",
    carryover || "(none — this is the first adjudication)",
  ];
  return lines.join("\n");
}

export function buildPrompt({ staticPack, carryover, packageText }) {
  return [
    ADJUDICATOR_PROMPT,
    "",
    "================ STATIC CONTEXT PACK ================",
    staticPack,
    "",
    "================ ROLLING CARRYOVER ================",
    carryover || "(none — first adjudication this run)",
    "",
    "================ THIS GATE'S FAILURE ================",
    packageText,
    "",
    "Now output EXACTLY the four-field structure (DECISION / HYPOTHESIS / RATIONALE / CARRYOVER).",
  ].join("\n");
}

export function appendLog({ runDir, entry }) {
  const p = path.join(runDir, "ADJUDICATION_LOG.md");
  if (!fs.existsSync(p)) {
    fs.writeFileSync(
      p,
      `# ADJUDICATION_LOG.md — Experiment 5 (run ${path.basename(runDir)})\n\nEvery Adjudicator spawn, appended. This is the reasoning audit Leah reads.\n`
    );
  }
  fs.appendFileSync(p, "\n" + entry + "\n");
}

function formatLogEntry({ gate, round, spawnCount, package: pkg, decision, builderAction, gateReResult, mechanism, refused }) {
  return [
    `## ${new Date().toISOString()} — gate ${gate} — round ${round} — spawn #${spawnCount} (${mechanism})`,
    refused ? `**REFUSED (cap):** ${refused}` : "",
    "",
    "**Package summary:**",
    pkg ? "```\n" + String(pkg).slice(0, 1200) + (String(pkg).length > 1200 ? "\n…[truncated]…" : "") + "\n```" : "(n/a)",
    "",
    "**Adjudicator output:**",
    decision
      ? "```\n" +
        `DECISION: ${decision.decision}\nHYPOTHESIS: ${decision.hypothesis}\nRATIONALE: ${decision.rationale}\nCARRYOVER: ${decision.carryover}` +
        "\n```" +
        (decision.valid ? "" : "\n\n**⚠ parse INVALID — treated as fallback**")
      : "(no decision — refused or error)",
    "",
    `**Builder action:** ${builderAction || "(pending)"}`,
    `**Gate re-result:** ${gateReResult || "(pending)"}`,
    "",
    "---",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// ---------------------------------------------------------------------------
// Real spawn path: claude -p (the SOLE real-spawn mechanism)
// ---------------------------------------------------------------------------

// Shells `claude -p`, prompt on stdin, read-only tools. Returns { ok, stdout, error }.
export function claudeExec(prompt, { timeoutMs = 240000, model } = {}) {
  const args = ["-p", "--output-format", "text", "--allowedTools", "Read,Grep,Glob"];
  if (model) args.push("--model", model);
  const res = spawnSync("claude", args, {
    input: prompt,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    shell: true, // Windows resolves claude.cmd via PATH
    windowsHide: true,
  });
  if (res.error) return { ok: false, stdout: res.stdout || "", error: String(res.error.message || res.error) };
  if (res.status !== 0) {
    return { ok: false, stdout: res.stdout || "", error: `claude -p exit ${res.status}: ${(res.stderr || "").slice(0, 500)}` };
  }
  return { ok: true, stdout: res.stdout || "", error: null };
}

// The capped real-spawn. checkCaps -> (on pass) increment+persist -> exec -> parse.
// `exec` is injectable for tests (default = claudeExec). NEVER execs when a cap trips.
export function spawnAdjudicator({ runDir, gate, prompt, exec = claudeExec, now = Date.now() }) {
  const state = loadState(runDir);
  const cap = checkCaps(state, gate, now);
  if (!cap.ok) {
    return { refused: true, reason: cap.reason, state };
  }
  // Increment BEFORE the call (fail-safe toward under-spawning if the process dies mid-call).
  state.spawnCount = (state.spawnCount || 0) + 1;
  state.roundsByGate = state.roundsByGate || {};
  state.roundsByGate[gate] = (state.roundsByGate[gate] || 0) + 1;
  saveState(runDir, state);
  const result = exec(prompt);
  if (!result.ok) {
    return { refused: false, error: result.error, raw: result.stdout || "", state };
  }
  const decision = parseDecision(result.stdout);
  return { refused: false, decision, raw: result.stdout, state };
}

// ---------------------------------------------------------------------------
// Cycle orchestration (used by tests with a mock adjudicateFn; the real run
// drives single rounds via the CLI below).
// ---------------------------------------------------------------------------

export async function runAdjudicationCycle({ runDir, gate, packageFn, actFn, adjudicateFn, log = () => {} }) {
  const staticPack = assembleStaticPack({ runDir });
  let carryover = "";
  let lastDecision = null;
  for (let round = 1; round <= CAPS.maxRoundsPerGate; round++) {
    const pkg = packageFn({ round, carryover });
    const prompt = buildPrompt({ staticPack, carryover, packageText: pkg });
    const out = adjudicateFn({ runDir, gate, prompt, round, carryover });
    if (out.refused) {
      appendLog({ runDir, entry: formatLogEntry({ gate, round, spawnCount: out.state?.spawnCount ?? "?", package: pkg, refused: out.reason, builderAction: "fallback (cap refusal)", gateReResult: "fallback", mechanism: "claude -p" }) });
      return { outcome: "fallback", reason: out.reason, round, lastDecision };
    }
    const decision = out.decision || { decision: "ACCEPT_HALT_FALLBACK", valid: false, rationale: "no/invalid output", carryover: "", hypothesis: "n/a", raw: out.raw };
    lastDecision = decision;
    log(`round ${round}: DECISION=${decision.decision} valid=${decision.valid}`);
    if (!decision.valid) {
      appendLog({ runDir, entry: formatLogEntry({ gate, round, spawnCount: out.state?.spawnCount ?? "?", package: pkg, decision, builderAction: "treated as fallback (invalid parse)", gateReResult: "fallback", mechanism: "claude -p" }) });
      return { outcome: "fallback", reason: "invalid-decision", round, lastDecision };
    }
    if (decision.decision === "ACCEPT_HALT_FALLBACK") {
      appendLog({ runDir, entry: formatLogEntry({ gate, round, spawnCount: out.state?.spawnCount ?? "?", package: pkg, decision, builderAction: "fall back per ladder", gateReResult: "fallback", mechanism: "claude -p" }) });
      return { outcome: "fallback", reason: "adjudicator-accept-halt", round, lastDecision };
    }
    if (decision.decision === "HALT_ENTIRELY") {
      appendLog({ runDir, entry: formatLogEntry({ gate, round, spawnCount: out.state?.spawnCount ?? "?", package: pkg, decision, builderAction: "HALT", gateReResult: "halt", mechanism: "claude -p" }) });
      return { outcome: "halt", reason: "adjudicator-halt", round, lastDecision };
    }
    // APPROVE / REDIRECT / REQUEST_CHANGES -> Builder acts, gate re-checked.
    const acted = await actFn({ decision, round });
    appendLog({ runDir, entry: formatLogEntry({ gate, round, spawnCount: out.state?.spawnCount ?? "?", package: pkg, decision, builderAction: acted.action, gateReResult: acted.pass ? "PASS" : "still failing", mechanism: "claude -p" }) });
    if (acted.pass) return { outcome: "pass", round, lastDecision };
    carryover = decision.carryover || carryover;
  }
  return { outcome: "fallback", reason: "rounds-exhausted", round: CAPS.maxRoundsPerGate, lastDecision };
}

// ---------------------------------------------------------------------------
// CLI: one capped real spawn per invocation (the Builder drives a round via Bash)
//   node overnight/harness/adjudicator.mjs --run <id> --gate <id> --package <file> [--carryover <file>]
// Prints a JSON decision to stdout and appends to ADJUDICATION_LOG.md.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1];
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.run || !args.gate || !args.package) {
    console.error("usage: adjudicator.mjs --run <id> --gate <id> --package <file> [--carryover <file>] [--builder-plan <file>]");
    process.exit(2);
  }
  const runDir = runDirFor(args.run);
  const staticPack = assembleStaticPack({ runDir });
  const packageText = fs.readFileSync(args.package, "utf8");
  const carryover = args.carryover && fs.existsSync(args.carryover) ? fs.readFileSync(args.carryover, "utf8") : "";
  const prompt = buildPrompt({ staticPack, carryover, packageText });
  const out = spawnAdjudicator({ runDir, gate: args.gate, prompt });
  const round = out.state?.roundsByGate?.[args.gate] ?? "?";
  if (out.refused) {
    appendLog({ runDir, entry: formatLogEntry({ gate: args.gate, round, spawnCount: out.state?.spawnCount ?? "?", package: packageText, refused: out.reason, builderAction: "fallback (cap refusal)", gateReResult: "fallback", mechanism: "claude -p" }) });
    console.log(JSON.stringify({ refused: true, reason: out.reason }, null, 2));
    return;
  }
  if (out.error) {
    appendLog({ runDir, entry: formatLogEntry({ gate: args.gate, round, spawnCount: out.state?.spawnCount ?? "?", package: packageText, decision: null, builderAction: `spawn error: ${out.error}`, gateReResult: "fallback", mechanism: "claude -p" }) });
    console.log(JSON.stringify({ error: out.error, raw: out.raw?.slice(0, 2000) }, null, 2));
    return;
  }
  appendLog({ runDir, entry: formatLogEntry({ gate: args.gate, round, spawnCount: out.state?.spawnCount ?? "?", package: packageText, decision: out.decision, builderAction: "(builder to act)", gateReResult: "(pending)", mechanism: "claude -p" }) });
  // Persist the carryover for the next round.
  if (out.decision?.carryover) {
    fs.writeFileSync(path.join(runDir, `carryover-${args.gate}.txt`), out.decision.carryover);
  }
  console.log(JSON.stringify(out.decision, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
