# SAGE V2 — Night-Two Spec: Semantic-Stress Benchmark + Scope-Filtering (V0.2)

**Run this in Claude Code, in plan mode, from the `sage_ai` repo folder.** Plan first, show me the
plan, and only build + launch after I approve.

This is an **extension of night one — reuse the proven machinery, do not rebuild it.** The night-one
build is in this repo on branch `overnight/retrieval-loop-v0.1`: the three admin hooks, the harness
(`overnight/harness/{generate,gates,loop}.js`, `lib/{rng,forbidden,sage-client,score,archive,supervisor}.js`),
the isolation pattern, the gate framework, the detached-launch + manifest machinery. **Read these
first and build on them:**

- `overnight/HANDOFF_NIGHT_TWO.md` — the night-one→night-two briefing (load-bearing gotchas in §3).
- `overnight/SAGE_V2_OVERNIGHT_SPEC.md` — night-one spec; **all its constraints carry forward** (see §2).
- `overnight/runs/r2026061323573_9362/{RUN_REPORT,VERIFICATION,manifest,archive-summary}.*` — baseline
  numbers to beat and what the build conforms to.

Work on a **new branch** `overnight/retrieval-loop-v0.2` off the night-one branch.

---

## 0. Goal

Night one proved the machinery but the benchmark was **semantically vacuous** — every answer came from
the in-process episodic ring buffer (`meanMRR=0` at recall 0.77), so durable semantic retrieval was
never tested. Night two does two coupled things:

- **P0 — strengthen the synthetic benchmark so semantic retrieval actually matters** (bury answers past
  the 20-turn episodic window so they can only come from Qdrant semantic search).
- **P1 — scope-filter the semantic recall**, behind a loop-toggleable flag, and measure whether turning
  it on improves retrieval now that semantic is exercised.

**The headline result we want:** on a benchmark that finally stresses semantic, does scope-filtering
beat unfiltered recall? P0 and P1 are a matched pair — neither is measurable without the other.

Success = the strengthened benchmark passes the new semantic-stress gate, the loop runs the scoped-vs-
unscoped A/B cleanly, and the LoCoMo checkpoint confirms (or refutes) transfer to a real benchmark.

---

## 1. Scope and non-goals

**In scope:** P0 (benchmark strengthening + local-model content generation) and P1 (scope-filtering
behind a flag). The loop's mutable surface = the night-one read-side knobs **plus** a new
`scopeFilter` on/off flag.

**Explicitly out of scope (defer to night three):** P2 cross-bucket ranking, P3 dedup/rerank, P4 query
rewriting, P5 temporal recency. **LongMemEval** (LoCoMo only this night). Do **not** rebuild the
night-one harness, hooks, or isolation — extend them. No `.env.local`/secret edits.

---

## 2. Carried forward from night one (do not re-derive — reuse)

All of these hold exactly as in `SAGE_V2_OVERNIGHT_SPEC.md`; reuse the existing implementations:

- **Isolation:** separate ephemeral Qdrant+Redis+FalkorDB stack on non-default ports; bench Sage on a
  non-default port (127.0.0.1); never touch real memory. **Gate 0 runs first, never retries.**
- **The three admin hooks** (`/admin/ingest`, `/admin/memory-config`, `/admin/retrieve`) — already
  built; reuse. `/admin/memory-config` allowlist gains **one** new key this night: `scopeFilter` (§4).
- **Forbidden-word validation** (`/secret|password|token|api ?key|card|ssn/i`), fail-closed, before
  population — now also applied to **all Qwen3-generated content** (§3).
- **Backends off** (mem0, Zep, query cache via `SAGE_REDIS_ENABLED=false`), **generous fixed retrieval
  budget** (8000ms), **post-trim contextBlock scoring**, **determinism + noise-aware keep threshold**,
  **populate-completeness check**, **two-tier overfitting control**, **caps** (8h / 1000 iters / 100
  no-improve), **crash-resume**, **detached launch + `RUN_STATUS.md`**, **manifest + VC discipline**.
