// Phase 1 validation (Experiment 5, spec §4 Gate 1a + 1c) for the LOCAL clean-fact
// extractor (qwen3:14b/Ollama). Runs extraction on a fixed fixture of benchmark-style
// gold turns (entity + attribute + opaque marker) plus filler, and reports:
//
//   1a  distinct-fact count (sane vs near-zero) + MARKER-PRESERVATION rate (the real
//       1a check: fraction of gold opaque markers that survive VERBATIM into some
//       extracted fact — if the marker is paraphrased/dropped, the clean fact cannot
//       carry the buried gold). Per the hard-fail rule, near-zero extraction or
//       sub-floor marker preservation is NOT an adjudication question.
//   1c  determinism: extract twice on the same turns; report fact-set overlap and
//       whether markers survive both runs (LLM-driven — characterize + bound, don't
//       pretend it is zero variance).
//
// Run: node overnight/harness/cleanfact-validate.mjs [--runid <id>] [--full]
// Writes <runDir>/cleanfact-validate.json and prints a verdict.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalExtractorAdapter } from "../../src/services/memory/local-extractor-adapter.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// Benchmark-style gold turns: distinct entity + attribute + opaque 8-char marker
// (mirrors overnight/harness/generate.js gold facts). Markers are FIXED (reproducible).
const GOLD = [
  ["The route code for the Crimson Falcon yard is Z8VAG0RP.", "Z8VAG0RP"],
  ["The access badge for the Helios east wing is AL7PHA42.", "AL7PHA42"],
  ["The maintenance window for the Aurora relay is set to T4WINDOW.", "T4WINDOW"],
  ["The shipping manifest for the Onyx convoy uses code MNFST9QX.", "MNFST9QX"],
  ["The vault combination for the Meridian depot is VC3MBN88.", "VC3MBN88"],
  ["The call sign for the Tundra outpost is TND5R0CK.", "TND5R0CK"],
  ["The license key for the Solace terminal is SLC7KEY1.", "SLC7KEY1"],
  ["The berth assignment for the Nimbus freighter is BRTH22XQ.", "BRTH22XQ"],
  ["The override token for the Cobalt gate is CBLT0VRD.", "CBLT0VRD"],
  ["The frequency for the Halcyon beacon is HZ449821.", "HZ449821"],
  ["The serial for the Vesper unit is VSP3R777.", "VSP3R777"],
  ["The passphrase for the Quartz archive is QZ8ARCHV.", "QZ8ARCHV"],
];
const FILLER = [
  "Thanks, that's really helpful.",
  "Can you remind me about this later?",
  "I think we touched on this yesterday during standup.",
  "Sounds good, let's move on to the next item.",
];

function makeAdapter() {
  const stubLogger = { child: () => ({ warn() {}, info() {}, debug() {}, error() {} }) };
  const config = {
    memory: {
      mode: "soft",
      cleanFactEnabled: true,
      cleanFact: {
        ollamaUrl: process.env.SAGE_CLEANFACT_OLLAMA_URL || "http://127.0.0.1:11434",
        model: process.env.SAGE_CLEANFACT_MODEL || "qwen3:14b",
        temperature: 0,
        seed: 7,
        timeoutMs: 90000,
      },
    },
  };
  return createLocalExtractorAdapter({ config, logger: stubLogger });
}

async function extractTurn(adapter, text, turnIndex) {
  const t0 = Date.now();
  const facts = await adapter.extractFacts({
    scopeKey: "validate_scope",
    conversationId: "validate_conv",
    role: "user",
    messageText: text,
    messageId: `vm${turnIndex}`,
    timestamp: "2026-06-15T00:00:00.000Z",
  });
  return { facts, ms: Date.now() - t0 };
}

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

