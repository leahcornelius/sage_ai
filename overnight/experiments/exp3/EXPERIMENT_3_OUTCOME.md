# Experiment 3 (V0.3) — Outcome: two findings, HALTED at the reframed Gate 1b (no launch, $0)

**Branch:** `overnight/retrieval-loop-v0.3` (off `overnight/retrieval-loop-v0.2` @ `2423b0a`)
**Date:** 2026-06-14 · **Status:** Build complete; dry-run reached the reframed Gate 1b and **halted on the
scoped-gap criterion**. Nothing launched, **$0 spent**. Two changes shipped as designed (within-scope
payload-filter P1 + Gate 1b reframe); one authorized infra fix added mid-run (bench-only merge bypass).

This run produced **two** results: a deeper root cause that supersedes part of the Experiment-2 finding,
and a clean adjudication of the scope-filtering hypothesis.

---

## 1. TL;DR

- The first dry-run **halted at populate-completeness** — but diagnosis showed the cause was **not**
  retrieval: mnemosy-ai's **unconditional 0.85-cosine dedup/merge** at ingest collapsed the 620 homogeneous
  facts to **134 live points (476 soft-deleted)** and **stripped `metadata.scopeKey`**. Because the bury
  mechanic plants gold *early*, gold is the merge *loser* → **48/61 gold markers existed only in
  soft-deleted points** (filtered out before any retrieval) and only **4/61** were scope-filterable.
  **This supersedes part of the Experiment-2 diagnosis**: its "`recall` returned ~10/~3 items, gold never
  among them" symptom was 78% of points soft-deleted by merge, which the six Exp2 diagnostics missed.
- With authorization, a **bench-only raw-episodic-store bypass** (flag default OFF; production unchanged)
  was added: episodic turns write directly via mnemosy-ai's raw `db.store`, skipping dedup/merge. Result:
  **620/620 points, 0 deleted, `scopeKey` preserved, scoped completeness 100% on the first settle.** The
  benchmark is now stored intact and the within-scope rank-1–2 evidence **transferred to the live pipeline**.
- The re-run reached the **reframed Gate 1b**, which **HALTED on `scopedGap` only**. Every other criterion
  passed strongly. Per the run rule (*one behavioural change; if Gate 1b doesn't pass, accept the halt, no
  tuning*), the run is halted and reported. **Nothing launched.**

---

## 2. The reframed Gate 1b result (the adjudication)

Dev set, floors on single+temporal (32 questions), `contextMaxTokens=2000`. All deterministic, $0.

| Probe | config | meanRecall | meanMRR |
|---|---|---|---|
| **A** scoped, both channels | s5/e3, sf ON | — | **0.832** |
| **B′** scoped, semantic-only | s5/e0, sf ON | **0.719** | — |
| **C** episodic-only | s0/e3, sf OFF | **0.000** | — |
| **B_unscoped** unscoped, semantic-only (recall pipeline) | s5/e0, sf OFF | **0.594** | — |
| **B_dbsearch_unscoped** raw unscoped vector search (control probe) | db.search, no filter | **0.469** | — |

| Criterion | value | threshold | verdict |
|---|---|---|---|
| meanMRR_A | 0.832 | ≥ 0.20 | ✅ |
| meanRecall_B′ | 0.719 | ≥ 0.50 | ✅ |
| meanRecall_C | 0.000 | ≤ 0.10 | ✅ (burial holds) |
| attribution (recall_A==1 → mrr_A>0) | 1.00 | ≥ 0.70 | ✅ |
| **scopedGap = B′ − B_unscoped** | **0.125** | **≥ 0.30** | **❌ HALT** |

**Control-probe attribution of the gap** (your addition — measurement-only, not pass/fail):
- **pure scoping effect** = B′ − B_dbsearch_unscoped = 0.719 − 0.469 = **+0.250**
- **pipeline effect** = B_dbsearch_unscoped − B_unscoped = 0.469 − 0.594 = **−0.125**

---

## 3. Interpretation

- **Scope-filtering works.** The within-scope payload-filter carries the gold: scoped semantic recall
  **0.72**, scoped MRR **0.83**, and over naive global vector search it adds **+0.25** recall.
