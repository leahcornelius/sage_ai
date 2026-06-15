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
