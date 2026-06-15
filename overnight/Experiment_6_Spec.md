# EXPERIMENT 6 — Does the clean-fact gain transfer to real conversations?

**Branch:** `experiment/6-locomo-transfer` off `main` (the merged stack tip; tree == `experiment/5-autonomous-cleanfact` @ `002cd57`)
**Mode:** fully autonomous, unsupervised, ≤24h (Leah away, audits on return).
**Caps:** wall-clock **24h**, cloud spend **$80**, **3** distinct-hypothesis rounds/gate, **≤20** adjudicator spawns.
**Prime principle:** self-improvement only counts where success is **verifiable**. A true
negative or a clean fallback beats a flattering unverified positive. **Nothing auto-merges;
everything stays on the branch for human audit.**

---

## 0. The question (and why it's the whole ballgame)

Exp5 found a large clean-fact gain **on the synthetic marker bench**: buried-gold recall
0.000 → 0.656. Two caveats made it un-creditable: it's synthetic-only, and the bench scores on
opaque 8-char markers, so part of the lift may be verbatim-string surfacing rather than
semantic transfer. **Exp6 settles it on real data:** does turning the clean-fact layer ON
beat OFF on **LoCoMo** (real multi-session conversations, natural-language Q&A)?

- **Transfer YES** → the clean-fact layer is a real improvement worth keeping/building on, and
  the self-improving loop finally has a validated substrate (and the adjudicator's hard
  multi-round half finally gets exercised).
- **Transfer NO** → the synthetic gain was a marker-surfacing convenience; a real, valuable
  negative. Report it; don't run the loop.

**Corrected gate (Exp5 lesson):** the experiment is gated on **clean-fact ON vs OFF lift**, NOT
on `scopedGap`. `scopedGap` tested *scoping's marginal value* (settled: incremental) and was
orthogonal to the clean-fact hypothesis — it does not gate Exp6.

---

## 1. What exists vs what to build (confirmed by codebase review)

**Already built (reuse):** `overnight/harness/lib/locomo.js` — `loadLocomo`/`buildLocomo`
(isolated `bench_locomo_*` scopes, `dia_id`-tagged turns), `evidenceRecall` (FREE,
deterministic: gold `dia_id` present in retrieved block), `judgedAccuracy` (billed: cloud
answerer ≠ local `qwen3:14b` judge, $-ceiling-gated), calibrated category-aware judge.
`data/locomo10.json` present. `loop.js setupLocomo`/`locomoEvidence`/`finalReport` launch an
isolated Sage and compare read-side-knob rows.

**The gap (build in Phase 1):** the existing A/B only varies *read-side knobs* on a **single**
population. Clean-fact ON/OFF is an **ingest-time** setting (`SAGE_CLEANFACT_ENABLED` at
launch; not an `applyConfig` knob), so the running A/B cannot toggle it. **No code populates a
cleanfact-OFF LoCoMo collection for the comparison.** That comparison is the experiment.

**Already fixed by the housekeeper (depend on it):** the read-only answer mode
(`x-sage-skip-memory-write`) — the LoCoMo judged-accuracy answerer MUST use a read-only
retrieve path so it cannot write its answers back into the scored scope. Phase 1's contract
verifies this (it is the Codex contamination finding, in the LoCoMo path).

---

## 2. Fallback ladder (bias to fallback over total-halt)

| Stage fails | After ≤3 rounds → | Result |
|---|---|---|
| **Phase 0** (machinery re-verify) | **HALT + `PHASE0_FAILURE.md`** | the adjudicator rig regressed; fix it |
| **Phase 1** (A/B wrapper validity) | **HALT + report** — an *invalid* comparison has no honest fallback; do NOT run a comparison you can't trust | a diagnosis of why the harness isn't fair |
| **Phase 2a** (transfer A/B) | **report honest negative** ("does not transfer"), do NOT run the loop | a real transfer verdict |
| **Phase 2b** (loop, only if 2a positive) | **revert failing change, report honest negative + best config** | a real verdict on the loop |

Phase 1 is the one place (besides Phase 0) where total-halt is correct: a transfer answer from
a comparison that isn't provably fair is worse than no answer.

---

## 3. Prerequisites (execution step 1 — fail fast)

