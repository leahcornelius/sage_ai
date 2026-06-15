# ADJUDICATION_LOG.md — Experiment 5 (run r2026061508531_230d)

Every Adjudicator spawn, appended. This is the reasoning audit Leah reads.

## 2026-06-15T08:00:11.944Z — gate SYNTH_PHASE0 — round 1 — spawn #1 (claude -p)
**Package summary:**
```
This is a PHASE-0 MACHINERY VALIDATION with a SYNTHETIC gate failure (not a real experiment gate).

### GATE FAILURE PACKAGE — SYNTH_PHASE0
**Numbers:** completeness check reports 139/140 gold markers retrievable at generous K.
The single miss is the last turn of scope dev_3: the populate loop wrote turnIndex = len
instead of len-1 for the final turn, so its messageId collided and the turn was deduped out.

**Builder's proposed plan:** fix the off-by-one (`turnIndex = i` not `i+1`) in the synthetic
populate loop, re-ingest, re-verify completeness. This is an obvious, mechanical, verifiable fix.

**Relevant artifacts:** diff is a one-line change to a loop bound; no behavioural ambiguity.

**Rolling carryover:** (none — this is the Phase-0 live proof of the adjudication machinery).

Note to Adjudicator: this is a deliberately easy, obvious-fix case used ONLY to prove the
spawn->parse->log path end to end. Decide normally and output the exact four-field structure.

```
**Adjudicator output:**
```
DECISION: APPROVE
HYPOTHESIS: n/a
RATIONALE: This is a Phase-0 harness/data-generation defect, not a substrate or scoreboard manipulation. The completeness check correctly reported a real miss: 139/140 gold actually ingested, because the populate loop's off-by-one (turnIndex=len for the final dev_3 turn) produced a messageId collision that the dedup path soft-deleted — i.e. the gold turn was genuinely never stored. The proposed fix (turnIndex=i) makes the substrate actually contain all 140 gold markers; it changes the system (ingest stores what it claims), not the threshold. No gate is weakened, no miss is reframed as a win, no confound is recruited — the gate (140/140 retrievable) is untouched and must still be met on its own terms after re-ingest. Passes the "system vs scoreboard" test cleanly. Consistent with the merge/dedup lessons (Contract #1, DEFECT #1): a silent ingest-time dedup dropping gold is exactly the failure mode the contract suite exists to catch, and here the harness caught it before it could distort a real gate.

Approval is contingent on the obvious verification the Builder already proposes: after the one-line fix, re-ingest and re-run completeness to confirm 140/140 live+retrievable, and confirm the reindex didn't shift other turnIndices in a way that alters scope membership. Mechanical, deterministic, $0.
CARRYOVER: Phase-0 machinery proof — spawn→parse→log path exercised end to end; adjudicator output structure validated. State: synthetic gate SYNTH_PHASE0, single gold miss in scope dev_3 traced to a populate-loop off-by-one (messageId collision → dedup). Disposition: APPROVE the mechanical fix, contingent on re-verify showing 140/140. Rounds used this gate: 0 of 3 (APPROVE of an obvious harness fix is not a hypothesis round; the 3-round budget remains intact for any real gate). No hypotheses tried/rejected yet. Open concerns / smells: none here, but note the described mechanism ("turnIndex=len for the final turn collides") should be confirmed by the Builder's re-run rather than assumed — if completeness does not return 140/140 after the fix, the diagnosis was wrong and the next round must investigate the actual dedup/messageId derivation before any further change. This was a deliberately easy live-fire test; real gates demand live (not offline) evidence and proof the semantic/clean-fact channel is exercised before crediting any positive.
```
**Builder action:** (builder to act)
**Gate re-result:** (pending)
---

## Phase-0 live proof (b) — Agent-tool agentic path (one-time, demoted)
Spawned an Adjudicator via the Agent tool on the same synthetic obvious-fix package. Purpose:
prove the agentic path also yields parseable structured output. **It does NOT count against the
20-spawn real-adjudication budget** and is **never used for a real gate** (a Node process can't
enforce caps on the Agent tool). Output (valid four-field structure, parsed OK):
```
DECISION: APPROVE
HYPOTHESIS: n/a
RATIONALE: The single miss is a defect in the synthetic populate loop itself (turnIndex = len
instead of len-1), not in Sage's retrieval. The fix corrects the harness rather than tuning a
threshold — passes the system-vs-scoreboard test; 140/140 confirmed by re-ingest, not asserted.
CARRYOVER: PHASE-0 SYNTH machinery-validation case; spawn/structured-output path proven end to end.
```

## GATE 0 VERDICT — PASS ✅ (2026-06-15)
- T1–T5 (`node --test overnight/harness/adjudicator.test.mjs`): **5/5 green**, incl. T4
  counter-refusal (spawn-cap / round-cap / wallclock-cap all hard-refuse without shelling claude -p).
