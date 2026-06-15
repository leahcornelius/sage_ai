// Phase 0 — prove the autonomous adjudicator machinery (spec §3, T1–T5).
// Deterministic, no real spawns: T1–T3 inject a mock adjudicateFn; T4 injects a
// mock exec spy into the real capped spawnAdjudicator to prove counter-refusal.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  CAPS,
  checkCaps,
  parseDecision,
  spawnAdjudicator,
  runAdjudicationCycle,
  loadState,
  saveState,
  appendLog,
} from "./adjudicator.mjs";

function freshRunDir(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adjtest-"));
  const state = {
    runid: path.basename(dir),
    startTimeIso: new Date().toISOString(),
    spawnCount: 0,
    roundsByGate: {},
    spendUsd: 0,
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, "adjudicator-state.json"), JSON.stringify(state, null, 2));
  return dir;
}
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const REAL_FORMAT = `DECISION: REDIRECT
HYPOTHESIS: store clean facts via raw db.store so the merge can't strip scopeKey
RATIONALE: scopedGap 0.125 < 0.3; the episodic-only substrate can't carry buried gold (lesson: demand the semantic channel is exercised). This is a distinct mechanism, not a threshold tweak.
CARRYOVER: round 1 used; tried episodic-only baseline (rejected: meanMRR present but recall low); open concern: marker preservation under extraction.`;

// ---- T1: happy path ----------------------------------------------------------
test("T1 happy path: valid decision parses, Builder acts, synthetic gate clears, logged, nothing merged", async (t) => {
  const runDir = freshRunDir();
  t.after(() => cleanup(runDir));

  // Real-format parse assertion (proves the parser handles a realistic reply).
  const parsed = parseDecision(REAL_FORMAT);
  assert.equal(parsed.decision, "REDIRECT");
  assert.equal(parsed.valid, true);
  assert.match(parsed.hypothesis, /raw db.store/);
  assert.match(parsed.carryover, /round 1 used/);

  // Arrow-form normalization.
  const arrow = parseDecision("DECISION: ACCEPT_HALT→FALLBACK\nRATIONALE: no new hypothesis\nCARRYOVER: x");
  assert.equal(arrow.decision, "ACCEPT_HALT_FALLBACK");
  assert.equal(arrow.valid, true);

  // Synthetic gate with an obvious fix; mock adjudicator APPROVES; actFn clears it.
  let gatePasses = false;
  const adjudicateFn = () => ({
    refused: false,
    decision: parseDecision("DECISION: APPROVE\nHYPOTHESIS: n/a\nRATIONALE: the fix is obviously correct\nCARRYOVER: none"),
    state: { spawnCount: 1 },
  });
  const actFn = async () => {
    gatePasses = true;
    return { action: "applied the obvious fix", pass: gatePasses };
  };
  const res = await runAdjudicationCycle({
    runDir,
    gate: "SYNTH_T1",
    packageFn: () => "synthetic gate failure: off-by-one in completeness count",
    actFn,
    adjudicateFn,
  });
  assert.equal(res.outcome, "pass");
  assert.equal(res.round, 1);
  const log = fs.readFileSync(path.join(runDir, "ADJUDICATION_LOG.md"), "utf8");
  assert.match(log, /SYNTH_T1/);
  assert.match(log, /PASS/);
  assert.match(log, /APPROVE/);

  // Nothing merged: the harness never invokes git merge/push. Assert no such file/flag.
  assert.equal(fs.existsSync(path.join(runDir, "MERGED")), false);
});

// ---- T2: fallback after 3 distinct rounds -----------------------------------
test("T2 fallback: unresolvable failure → 3 distinct rounds attempted → clean drop to fallback, logged", async (t) => {
  const runDir = freshRunDir();
  t.after(() => cleanup(runDir));

  const hypotheses = [];
  const adjudicateFn = ({ round }) => ({
    refused: false,
    decision: parseDecision(
      `DECISION: REDIRECT\nHYPOTHESIS: distinct-mechanism-${round}\nRATIONALE: round ${round} hypothesis\nCARRYOVER: tried ${round}`
    ),
    state: { spawnCount: round },
  });
  const actFn = async ({ decision }) => {
    hypotheses.push(decision.hypothesis);
    return { action: `tried ${decision.hypothesis}`, pass: false }; // never clears
  };
  const res = await runAdjudicationCycle({
    runDir,
    gate: "SYNTH_T2",
    packageFn: () => "synthetic unresolvable failure",
    actFn,
    adjudicateFn,
  });
  assert.equal(res.outcome, "fallback");
  assert.equal(res.reason, "rounds-exhausted");
  assert.equal(res.round, CAPS.maxRoundsPerGate);
  assert.equal(hypotheses.length, 3);
  assert.equal(new Set(hypotheses).size, 3, "the 3 rounds were distinct hypotheses");
  const log = fs.readFileSync(path.join(runDir, "ADJUDICATION_LOG.md"), "utf8");
  assert.equal((log.match(/SYNTH_T2/g) || []).length, 3, "3 rounds logged");
});