1. Backends up: Qdrant, Redis, Ollama (`qwen3:14b` + `nomic-embed-text`). `OPENAI_API_KEY` set
   (LoCoMo answerer `gpt-5.4-mini`, preflight it 200 OK; `gpt-4.1-mini` fallback; if neither
   resolves → **HALT**, because LoCoMo *is* the experiment, not an optional checkpoint).
2. `git checkout -b experiment/6-locomo-transfer main` (the full stack is merged, so `main` now == the exp5 tip `002cd57`; if the exp5 branch is still around, `git diff main experiment/5-autonomous-cleanfact` should be empty — that plus the suite check below confirms parity).
3. `npm run test:contracts` green (expect **34/34**) + `npm test` green (**139/139**). Red → HALT.
4. Confirm the adjudicator rig is present (`overnight/harness/adjudicator.mjs` + tests) and the
   `x-sage-skip-memory-write` read-only mode exists (housekeeper landed it). Absent → HALT.
5. **Read the two flagged retrieval-gating constraints** the housekeeper saved to memory
   (notably **cold-start episodic-only gating**) — they are confounds for the LoCoMo A/B and
   must be accounted for in Phase 1 (§4) and watched in Phase 2a.
6. Create run dir `overnight/runs/<runid>/`; assemble the static context pack (now including the
   Exp5 outcome + the flagged constraints).

---

## 4. Phase 0 — re-verify the adjudicator machinery (light; it already exists)

The rig was built and proven in Exp5. Do NOT rebuild it — re-verify:
- `node --test overnight/harness/adjudicator.test.mjs` → T1–T5 green (incl. counter-refusal).
- One live `claude -p` capped spawn on a trivial synthetic gate → valid parseable decision,
  counters persist, logged.
**Gate 0:** both green → proceed. Else HALT + `PHASE0_FAILURE.md`.

---

## 5. Phase 1 — build + validate the clean-fact ON/OFF LoCoMo A/B wrapper

A thin wrapper over the existing primitives — **but it is the single load-bearing piece**, so
it is gated by a validity contract. A subtly-unfair A/B that shows "ON wins" for a harness
reason is a false positive we would act on; this phase makes the harness's fairness a **gate**,
not an assumption.

**Build:**
- Parameterize the cleanfact flag in `benchEnv` (stop hardcoding `SAGE_CLEANFACT_ENABLED=true`;
  take it per-launch).
- Populate **two** LoCoMo collections from the *same* `buildLocomo` output: one cleanfact-**ON**,
  one **OFF** (two Sage launches on distinct ports, or two clearly-tagged collections). Episodic
  population identical; the only difference is the presence of `semantic_fact` points.
- Run `evidenceRecall` (free) + `judgedAccuracy` (billed, $-capped, **read-only answerer via
  `x-sage-skip-memory-write`**) against each; diff. Extend `finalReport` with the ON/OFF rows.
- Account for the **cold-start episodic-only gating** constraint: ensure it does not silently
  force episodic-only retrieval early in each conversation in a way that differs between ON/OFF
  (if it would, neutralize it equally for both arms and document it).

**Validity contract (new `overnight/contracts/locomo-ab-fairness.contract.test.mjs`, red→green):**
- **1a Fair comparison:** ON and OFF differ *only* in `semantic_fact` points — same
  conversations, same `dia_id`-tagged episodic turns, same scope namespace. Assert: episodic
  point set identical; point-count delta == clean-fact count; nothing else differs.
- **1b No contamination:** after a `judgedAccuracy` pass, the scored scope's live point count is
  **unchanged** — the answerer never writes back (verifies `x-sage-skip-memory-write` is wired
  on the LoCoMo answer path).
- **1c Correct attribution:** ON metrics computed from the ON population, OFF from OFF (no
  cross-wiring).
