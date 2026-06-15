# SAGE V2 — Night-One Handoff → Night-Two Planning

**Run:** `r2026061323573_9362` · **Date:** 2026-06-14 · **Branch:** `overnight/retrieval-loop-v0.1`
**Build commit:** `4bbe6f8` · **Morning artifacts commit:** `699c48f` (neither pushed)
**Status:** V0.1 machinery-proof **COMPLETE and PASSED.** Gates 0–4 all passed; loop ran detached, converged on its own, BEAT the reference grid, spent **$0.31 / $40**, no crashes/restarts.

This doc is the briefing for the **night-two planning chat**. Night one proved the *machinery* (a closed, safe, self-improving loop over read-side config). Night two is the **code-level retrieval action space** that V0.1 deliberately excluded.

---

## 1. TL;DR

- Built a closed self-improvement loop that tunes Sage's read-side memory knobs against a synthetic, seeded benchmark — keep/revert per iteration, with a reference grid search, capped end-to-end checkpoints, and a detached overnight run that writes a morning report.
- It works. The loop **beat** the exhaustive coarse grid **and generalized better**: loop-best held-out recall **0.462** vs grid-best **0.000** (grid-best overfit to dev via the cost term).
- It surfaced **concrete, evidence-backed night-two targets** — most importantly that **semantic recall is not scope-filtered** (a different scope's answer bled into context during a live diagnostic).
- The synthetic benchmark currently **under-stresses the semantic channel** (markers resolve mostly via the per-scope *episodic* ring buffer). **Night two must strengthen the benchmark to measure semantic-side fixes** — see §6.

---

## 2. Night-one results

Converged at **iter 117** (~40 min grid + ~26 min loop), stop reason = 100 iterations with no improvement.

| Config | Knobs | Dev utility | Held-out recall / utility | e2e checkpoint (gpt-5.2) |
|---|---|---|---|---|
| baseline | s5 / e3 / c1200 | 0.103 | 0.000 / −0.054 | — |
| grid-best | s1 / e10 / **c400** | 0.519 | **0.000** / −0.018 | 0/8 |
| **loop-best** | **s20 / e16 / c4000** | **0.666** (recall 0.77) | **0.462** / 0.342 | 1/8 |

- Utility = `mean(recall@ctx) − λ·mean(contextTokenCount)`, λ=5e-5, computed on the **post-trim** contextBlock.
- Determinism noise band 0.0015 → keep-threshold widened to exceed it (noise-aware, as specced).
- Checkpoint: 3 runs, **$0.31** (conservative upper-bound rates $3/$15 per 1M; real ≈ less).
- Verdict **BEAT** is corroborated by generalization, not just the cost/MRR tradeoff — a genuine win.

---

## 3. Architecture facts night two MUST know (the load-bearing gotchas)

These were learned the hard way; they shape every night-two change.

1. **`semanticTopK` was inert; now fixed.** `mnemosy-ai`'s `recall()` honors `limit` (default 5) and ignores `topK` (`node_modules/mnemosy-ai/dist/index.js:415`). Sage passed `topK`. Fixed in `src/services/memory/mnemosyne-adapter.js` `searchSemantic` → `recall({ query, limit: topK })`. **This was the only code-level retrieval change in V0.1, and it was explicitly user-authorized.**
2. **The episodic channel dominates retrieval here, not semantic.** Markers resolve via the in-process per-scope episodic ring buffer (`mnemosyne-adapter.js` `recentEpisodicByScope`, last **20** turns/scope), so `meanMRR` (semantic-bucket rank) stayed **0** even at recall 0.77. Implication: semantic-side fixes won't move the current benchmark (see §6).
3. **Semantic recall is NOT scope-filtered** — `recall()` searches the whole shared collection. Live diagnostic proof: asking for "Crimson Lynx wharf badge colour code", a *different* scope's badge code (`Saffron Otter yard → F8X0BWYS`) appeared in context and crowded out the in-scope gold. This is night-two lever #1.
4. **`mnemosy-ai` hardcodes collection names** `memory_private` / `agent_profiles` / `skill_library` (`core/types.js:21-23`); only the *shared* collection is renamable. That's why isolation used a **separate Qdrant**, not just a collection name.
5. **Query cache:** `SAGE_MEMORY_QUERY_CACHE_TTL_SEC=0` is **rejected** by `parsePositiveInteger`. Cache is disabled via `SAGE_REDIS_ENABLED=false` (the controller short-circuits `getQueryContext`/`setQueryContext` when the redis adapter is disabled). Gate 1 verified `cacheHit=false`.
6. **`partial` is always true with Zep off** (`partial = !graph.ok || …`). Use `budgetExceeded` for timeout/warmup signals, not `partial`.
7. **Retrieval window is cached at controller init** (`retrievalWindowMs`), so the time budget must be set at launch (8000ms) and is NOT runtime-mutable — correct, since the budget is fixed-not-tuned by design.
8. **Upstream key wiring:** chat calls use `SAGE_LLM_LOCAL_API_KEY` (tried first) / `SAGE_LLM_CLOUD_API_KEY` (fallback), local-first routing (`llm-router-service.js`), NOT `OPENAI_API_KEY` directly. Verify the live key via the startup `Active upstream API key fingerprint` log (added in `src/index.js`, last-6 only).
9. **Forbidden-word landmine:** the memory layer silently drops text matching `/secret|password|token|api ?key|card|ssn/i`. The generator validates all text + markers before population and fails closed.

---

## 4. Key findings (with evidence)

- **Machinery is sound.** Keep/revert both fire (5 keeps / 115 reverts archived), grid↔loop comparison is apples-to-apples, crash-resilience + restart→fresh-collection + Gate-0-on-every-relaunch all implemented, detached run self-bounded by caps.
- **Loop > grid, and generalizes.** §2 table. Grid-best's tiny context (c400) won on dev by minimizing the cost term but retrieved nothing on held-out; the loop's generous config actually transfers.
- **Low e2e accuracy is a retrieval-coverage gap, not a model gap.** When the gold wasn't retrieved, gpt-5.2 **correctly abstained instead of hallucinating** ("I can't extract it without inventing one"). For a single-hop question that scores as a miss, so e2e accuracy ≈ retrieval coverage on the slice. The model's anti-hallucination behavior is exemplary.

---

## 5. Known limitations / artifacts of the V0.1 benchmark (fix/plan for night two)

- **Semantic channel under-stressed** (episodic ring buffer holds all of each small scope's facts) → semantic fixes are currently unmeasurable. **Biggest thing to fix in the benchmark.**
- **Cross-scope bleed** inflates noise and is the #1 retrieval defect (also a lever).
- **e2e grading**: a correct abstention on a *missing* single-hop gold counts as a miss. Consider separating "abstained" from "wrong".
- **Checkpoint writes contaminate held-out scopes** slightly (the chat path stores the question turn). Minor; only affects held-out, never dev. A read-only chat path (or a no-write flag) would remove it.
- **Temporal "stale absent"** relies on phrasing, not a real recency/supersession signal.
- **Dataset is small** (140 facts, 32 dev / 16 held-out, ≤20 turns/scope). Fine for a machinery-proof; too small/easy to differentiate retrieval algorithms.
- **`graphMaxResults` inert** (Zep off) — leave it off unless re-enabling graph is a night-two goal.

---

## 6. Night-two action space (prioritized)

Night two = **code-level retrieval changes** (now in scope). Each should be measured by re-running the same benchmark harness (§7) and comparing to the night-one baseline/grid/loop numbers — **but first strengthen the benchmark so the semantic channel matters.**

**P0 — Strengthen the benchmark to expose semantic retrieval (prereq for P1/P2).**
- Plant **>20 facts per scope** (overflow the episodic ring buffer) and/or add many same-attribute cross-scope distractors, so the gold *must* come from scope-filtered semantic recall, not episodic.
- Add an explicit "abstained vs wrong" distinction to e2e grading.
- Where: `overnight/harness/generate.js` (sizes/distractors), `overnight/harness/loop.js` `checkpointSlice` (grading).

**P1 — Scope-filter the semantic recall.** *Highest-value, evidence-backed.*
- Today `mnemosyneClient.recall({query, limit})` returns cross-scope hits. Filter to the requesting scope.
- Where: `src/services/memory/mnemosyne-adapter.js` `searchSemantic` — post-filter recalled results by the `[scope:…]` tag, or query Qdrant directly with a payload filter (mnemosy-ai's `recall` has no scope param, so this is genuinely code-level).
- Expected: higher precision, makes `semanticTopK` effective, removes the observed bleed.

**P2 — Cross-bucket ranking / fusion before trim.**
- `context-merge.js` `buildMemoryContextBlock` concatenates identity→graph→semantic→episodic then pops from the end (episodic→semantic→graph). Scores aren't threaded in (`searchSemantic` drops the similarity score). Thread scores through and rank by relevance before trimming so the best items per token survive.
- Where: `src/services/memory/mnemosyne-adapter.js` (keep score), `src/services/memory/context-merge.js` (rank-then-trim).

**P3 — Dedup / rerank.** Episodic storage repeats near-identical verbose turns (each ~50–80 tokens of bracket tags). Dedup + a reranker would cut wasted `contextMaxTokens` and raise effective recall per token.

**P4 — Query rewriting / multi-hop decomposition.** Multi-hop needs both facts; decompose into sub-queries and union results. Where: `memory-controller.js` `retrieveContext`.

**P5 — Temporal recency / supersession ranking.** Make "stale absent" robust via an explicit recency or version signal (note `mnemosyne-adapter.js` `normalizeFact` already has version/status/eventTime logic, but it's on the mem0 fact path which is off).

---

## 7. How to reproduce / re-run the benchmark (regression harness for night two)

The harness IS the night-two regression test. After a retrieval-code change, re-run and compare to night-one numbers.

1. **Bench backing stack (throwaway, isolated):**
   ```bash
   docker run -d --name qdrant_bench  -p 6344:6333 qdrant/qdrant
   docker run -d --name redis_bench   -p 6345:6379 redis:7-alpine
   docker run -d --name falkordb_bench -p 6346:6379 falkordb/falkordb
   ```
2. **Gated run (foreground), then audit, then detached loop** — same flow as night one:
   ```bash
   # gates (launches isolated bench Sage on 8799, Gate0→populate→Gates1-3, leaves Sage up)
   node overnight/harness/loop.js --phase gates --run <newid> --grid \
     --checkpoint-model gpt-5.2 --checkpoint-budget 60 --checkpoint-cost-ceiling 40
   # then spawn the Gate-4 read-only audit, then:
   # detached overnight loop (PowerShell Start-Process), which adopts the bench Sage
   node overnight/harness/loop.js --phase run --run <newid> --grid \
     --checkpoint-model gpt-5.2 --checkpoint-budget 60 --checkpoint-cost-ceiling 40
   ```
3. **Cheap validation:** `node overnight/harness/loop.js --dry-run --iterations 3 --grid` (no model calls; tears its bench Sage down at the end).
4. **Knobs/caps (CLI):** `--iterations`, `--wall-clock-hours`, `--convergence`, `--lambda`, `--concurrency`, `--seed-dev`, `--seed-heldout`, `--no-checkpoint-model-calls`.
5. **Gate discipline still applies:** do not launch unless Gates 0–4 pass; on failure it writes `GATE_FAILURE.md` (+ `VERIFICATION.md`) and halts.

**Important for night two:** changing retrieval code changes Sage behavior for the **real** instance too once merged. Keep the separate-Qdrant isolation; consider gating new retrieval behavior behind a config flag so A/B (old vs new) is measurable in one run.

---

## 8. Open questions for the planning chat

- Do P0 benchmark-hardening + P1 scope-filtering together (so P1 is measurable), or land P1 behind a flag and A/B it?
- Should scope-filtering be a hard behavior change or a `config.memory.*` flag (so the loop can even tune "scoped vs unscoped")?
- Re-enable graph (Zep/FalkorDB) as a night-two channel, or keep semantic-only?
- Grow the dataset (more scopes, deeper per-scope history) — how big before scoring stays "seconds"?
- Keep gpt-5.2 for checkpoints, or drop to a cheaper model now that the path is proven?

---

## 9. File map

- **Spec / context:** `overnight/SAGE_V2_OVERNIGHT_SPEC.md`, `overnight/SETUP_STATUS.md`, this doc.
- **Run output:** `overnight/runs/r2026061323573_9362/` → `RUN_REPORT.md`, `VERIFICATION.md`, `manifest.json`, `archive-summary.json`, `archive.jsonl`, `grid.jsonl`, `RUN_STATUS.md`, `logs/`.
- **Admin hooks (additive):** `src/http/routes/admin.js`, wired in `src/app.js`, flag in `src/config/env.js`.
- **Retrieval code (night-two targets):** `src/services/memory/memory-controller.js`, `…/mnemosyne-adapter.js`, `…/context-merge.js`, `…/redis-cache.js`.
- **Harness:** `overnight/harness/{generate,gates,loop}.js`, `overnight/harness/lib/{rng,forbidden,sage-client,score,archive,supervisor}.js`.
- **Key wiring fix:** `src/services/memory/mnemosyne-adapter.js` (`searchSemantic`), fingerprint log in `src/index.js`.

---

## 10. What to attach to the night-two planning chat

That chat will be Claude Code in this repo, so it can read everything — but attach these to brief it fast:

**Must attach (orient the chat):**
1. `overnight/HANDOFF_NIGHT_TWO.md` (this doc)
2. `overnight/runs/r2026061323573_9362/RUN_REPORT.md`
3. `overnight/SAGE_V2_OVERNIGHT_SPEC.md` (scope/constraints/gate discipline to carry forward)

**Helpful context:**
4. `overnight/runs/r2026061323573_9362/manifest.json` and `archive-summary.json` (baseline numbers to beat)
5. `overnight/runs/r2026061323573_9362/VERIFICATION.md` (what the build conforms to)
6. `overnight/SETUP_STATUS.md` (real-stack setup + landmines)

**The code it'll modify (already in-repo; attach if you want them in context immediately):**
7. `src/services/memory/mnemosyne-adapter.js`, `…/memory-controller.js`, `…/context-merge.js`