- **Gate framework + §8.1 mechanical-gate retry policy** (transient-only, ≤3 attempts, Gate 0 and
  structural failures halt immediately) and **Gate 4 read-only conformance audit** (pass-or-halt, no
  fix). Extended for night two in §6 and §8.

> Note the night-one landmines still bite (HANDOFF §3): `topK` is inert (use `semanticTopK`), the query
> cache disables via `SAGE_REDIS_ENABLED=false` (TTL=0 is rejected), `partial` is always true with Zep
> off (use `budgetExceeded`), and `mnemosy-ai` hardcodes private/profile/skill collection names
> (hence the separate Qdrant).

---

## 3. P0 — Strengthened synthetic benchmark

Extend `overnight/harness/generate.js` (+ `rng.js`, `forbidden.js`). The dataset is still produced by
**code** and frozen to disk; a **local model writes the natural-language content** only.

**Shape (V0.2 — these are the agreed numbers):**
- **12 scopes**, run-prefixed `benchuser_<runid>_<i>` (no real-scope collision — assert as in night one).
- **~50 facts per scope** (≫ the 20-turn episodic ring buffer).
- **The bury mechanic (the point of the whole night):** each question's **gold fact is planted early**
  in its scope's session history, then **buried under ≥25 later turns**, so by query time it has been
  pushed out of the last-20 episodic window and can **only** be recovered via durable Qdrant semantic
  search. (Verified by the new Gate 1b, §5.)
- **~600 ingests** total; **48 dev / 24 held-out** questions across single-hop, multi-hop,
  temporal-update, abstention (abstention scored only at the e2e checkpoint, as night one). Gold = unique
  high-entropy **marker codes**; deterministic exact-match scoring on the post-trim contextBlock.
- **Cross-scope distractors:** each gold attribute gets **2–4 semantically near** lookalikes planted in
  *other* scopes, so unfiltered semantic recall surfaces the wrong scope's answer (this is what makes
  P1 measurable).
- **Paraphrase gap:** the stored fact and its question use **deliberately different wording** for the
  same thing, so lexical matching fails and embedding retrieval must do the work.

**Hybrid generation (local model + deterministic scaffold):**
- A **local Qwen3-14B via Ollama** (`http://127.0.0.1:11434/v1`, OpenAI-compatible) writes the
  naturalistic facts, questions, and semantically-close distractors at **build time, once**. No frontier
  model, no billed tokens.
- **Code owns everything that affects scoring:** marker codes, scope/session placement, the bury
  ordering, exact-match scoring. The model is a **content source, never trusted raw.**
- **Fail-closed validation on every generated string** (facts, questions, distractors, labels, markers)
  against the forbidden regex — Qwen is exactly what will casually emit "password" or "token." Regenerate
  on a hit; **hard-fail before population** if anything still matches. Also re-assert marker uniqueness
  across dev+held-out and no real scopes.
- Freeze to `dataset.json`; the loop reads the frozen file (no model call ever inside the loop).
- Both Qwen3-14B (~12GB) and `nomic-embed-text` (~0.3GB) fit resident in 16GB — keep both loaded (set
  Ollama `keep_alive`) so there's no load-swap thrash during the checkpoint.

---

## 4. P1 — Scope-filter the semantic recall (behind a flag)