- **1d Determinism:** `evidenceRecall` deterministic; characterize (don't pretend-zero) the
  judged-accuracy answerer nondeterminism with a bounded tolerance.
- **1e Slice fairness audit:** the slice run emits the ON/OFF population diff + the read-only
  verification as an artifact, so fairness is visible in the human audit before the full run.
- Full `npm run test:contracts` stays green with the new test.

**Gate 1:** all of 1a–1e + suite green → proceed. **Fail → adjudicate (≤3 rounds) → else HALT +
report** (no trustworthy A/B; do not run an unfair comparison).

---

## 6. Phase 2a — the transfer A/B (slice-first → full)

**Slice-first (cheap signal, your call confirmed):** run the A/B on **1–2 LoCoMo conversations**
first — clean-fact ON vs OFF, `evidenceRecall` (free) + `judgedAccuracy` (billed, $-capped).
- **Promising** (ON meaningfully > OFF) → run the **full** LoCoMo10 A/B.
- **Flat** (ON ≈ OFF) → **honest negative**, do NOT spend the full billed run; report
  "does not transfer." (Adjudicator may authorize one *distinct* principled round if there's a
  real mechanism reason the slice under-reads — not a threshold nudge.)

**The gate (your "very much yes"):** report the **ON-vs-OFF delta** on both `evidenceRecall`
and `judgedAccuracy`, with a **simple significance/CI** (it's a proportion over N questions) —
treat **"ON reliably beats OFF"** as the pass, **not** an arbitrary numeric threshold (which
invites gaming). The adjudicator rules borderline cases and biases to the honest read. Report
the synthetic held-out recall-lift alongside as a cross-check (synthetic vs real divergence is
itself a finding).

**Watch (Exp5 nuance):** clean facts are vector-only (raw-stored, no BM25), so a real transfer
win should look like semantic ranking, not exact-string hits — LoCoMo (no markers) is precisely
the test that separates the two.

**On failure unresolved in 3 rounds → honest negative; stop (no loop).**

---

## 7. Phase 2b — the self-improving loop (ONLY if 2a transfers)

If the clean-fact layer transfers, run the EvolveMem loop on the now-**validated** substrate,
gated on the **corrected** metric — **recall/accuracy lift on held-out**, NOT `scopedGap`.
- Standard loop: diagnose → propose knob/config change → apply → evaluate on held-out →
  keep/revert. Deterministic inner loop (no per-iter model calls); LoCoMo judged-accuracy as the
  sparse transfer checkpoint ($-capped).
- A win must be on **held-out**, not dev (preserve the Exp1 anti-overfit discipline).
- **This is where the adjudicator's hard half finally fires:** if a gate fails, the 3-round
  *distinct-hypothesis* redirect machinery runs for the first time. Hold every round to the
  distinct-mechanism bar; no threshold-chasing.
- Gate fail unresolved in 3 rounds → revert + honest negative + best config.

---

## 8. Adjudication, caps, safety (reuse Exp5 rig)

- **Every breached gate** → package (gate + numbers + plan + artifacts + carryover) → spawn
  Adjudicator via the **capped `claude -p` helper** (the only real-spawn path; counters
  hard-refuse past caps) → parse → act → re-check → ≤3 distinct rounds → fallback. Static pack +
  rolling carryover as in Exp5. The §7-style Adjudicator prompt (Exp5 spec) is reused verbatim.
- **Caps:** 24h / $80 / 3 rounds-per-gate / ≤20 spawns — hard, persisted.
- **Safety:** all work on `experiment/6-locomo-transfer`; **no merges, no push to main**; every
  adjudication logged to `ADJUDICATION_LOG.md`; honest `EXPERIMENT_6_OUTCOME.md` stating clearly
  whether the layer **transfers / doesn't / wasn't reached**, every adjudicator call + why, and
  where it fell back. Optional one-call cross-model red-team of the outcome doc if
  `OPENAI_API_KEY` set (it caught a real overclaim last time — keep it).

---

## 9. Cost & time (rough)

- **Cost:** small — a few dollars. Only `judgedAccuracy` is billed (`gpt-5.4-mini` answerer ×
  ~questions × ON/OFF); LoCoMo10 ≈ a few thousand short calls ≈ low single digits. Slice ≈ <$1.
  Far inside $80. (The local extraction + judge are $0.)
- **Time:** hours, dominated by the local clean-fact **ON populate** of LoCoMo (long real
  conversations → many extractions). OFF populate is fast. Slice ON-populate ≈ 30–60 min; full
  ≈ a few hours. Inside 24h. (As in Exp5, the run paces against Max quota before $80.)

---

## 10. Exit

**Done (success)** when docs written and any holds: a transfer verdict (transfers / doesn't),
optionally a loop verdict if 2a passed; or a clean Phase-1/2 fallback with a real result.
**Failed** only if Phase 0 or Phase 1 halted (rig regressed / unfair harness) — the failure
diagnosis is then the deliverable. Either way: a real artifact returns; nothing reaches main.