async function main() {
  const args = process.argv.slice(2);
  const runidArg = args.includes("--runid") ? args[args.indexOf("--runid") + 1] : null;
  const full = args.includes("--full");
  const runid =
    runidArg ||
    (fs.existsSync(path.join(REPO_ROOT, "overnight/runs/EXP5_RUNID.txt"))
      ? fs.readFileSync(path.join(REPO_ROOT, "overnight/runs/EXP5_RUNID.txt"), "utf8").trim()
      : null);
  const runDir = runid ? path.join(REPO_ROOT, "overnight/runs", runid) : null;

  const adapter = makeAdapter();
  const turns = [...GOLD.map(([t, m]) => ({ text: t, marker: m, kind: "gold" })),
                 ...FILLER.map((t) => ({ text: t, marker: null, kind: "filler" }))];

  // ---- Run 1: 1a count + marker preservation ----
  const run1 = [];
  let totalFacts = 0;
  let totalMs = 0;
  let markersPreserved = 0;
  for (let i = 0; i < turns.length; i++) {
    const { facts, ms } = await extractTurn(adapter, turns[i].text, i);
    totalFacts += facts.length;
    totalMs += ms;
    let preserved = null;
    if (turns[i].kind === "gold") {
      preserved = facts.some((f) => f.text.includes(turns[i].marker));
      if (preserved) markersPreserved++;
    }
    run1.push({ i, kind: turns[i].kind, marker: turns[i].marker, nFacts: facts.length, markerPreserved: preserved, ms, facts: facts.map((f) => f.text) });
    process.stdout.write(`  turn ${i} (${turns[i].kind}): ${facts.length} facts, ${ms}ms${preserved === false ? "  <-- MARKER LOST" : ""}\n`);
  }
  const goldCount = GOLD.length;
  const markerPreservationRate = markersPreserved / goldCount;

  // ---- Run 2: 1c determinism (subset unless --full) ----
  const detTurns = full ? turns : turns.slice(0, 8);
  let overlapSum = 0;
  let markerStable = 0;
  let markerStableDenom = 0;
  const run2 = [];
  for (let i = 0; i < detTurns.length; i++) {
    const { facts } = await extractTurn(adapter, detTurns[i].text, i);
    const a = new Set((run1[i].facts || []).map(norm));
    const b = new Set(facts.map((f) => norm(f.text)));
    const inter = [...a].filter((x) => b.has(x)).length;
    const uni = new Set([...a, ...b]).size;
    const overlap = uni === 0 ? 1 : inter / uni;
    overlapSum += overlap;
    if (detTurns[i].kind === "gold") {
      markerStableDenom++;
      const p1 = run1[i].markerPreserved === true;
      const p2 = facts.some((f) => f.text.includes(detTurns[i].marker));
      if (p1 === p2 && p1 === true) markerStable++;
    }
    run2.push({ i, overlap, nFacts: facts.length });
  }
  const determinismOverlap = detTurns.length ? overlapSum / detTurns.length : 1;
  const markerStability = markerStableDenom ? markerStable / markerStableDenom : 1;

  // ---- Verdict ----
  const FLOOR = 0.5; // marker-preservation hard-fail floor (spec §4 revision)
  const hardFail = totalFacts < goldCount * 0.5 || markerPreservationRate < FLOOR;
  const sane = !hardFail && totalFacts >= goldCount && totalFacts <= turns.length * 4;
  const summary = {
    runid,
    model: process.env.SAGE_CLEANFACT_MODEL || "qwen3:14b",
    turns: turns.length,
    goldCount,
    totalFacts,
    fillerFacts: run1.filter((r) => r.kind === "filler").reduce((s, r) => s + r.nFacts, 0),
    meanLatencyMs: Math.round(totalMs / turns.length),
    estPopulate140Min: Math.round((totalMs / turns.length) * 140 / 1000 / 60 * 10) / 10,
    gate1a: { markersPreserved, goldCount, markerPreservationRate: Number(markerPreservationRate.toFixed(3)), floor: FLOOR, sane, hardFail },
    gate1c: { determinismOverlap: Number(determinismOverlap.toFixed(3)), markerStability: Number(markerStability.toFixed(3)), detTurns: detTurns.length },
    verdict: hardFail ? "GATE_1a_HARD_FAIL -> Phase-1 fallback (disable clean-fact)" : sane ? "GATE_1_PASS (sane + markers preserved)" : "BORDERLINE -> adjudicate",
  };

  console.log("\n=== cleanfact-validate summary ===");
  console.log(JSON.stringify(summary, null, 2));
  if (runDir && fs.existsSync(runDir)) {
    fs.writeFileSync(path.join(runDir, "cleanfact-validate.json"), JSON.stringify({ summary, run1, run2 }, null, 2));
    console.log(`\nwrote ${path.join(runDir, "cleanfact-validate.json")}`);
  }
}

main().catch((e) => {
  console.error("cleanfact-validate failed:", e);
  process.exit(1);
});