// ---- T3: carryover threading -------------------------------------------------
test("T3 carryover: round N CARRYOVER is appended to round N+1's prompt", async (t) => {
  const runDir = freshRunDir();
  t.after(() => cleanup(runDir));

  const promptsSeen = [];
  const adjudicateFn = ({ round, prompt }) => {
    promptsSeen.push(prompt);
    return {
      refused: false,
      decision: parseDecision(
        `DECISION: REDIRECT\nHYPOTHESIS: h${round}\nRATIONALE: r${round}\nCARRYOVER: UNIQUE_CARRYOVER_TOKEN_${round}`
      ),
      state: { spawnCount: round },
    };
  };
  const actFn = async () => ({ action: "tried", pass: false });
  await runAdjudicationCycle({
    runDir,
    gate: "SYNTH_T3",
    packageFn: ({ carryover }) => `pkg with carryover=[${carryover}]`,
    actFn,
    adjudicateFn,
  });
  assert.ok(promptsSeen.length >= 2);
  assert.match(promptsSeen[1], /UNIQUE_CARRYOVER_TOKEN_1/, "round 2 prompt contains round 1's carryover");
  assert.match(promptsSeen[2], /UNIQUE_CARRYOVER_TOKEN_2/, "round 3 prompt contains round 2's carryover");
  assert.doesNotMatch(promptsSeen[0], /UNIQUE_CARRYOVER_TOKEN_/, "round 1 prompt has no prior carryover");
});

// ---- T4: caps live + counter-refusal (the load-bearing structural guard) -----
test("T4 caps: spawnAdjudicator HARD-REFUSES at each cap without shelling claude -p", async (t) => {
  // Pure checkCaps unit assertions.
  const base = { startTimeIso: new Date().toISOString(), spawnCount: 0, roundsByGate: {}, spendUsd: 0 };
  assert.equal(checkCaps(base, "G").ok, true);
  assert.equal(checkCaps({ ...base, spawnCount: CAPS.maxSpawns }, "G").ok, false);
  assert.equal(checkCaps({ ...base, roundsByGate: { G: CAPS.maxRoundsPerGate } }, "G").ok, false);
  assert.equal(checkCaps({ ...base, startTimeIso: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }, "G").ok, false);
  assert.equal(checkCaps({ ...base, spendUsd: CAPS.cloudSpendUsd }, "G").ok, false);

  // Spy exec that throws if ever called — proves no spawn happens on refusal.
  let execCalls = 0;
  const execSpy = () => {
    execCalls++;
    return { ok: true, stdout: "DECISION: APPROVE\nRATIONALE: x\nCARRYOVER: y", error: null };
  };

  for (const [label, overrides] of [
    ["spawn-cap", { spawnCount: CAPS.maxSpawns }],
    ["round-cap", { roundsByGate: { G1b: CAPS.maxRoundsPerGate } }],
    ["wallclock-cap", { startTimeIso: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }],
  ]) {
    const runDir = freshRunDir(overrides);
    t.after(() => cleanup(runDir));
    const out = spawnAdjudicator({ runDir, gate: "G1b", prompt: "x", exec: execSpy });
    assert.equal(out.refused, true, `${label} refused`);
    assert.match(out.reason, new RegExp(label));
  }
  assert.equal(execCalls, 0, "claude -p exec was NEVER called on a capped spawn");

  // Permitted spawn increments + persists counters.
  const runDir = freshRunDir();
  t.after(() => cleanup(runDir));
  const out = spawnAdjudicator({ runDir, gate: "G1b", prompt: "x", exec: execSpy });
  assert.equal(out.refused, false);
  assert.equal(execCalls, 1, "exec called exactly once on a permitted spawn");
  const persisted = loadState(runDir);
  assert.equal(persisted.spawnCount, 1, "spawnCount persisted");
  assert.equal(persisted.roundsByGate.G1b, 1, "per-gate round persisted");
  assert.equal(out.decision.valid, true);
});

// ---- T5: isolation -----------------------------------------------------------
test("T5 isolation: collection-name policy excludes dev collections", () => {
  // Branch-pin guard: while a run is live on an experiment branch this catches an
  // accidental run on the wrong branch. Once the work is merged to main the pin is
  // historical and cannot hold, so enforce it only when on an experiment/* branch.
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim();
  if (branch.startsWith("experiment/")) {
    assert.match(branch, /^experiment\/5/, `experiment run must be on experiment/5 branch (got ${branch})`);
  }

  // The throwaway-collection policy the whole run honors (dev collections forbidden).
  const isThrowaway = (name) =>
    typeof name === "string" && (name.startsWith("sage_contract_") || name.startsWith("bench_") || name.startsWith("benchuser_"));
  for (const dev of ["sage_mem_v2", "memory_private", "agent_profiles", "skill_library"]) {
    assert.equal(isThrowaway(dev), false, `dev collection ${dev} is excluded`);
  }
  assert.equal(isThrowaway("sage_contract_x_shared"), true);
  assert.equal(isThrowaway("bench_r123_e1"), true);

  // The adjudicator harness only writes inside the provided run dir (structural).
  const runDir = freshRunDir();
  try {
    appendLog({ runDir, entry: "isolation probe" });
    saveState(runDir, { ...loadState(runDir), probe: true });
    const wrote = fs.readdirSync(runDir);
    assert.ok(wrote.includes("ADJUDICATION_LOG.md"));
    assert.ok(wrote.includes("adjudicator-state.json"));
  } finally {
    cleanup(runDir);
  }
});
