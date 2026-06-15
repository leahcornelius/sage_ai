### GATE FAILURE PACKAGE — G1b (reframed scoped-channel gate, Phase 2)

**Source:** a real gates evaluation from the Phase-2 dry-run smoke test (run
`r2026061508180_1560_dry`). Dry-run = the SAME gates.js on the SAME clean-fact substrate; it
halted at G1b and tore down. Retrieval is deterministic (Gate 1 deterministic=true), so a
non-dry gates run reproduces these numbers. Evidence: `dryrun-gates-evidence.log` in this run dir.

**Substrate under test:** Experiment 5's NEW local clean-fact layer (qwen3:14b extraction →
clean, scope-tagged `semantic_fact` points stored raw, embed fact-text only). This is the first
time the bench has run with semantic facts populated (prior arc runs were episodic-only because
mem0 was inert). Populate: 620 turns → **1241 live points** (~620 episodic + ~621 clean-fact),
completeness=true (all gold retrievable scoped at generous K). Benchmark: 620 ingests, 48 dev /
24 held-out questions, goldFallbackRate 0.060 (94% of gold had a proper paraphrase gap — valid).

**Numbers:**
```json
{
  "gate": "G1b (reframed scoped channel)",
  "result": "FAILED on scopedGap (structural halt)",
  "criteria": {
    "meanMrrA (>=0.2)":        {"value": 0.731, "pass": true},
    "meanRecallB' (>=0.5)":    {"value": 0.656, "pass": true},
    "meanRecallC (<=0.1)":     {"value": 0.000, "pass": true},
    "attribution (>=0.7)":     {"value": 1.00,  "pass": true},
    "scopedGap (>=0.3)":       {"value": 0.156, "pass": false}
  },
  "decomposition": {
    "recallB'_scoped_semantic": 0.656,
    "recallB_unscoped_semantic": 0.500,
    "control_B_dbsearch_unscoped": 0.438,
    "pureScopingEffect (B' - B_dbsearch)": 0.219,
    "pipelineEffect (B_dbsearch - B_unscoped)": -0.063,
    "scopedGap (B' - B_unscoped)": 0.156
  },
  "object_level_context": {
    "episodic_only_recall (recallC)": 0.000,
    "clean_fact_scoped_recall (recallB')": 0.656,
    "baseline_utility_episodic_prior_runs": "~0.11",
    "baseline_utility_with_clean_facts": 0.5029
  }
}
```

**What the numbers say (my reading, for you to verify/reject):**
- The clean-fact/semantic channel is **clearly exercised and non-vacuous**: episodic-only recall
  is 0.000 (gold is buried past the 20-turn ring), while scoped semantic recall is 0.656, mrrA
  0.731, attribution 1.00. 4 of 5 G1b criteria pass. This is NOT the Exp1 "meanMRR=0, recall is
  episodic-only" pathology — it is the opposite.
- The clean-fact layer is a **large improvement on the object-level question** ("does retrieval
  over the clean-fact layer beat the raw-episodic baseline on buried gold?"): episodic-only
  0.000 → clean-fact scoped 0.656; baseline utility ~0.11 → 0.50.
- BUT the ONLY failing criterion, **scopedGap = 0.156 (< 0.3)**, is small *because the clean facts
  are retrievable UNSCOPED too* (B_unscoped ≈ 0.50). Pure-scoping adds +0.219 (raw db.search
  scoped vs unscoped) but the recall() pipeline costs −0.063, netting +0.156. This is consistent
  with the arc's V0.3 verdict that scope-filtering is **incremental, not dramatic**.

**Builder's proposed plan (honest, and I want you to guard it):**
My honest read is this is a real, valuable finding to REPORT, not a result to tune past:
- Default action: **ACCEPT_HALT → FALLBACK**, and report the honest, nuanced outcome — the
  clean-fact layer substantially improves buried-gold recall (0.000 → 0.656) but does NOT satisfy
  G1b's scoped-vs-unscoped gap criterion (0.156 < 0.3), because clean facts work unscoped as well;
  scoping remains an incremental lever.
- I do **NOT** see a non-gaming distinct MECHANISM to raise scopedGap. The obvious lever —
  making clean facts retrievable only-scoped to widen the gap — would SUPPRESS the unscoped
  baseline to pass the scoreboard, which is gaming (it makes the system worse to inflate a gap).
  I am flagging it precisely so you reject it if I'm tempted.
- I am ALSO flagging a measurement-validity tension for your ruling, WITHOUT claiming it as a win:
  G1b's scopedGap criterion (a V0.3 addition) tests *scoping's marginal value*, which may be
  orthogonal to the clean-fact hypothesis that this experiment exists to test (clean-fact vs
  episodic recall, which the LOOP/G3 would measure on held-out). The semantic channel IS exercised
  (the other 4 criteria). You CANNOT alter the gate definition — I am not asking you to. I am
  asking you to decide, on the discipline, whether the disciplined outcome is to accept the G1b
  halt and report this honestly (my default), or whether there is a genuinely distinct, principled,
  non-gaming hypothesis worth one of the 3 rounds.

**Rolling carryover:** (none — first real-gate adjudication this run; the only prior spawn was the
Phase-0 synthetic machinery proof.)