- Live real path: one **`claude -p`** capped-helper spawn → valid decision, `spawnCount` 0→1,
  `roundsByGate.SYNTH_PHASE0` 0→1 persisted, logged (spawn #1 above).
- Demoted proof: one **Agent-tool** spawn → valid parseable four-field output.
- `claude -p` headless smoke test: returns cleanly, exit 0.
**Machinery proven → proceed to Phase 1.** (Real-adjudication budget consumed by Phase 0: 1 of 20.)

## 2026-06-15T09:39:06.900Z — gate G1b — round 1 — spawn #2 (claude -p)
**Package summary:**
```
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
    "meanMrrA (>=0.2)":        {"value": 0.731, "pass": true
…[truncated]…
```
**Adjudicator output:**
```
DECISION: ACCEPT_HALT_FALLBACK
HYPOTHESIS: n/a
RATIONALE: 4/5 G1b criteria pass and the failure is structurally honest, not a substrate bug. The only miss — scopedGap 0.156 < 0.3 — is small precisely *because the clean facts are good*: unscoped recall via the pipeline already reaches 0.500 (raw db.search 0.438 + pipeline lift 0.063), so scoping's marginal value is only 0.156. This is the V0.3 verdict ("scope-filtering is incremental, not dramatic") reconfirmed on a substrate where the semantic channel is, for the first time, genuinely populated and exercised (recallC=0.000, recallB'=0.656, attrib=1.00). I verified live numbers, not the offline preview (the halt reason itself flags that offline rank-1-2 did not transfer — correct to distrust it).

No distinct, principled, non-gaming hypothesis exists to move scopedGap. I tested three and rejected each: (1) **make clean facts only-scoped** — the Builder flagged this and I reject it; it suppresses the unscoped baseline to widen the gap, degrading the system to move the scoreboard (fails the "system vs scoreboard" test). (2) **restore BM25/hybrid on the unscoped path** — would *raise* B_unscoped and *shrink* the gap, and is a deferred harness item; counterproductive. (3) **reframe scopedGap as orthogonal to the clean-fact hypothesis** — a fair observation to *report*, but I cannot alter a gate, the measurement is already honestly computed (no bug to make "more honest"), and using it to forward-declare a pass would be exactly the reframe the discipline forbids. Per §3/§6, with no genuinely new hypothesis, the rule is ACCEPT_HALT_FALLBACK, and the explicit bias-to-fallback on interpretive calls reinforces it — this is an interpretive call and I am taking the safe side. Fallback (not HALT_ENTIRELY) because a clean, valuable result exists to report. Round 0 of 3 used on G1b; I am deliberately not spending a round on a tweak.

Fallback to execute: do not proceed past G1b into the loop; report the honest negative on scopedGap alongside the verified clean-fact gain as best config (clean-fact ON; baselineUtility ~0.11 → 0.50, buried-gold scoped recall 0.000 → 0.656). **Do not revert the clean-fact layer** — it passed Gate 1 and is the better substrate; the negative is specific to the scopedGap criterion, not the layer. The clean-fact win is on the **synthetic bench only** and must be caveated as such (arc transfer-discipline) — credit it as general only after LoCoMo/held-out transfer-verification.
CARRYOVER: State — Exp5 Phase 2 dry-run (r2026061508180_1560_dry) halted at G1b on scopedGap=0.156<0.3; all artifacts verified, numbers reproduce, retrieval deterministic so a non-dry rerun is not required (would burn cost for no new info). G1b is structural (no auto-retry). Decision: ACCEPT_HALT_FALLBACK — report honest negative + keep clean-fact-ON as best config; layer NOT reverted. Rounds used on G1b: 0/3 (chose not to open one — no non-gaming mechanism to raise scopedGap). Hypotheses rejected this run: (a) only-scoped clean facts = gaming (suppresses unscoped baseline); (b) BM25/hybrid restore = shrinks the gap + deferred; (c) "scopedGap is orthogonal" = valid report-only observation, NOT grounds to forward-pass (cannot alter gate; measurement already honest). Open concerns for next adjudicator: (1) the clean-fact 0.000→0.656 gain is SYNTHETIC-only — demand LoCoMo/held-out transfer before crediting as a real win; (2) scopedGap orthogonality vs the clean-fact hypothesis is a legitimate human-only gate-redefinition question — surface to Nyx, do not self-resolve; (3) confirm the final write-up does not silently upgrade the synthetic gain to a general claim or bury the scopedGap miss.
```
**Builder action:** (builder to act)
**Gate re-result:** (pending)
---

### Builder action on the G1b adjudication (above)
**Decision honored: ACCEPT_HALT_FALLBACK.** Builder did NOT proceed past G1b into the loop, did
NOT revert the clean-fact layer (it passed Gate 1; the miss is specific to the scopedGap criterion),
and did NOT run a standalone LoCoMo (the Adjudicator flagged transfer-verification as a human-only
open concern, not a Builder action, and said do not proceed past G1b). The clean-fact recall gain
(episodic 0.000 → scoped-semantic 0.656; baseline utility ~0.11 → 0.50) is recorded as the best
config, **caveated as synthetic-bench-only / transfer-unverified** (G4 LoCoMo was never reached).
The two human-only questions (synthetic→transfer; scopedGap-vs-clean-fact gate redefinition) are
surfaced to Nyx in EXPERIMENT_5_OUTCOME.md. **Gate re-result: G1b remains FAILED (accepted, not
retried).** G1b rounds used: 1 spawn / 3; total adjudicator spawns: 2 / 20.