- **But unscoped recall is already strong (0.59),** so the *marginal* benefit of scoping over the existing
  pipeline is only **+0.125** — below the 0.30 "dramatic headline" bar the spec set. The control probe
  explains why: the production recall pipeline over-fetches (`limit*3` → rerank → top-K) and recovers
  **+0.125** of the gold globally *without* scoping. On intact storage the global pool does **not** bury the
  gold as severely as Experiment-2 (whose store was corrupted by merge) implied.
- **Net:** scope-filtering is a real, positive retrieval/privacy improvement, but on this benchmark it is an
  **incremental** gain over a decent unscoped pipeline, not the dramatic A/B the 0.30 gate demanded.

---

## 4. Honest caveats

- **BM25/hybrid is absent for raw-stored points** (the raw store bypasses `bm25Index.addDocument`), so both
  unscoped arms are **vector-only**. This is a clean within-scope-vs-global *vector* comparison. If anything
  it is **conservative**: with hybrid active, lexical matching on the unique per-scope entity names would
  raise unscoped recall further and **shrink** the gap — so the "incremental" conclusion is robust.
- **Temporal questions** (8/32 floor) score `recall=0` with `mrr=1` across *all* arms: the stale
  prior-version marker co-retrieves with the updated one (both in-scope), failing the binary
  updated-present-AND-stale-absent rule. This depresses every arm equally and does **not** affect the gap;
  it is a benchmark/temporal-handling artifact (a P5 temporal-recency concern, out of scope here).
- Offline preview foreshadowed this: `within5UnscopedRate=0.80`, `within5ScopedRate=1.00`,
  `meanGoldCosine=0.854`.

---

## 5. Changes made (all merge-safe; production unchanged by default)

1. **Within-scope payload-filter P1** (`searchSemantic` ON path) — direct `mnemosyneClient.db.search` on the
   shared collection filtered by `metadata.scopeKey`, same embedder; OFF path unchanged. Flag default OFF.
2. **Gate 1b reframe** to the scoped channel + the **`B_dbsearch_unscoped` control probe** (harness-only).
3. **Scoped populate-completeness** pre-check (measurement-only) so the experiment can reach Gate 1b.
4. **Bench-only raw-episodic-store** (`config.memory.episodicRawStore`, env `SAGE_MEMORY_EPISODIC_RAW_STORE`,
   **default OFF**; the bench sets it ON) — episodic turns write via raw `db.store`, bypassing the
   unconditional dedup/merge. *Authorized mid-run* (mirrors the Exp2 embedding-hygiene precedent).

Production retrieval/ingestion is byte-for-byte unchanged with all flags at their defaults.

## 6. Night-three / forward levers

1. **Lower the headline bar, or re-scope the claim.** The data supports "scope-filtering improves retrieval
   quality and isolates scopes (privacy), +0.25 over naive global, incremental over the tuned pipeline" —
   not a 0.30 dramatic gap. A future gate could target MRR/precision or privacy-leak rate rather than a
   recall gap, since unscoped recall is already high.
2. **Fix episodic dedup upstream.** mnemosy-ai merges *episodic* turns with each other (wrong for raw
   conversation events). The raw-store flag is a bench workaround; the production fix is to make episodic
   storage skip semantic dedup/merge (or land episodic in a non-deduped path). Worth raising with mnemosy-ai.
3. **Hybrid/BM25 in the comparison** — re-run with BM25 populated for the unscoped arm to measure the gap
   under production hybrid retrieval (expected: even smaller gap).
4. **P2+ retrieval** (cross-bucket ranking, dedup/rerank at query, query-rewrite, temporal recency) and
   **LongMemEval** remain the broader agenda.

## 7. Artifacts

- `overnight/runs/r2026061420071_dcb6_dry/` — first halt + **`ROOT_CAUSE.md`** (merge corruption) +
  `diag_markers*.mjs` (the marker-survival diagnostics).
- `overnight/runs/r2026061420332_f4c0_dry/GATE_FAILURE.md` — the reframed Gate 1b evidence (per-item ranks,
  control-probe deltas, offline preview).
- `overnight/dryrun_v03.console.log`, `overnight/dryrun_v03b.console.log` — run consoles.