Today `mnemosyneClient.recall({query, limit})` searches the whole shared collection unfiltered, so a
different scope's lookalike outranks the in-scope gold (the observed bleed). This is the one **code-level
retrieval change** this night, and it is **a real correctness/privacy fix for production Sage** (unfiltered
recall leaks one scope's memories into another). Implement it **safely, behind a flag:**

- Add `config.memory.scopeFilter` (boolean, **default `false`**), exposed via env at launch and added to
  the `/admin/memory-config` allowlist so **the loop can toggle it as a knob**.
- In `src/services/memory/mnemosyne-adapter.js` `searchSemantic`: when `scopeFilter` is on, restrict
  semantic results to the requesting scope — either over-fetch from `recall()` and post-filter by the
  `[scope:…]` tag, **or** query Qdrant directly with a payload filter on scope (mnemosy-ai's `recall` has
  no scope param). If over-fetching, fetch enough that post-filter still yields `semanticTopK` in-scope
  hits.
- **Default off** so merging to the real instance changes nothing until deliberately enabled. Only the
  isolated bench instance exercises it this night.
- **No other retrieval-logic changes** — no cross-bucket ranking, dedup, rerank, or query rewriting
  (those are night three). Gate 4 audits this.

The loop will explore both `scopeFilter` states; the archive + report must make the **scoped-vs-unscoped
A/B** explicit.

---

## 5. Gate 1b — "semantic channel is actually exercised" (the linchpin)

New gate, runs **after Gate 1, before the loop**. This proves P0 worked; without it, any P1 conclusion
is meaningless. At baseline config, on the dev set:

- Confirm gold is genuinely arriving via the **semantic** channel, not episodic: **`meanMRR > 0`** (gold
  appears in the semantic bucket) **and** gold-via-semantic clearly exceeds gold-via-episodic (e.g.
  disable/zero the episodic contribution and confirm recall is still materially > 0 from semantic alone).
- If this fails, the benchmark didn't overflow the episodic buffer hard enough: **halt, write
  `GATE_FAILURE.md`** noting that P0 must be strengthened (deeper burial / more facts per scope) before
  proceeding. Do **not** run the loop or draw P1 conclusions over a benchmark that doesn't stress semantic.

This gate is night two's reason for existing — treat a failure here as the most important signal of the
run, not an inconvenience.

---

## 6. The loop, grid, and gates (extended)

- **Mutable surface:** night-one read-side knobs (`semanticTopK`, `episodicTopK`, `contextMaxTokens`)
  **plus** the `scopeFilter` flag. Same EvolveMem-style keep/revert/archive, same caps, same crash-resume,
  same restore-baseline-on-exit.
- **Grid (`--grid`):** the coarse grid now crosses the read-side knobs **× `scopeFilter ∈ {off, on}`**, so
  the grid alone gives a clean scoped-vs-unscoped reference.
- **Gate 2** must now also confirm the **`scopeFilter` flag changes retrieval behaviour** (toggle it and
  verify `semanticMemories` ids / `contextTokenCount` / per-question MRR change) — same crispness as the
  `semanticTopK` check.
- **Gate 3** forced candidates should include a `scopeFilter` toggle so both branches fire across the new
  knob too.
- **Gate 4 (read-only audit)** hard-checklist gains night-two items: `scopeFilter` defaults **off** and is
  the **only** new retrieval-code change; **no P2+ changes** (no new ranking/dedup/rerank/query-rewriting);
  LoCoMo data is **isolated** from the synthetic store (§7); the LoCoMo judge is the **local** model
  (no answerer==judge). Everything else from night one's checklist still applies.

---

## 7. LoCoMo checkpoint (the real-benchmark validation)

Replaces night one's synthetic-only checkpoint. LoCoMo is **public, CC BY-NC 4.0, no auth** — fetch
`data/locomo10.json` from `github.com/snap-research/locomo` (or `raw.githubusercontent.com`). NC licence:
internal evaluation only, never shipped in a product.

- **Ingest** the 10 conversations (light — ~9k tokens each) via `/admin/ingest`, **into their own isolated
  collection/scope namespace** (e.g. `bench_locomo_<runid>`), **separate from the synthetic store**, so
  LoCoMo and synthetic data never bleed into each other's retrievals. Scope per conversation; turns carry
  their `dia_id`.
- **Filter** to memory-relevant categories (single-hop, multi-hop, temporal); **exclude the adversarial
  category**. Use a slice for periodic checkpoints, a larger set for the final comparison.
- **Two scoring signals:**
  1. **Evidence-recall (free, deterministic):** each LoCoMo QA annotates the gold `evidence` dia_ids.
     Score whether the retrieved context contains those turns. No model calls — run this often.
  2. **End-to-end judged accuracy (the credible number, capped):** Sage retrieves → a **cheap cloud
     answering model** (`gpt-5.4-mini` or `gpt-4.1-mini`, held constant) answers → **local Qwen3-14B
     judges** the answer vs the gold (CORRECT/WRONG, via Ollama). **Answerer ≠ judge** (no self-grading).
     Only the answering model is billed; the judge is local and free.
- **The money comparison** (put it in the report): run the LoCoMo checkpoint for **baseline**,
  **loop-best with `scopeFilter` off**, and **loop-best with `scopeFilter` on** — showing whether the
  synthetic-optimised config *and* scope-filtering transfer to real LoCoMo accuracy.

---

## 8. Cost

`$30` ceiling (hard). This night, **only the cloud answering model is billed** — content generation
(Qwen3, local), embeddings (Ollama, local), the inner loop (retrieval-only), evidence-recall scoring, and
the LoCoMo judge (Qwen3, local) are all **free**. So spend = cheap-model answers × (slice × configs
checkpointed), which should land in low single digits; most of the $30 is headroom. Enforce the dual cap
(run count + `$30`), keep a running estimate in `RUN_STATUS.md`, retain `--no-checkpoint-model-calls`.

---

## 9. Outputs

`RUN_REPORT.md` (committed) — comparison table on the **same dev / held-out / LoCoMo sets**:

| Config | knobs + scopeFilter | dev utility | held-out recall/utility | LoCoMo evidence-recall | LoCoMo judged acc |
|---|---|---|---|---|---|
| baseline | … off | | | | |
| loop-best (unscoped) | … off | | | | |
| loop-best (scoped) | … on | | | | |
| grid-best | … | | | | |

Plus: the **scoped-vs-unscoped verdict** (did scope-filtering help, on a benchmark that now measures
semantic — and did it transfer to LoCoMo), the new Gate 1b result, iterations/wall-clock/spend, overfitting
flags, and a **night-three levers** section (P2 cross-bucket ranking, P3 dedup/rerank, P4 query rewriting,
P5 temporal recency, + LongMemEval as the broader checkpoint). Keep `manifest.json` complete (now incl.
`scopeFilter` in knob space, LoCoMo collection, judge=local-Qwen3, answerer model). VC discipline as night
one (no secrets, no large logs).

---

## 10. Gate summary (do not launch unless all pass)

`Gate 0` isolation (incl. LoCoMo collection isolation) → `Gate 1` non-degenerate/deterministic/complete/
uncached → **`Gate 1b` semantic channel exercised (§5)** → `Gate 2` knobs *and* `scopeFilter` change
behaviour → `Gate 3` keep/revert both fire (incl. a `scopeFilter` toggle) → `Gate 4` read-only conformance
audit (§6 checklist). §8.1 retry policy applies to mechanical gates only; Gate 0 and structural failures
halt immediately; Gate 1b failure halts with the P0-too-weak diagnosis. Gate 4 is pass-or-halt, no fix.

---

## 11. Plan-mode + launch

Before building: read the night-one handoff, spec, and run artifacts; confirm Qwen3-14B is pulled
(`ollama list`) and `nomic-embed-text` present; confirm the LoCoMo file is fetchable. Present a plan
covering the generator extension + Qwen3 content step, the `scopeFilter` flag, Gate 1b, the LoCoMo
checkpoint with the local judge, and the gates/caps. **Wait for my approval.** On approval: implement,
pass Gates 0–4 (incl. 1b), then launch the detached loop and write the report. Blocker you can't safely
resolve → stop and write it up. **Stay within V0.2 scope (P0 + P1 only).**