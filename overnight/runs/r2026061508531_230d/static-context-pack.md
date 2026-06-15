# STATIC CONTEXT PACK — Sage memory-retrieval arc (Experiment 5)

Note: overnight/journal.txt does not exist; the arc summary below is assembled from the outcome docs.

## Lessons digest (apply these)
- Recall can come entirely from the episodic ring buffer while semantic contributes nothing (meanMRR=0). Demand evidence the semantic/clean-fact channel is actually exercised before crediting it.
- Offline within-scope cosine rank is NOT a proxy for live retrieval. Trust live numbers.
- A silent ingest-time merge once soft-deleted the gold and invalidated a diagnosis; always check the substrate is doing what it claims (the contract suite is your friend).
- Scope-filtering turned out INCREMENTAL, not dramatic — don't assume a lever is big because it's plausible. Let the benchmark decide.
- A confident diagnosis was once flat wrong (Exp2). Hold conclusions loosely; prefer the boring verified explanation.

## Fallback ladder (spec §1 — bias to fallback over total-halt)
- Phase 0 (machinery) fails -> HALT + report (only correct total-halt).
- Phase 1 (substrate) fails -> disable clean-fact path, run Phase 2 on the CURRENT substrate (Exp3-style result).
- Phase 2 (loop gate) fails -> revert the failing change, report the honest negative + best config.
A true negative or a clean fallback is a SUCCESS. Prefer fallback over total-halt; total-halt only if even the fallback is compromised.

## Round discipline (spec §6, hard)
Each round is a GENUINELY NEW principled hypothesis with a stated rationale — NOT the same change tuned toward the threshold. Max 3 rounds per gate. If you cannot articulate a new hypothesis, return ACCEPT_HALT_FALLBACK rather than burning a round on a tweak. This is the anti-"iterate-until-green" rule.

## Exp1-4 one-liners (spec §8)
- Exp1: EvolveMem loop machinery proven; but recall was episodic-only, semantic meanMRR=0.
- Exp2: buried-gold semantic-stress HALT — the unfiltered channel cannot surface a buried fact among homogeneous cross-scope lookalikes (~49/60 missing).
- Exp3 (V0.3): scope-filter works (scoped 0.72) but the gap vs unscoped is INCREMENTAL — Gate 1b reframed; halted at scopedGap 0.125 (pure-scoping +0.25, pipeline -0.125). $0.
- Exp4: substrate + harness characterized; merge bug fixed (130->620 live points, scopeKey preserved); partial-flag fixed; mem0/episodicTopK=0-floor/D3.1 flagged for decision.

## MEMORY_CONTRACTS.md (validated substrate contracts)
# MEMORY_CONTRACTS.md — Sage memory-retrieval substrate (Experiment 4)

The intended behaviour ("as designed") of each benchmarked memory primitive + the
harness, each locked by a test in `overnight/contracts/`. **Contract test** = asserts the
intended behaviour (red→green for a fixed defect). **Characterization test** = pins the
*current actual* behaviour where intent is flagged for a human decision.

Run: `npm run test:contracts` (isolated Qdrant `:6344` + local Ollama; never touches dev
memories — see `overnight/contracts/README.md`).

Source of truth for code refs: `src/services/memory/` and `node_modules/mnemosy-ai/dist/`.

---

## 1. Ingest / store + dedup-merge  ·  `merge-bug.contract.test.mjs`

**Contract:** Ingesting N distinct episodic turns yields **N live (non-deleted) points**,
each retaining `metadata.scopeKey`, with the gold retrievable within scope. Episodic
turns are raw conversation events and must **never** be semantically merged with each other.

**Implementation:** `mnemosyne-adapter.js storeEpisodic` writes every turn directly via
mnemosy-ai's raw `db.store` (qdrant.js:59), unconditionally — bypassing
`fullStorePipeline`'s dedup/merge (index.js:186-247: `db.search(...,0.85)` → `isDuplicate`
≥0.92 → `softDelete` + metadata overwrite that drops scopeKey).

**Known consequence (explicit):** raw-stored episodic points are **vector-only** — absent
from the in-process BM25 lexical index, because `bm25Index.addDocument` is only called
inside `fullStorePipeline` (index.js:293) and the live `bm25Index` is private to
`createMnemosyne` (not on the client). BM25 re-indexes live Qdrant points only at client
startup (`bootstrapBM25Index`). Restoring episodic BM25 is a deferred harness-level spike
(re-bootstrap post-populate); see DEFECT_INVENTORY #1b.

---

## 2. Embedding (hygiene)  ·  `embedding-hygiene.contract.test.mjs`

**Contract:** `storeEpisodic` embeds the **clean message content**; structural fields
(`scopeKey`, `conversationId`, `role`, `turnIndex`, `messageId`, `timestamp`) live in the
Qdrant payload's `metadata` object, **not** in the embedded text.

**Implementation:** `mnemosyne-adapter.js:52-69` (the committed Exp2 fix).

**Documented divergence (D3.1, not fixed):** `upsertSemanticFacts` (mnemosyne-adapter.js:121-130)
still embeds `[scope][fact_key][version]…` tags in the stored text — the same tag-pollution
bug episodic had. It is **dormant** (fed only by the mem0 path, which is OFF), and fixing it
reaches into the deferred mem0 subsystem. Apply as part of the eventual clean-fact-path
decision (see #8).

---

## 3. semanticTopK → limit  ·  `semantic-topk.contract.test.mjs`

**Contract:** `semanticTopK=k` returns **at most k** semantic results; the knob controls the
count on both paths. (Exp1 fix: mnemosy-ai `recall()` honours `limit`, not `topK`, so
`searchSemantic` passes `limit=topK`.)

**Implementation:** `mnemosyne-adapter.js searchSemantic` — ON: `db.search(...,topK,...)`;
OFF: `recall({ limit: topK, topK })`. ON returns exactly k when ≥k in-scope matches clear
minScore; OFF returns ≤k.

---

## 4. Episodic ring buffer  ·  `episodic-buffer.contract.test.mjs`

**Contract:** per-scope FIFO, **max 20 turns**, returned **most-recent-first**, capped at
`maxItems`; per-scope isolation (one scope's turns never appear in another).

**Implementation:** `mnemosyne-adapter.js:6-16` (`recentEpisodicByScope`, `maxEpisodicPerScope=20`),
`getEpisodicSummaries` (232-241).

**Characterization (intent TBD — FLAGGED):** `getEpisodicSummaries` floors at
`Math.max(1, maxItems)`, so **`episodicTopK=0` returns 1** (the most recent turn), never 0.
Decision needed: deliberate continuity (always surface ≥1 recent turn) vs over-aggressive
guard that prevents clean semantic isolation in the harness. Not changed mid-validation
(the harness handles it via "burial is filler"). See DEFECT_INVENTORY #4.

---

## 5. Semantic recall pipeline  ·  `recall-pipeline.contract.test.mjs` (characterization)

**Contract (the REAL behaviour, documented):**
- **OFF** (`scopeFilter` false): mnemosy-ai `recall()` over the whole shared collection —
  over-fetch ×3 → hybrid(vector+BM25) → decay/multi-signal rescoring + intent threshold
  (≈0.35) + diversity rerank → slice to limit (index.js:304-385; `enableDecay` default ON).
  Reaches cross-scope.
- **ON** (`scopeFilter` true): a **plain `db.search`** (vector + payload filter on
  `metadata.scopeKey`, minScore 0.3) — **no hybrid / decay / rerank**.

**Asymmetry (important for benchmark validity):** ON and OFF apply *different*
post-processing, so an A/B over `scopeFilter` compares scope-restriction **and** pipeline.
This is why Exp3 added a raw-`db.search` unscoped control probe to isolate the pure-scoping
effect. The test proves ON == a direct filtered `db.search` (no extra processing).

---

## 6. Scope handling / scope-filter  ·  `scope-filter.contract.test.mjs`

**Contract:** Scoped recall (`scopeFilter` ON) returns **only in-scope** points (the payload
filter on `metadata.scopeKey` is exact) — privacy + correctness. Unscoped recall (OFF)
searches the whole shared collection and **can** surface cross-scope lookalikes (bleed) —
the realistic condition scope-filtering exists to fix.

**Implementation:** `mnemosyne-adapter.js:175-180`. Depends on the #1 fix preserving
`metadata.scopeKey` (the merge previously stripped it). Demonstrated: scoped query returns
alpha-only; the same unscoped query surfaces beta (bleed).

---

## 7. Context-merge / trim  ·  `context-merge.contract.test.mjs`

**Contract:** buckets kept separate; output order **Identity → Graph → Semantic → Episodic**;
trim order under the token budget **episodic → semantic → graph**, with **identity protected**
(dropped only via the last-resort fallback). No scores are threaded; items are popped from
the end of each bucket.

**Implementation:** `context-merge.js` (`mergeMemoryBuckets`, `buildMemoryContextBlock`,
`formatBucketsAsContext`). Pure functions, no backend.

---

## 8. mem0 path  ·  `mem0-path.contract.test.mjs` (characterization + FLAG)

**Contract (the one the bench depends on):** with mem0 **OFF** (`SAGE_MEM0_ENABLED=false`)
the extraction path is **inert** — `extractFacts` returns `[]`, `ping` returns `"DISABLED"`.

**Exp1 finding:** mem0 extracted **0 facts**. **Static hypothesis** (no dynamic repro): the
mem0 client is built only when `MEM0_API_KEY` is set (mem0-adapter.js:10), and `extractFacts`
returns `[]` whenever `!client` (line 27) — so with no key the adapter reports `enabled:true`
but is **silently inert** (0 facts, no error). Even with a key, extraction is the mem0
**cloud** service (`MemoryClient`, api.mem0.ai) — networked/nondeterministic/billable.

**FLAG (architecture decision — your call, likely its own experiment):** should Sage have a
working clean-fact extraction path at all? If yes, a local-first $0 design needs a different
(e.g. local-LLM) extractor, not cloud mem0. Tied to D3.1 (#2). **Not fixed.**

---

## 9. Config landmines  ·  `config-landmines.contract.test.mjs`

**Contract (actual behaviours to design around):**
- `parsePositiveInteger` **rejects 0**, so `TTL=0` is **rejected** at config load. Disabling
  the query cache must be expressed as `SAGE_REDIS_ENABLED=false`, **not** `TTL=0`.
- The mnemosyne collection name defaults to the hardcoded **`sage_mem_v2`**.
- Cache TTL defaults: identity 300s, query 120s.
- **`partial` (FIXED, D3.2):** a memory result is `partial` only when an **enabled** source
  fails (error/timeout/tripped circuit, `reason !== "disabled"`), not when an adapter is
  disabled by config. (`memory-controller.js:218`; locked by `partial-flag.contract.test.mjs`.)

---

## 10. Harness validity  ·  `harness-validity.contract.test.mjs`

**Contract:**
- Completeness/retrieval count **live** points only. mnemosy-ai soft-deletes via a
  `deleted:true` payload flag and `db.search` filters `deleted=false`; the Exp2 diagnostics
  never checked this flag, so soft-deleted gold was miscounted as present. Locked: a
  soft-deleted point is excluded from both live counting and retrieval.
- The **offline preview is not a proxy for live retrieval**. Offline within-scope cosine
  rank can be excellent (e.g. 0.94) while live **unscoped** recall buries the gold globally;
  the **scoped** channel is what carries it. The test surfaces all three numbers so a future
  offline-vs-live divergence is visible rather than silently assumed away.

**Note (read-after-write):** mnemosy-ai's `db.store` sends `wait:true` in the request body,
but Qdrant honours `wait` only as a query param — so writes are eventually-consistent. The
contract harness `settle()`s (polls live count) before asserting. Documented in
DEFECT_INVENTORY (observation, dependency-side).


## DEFECT_INVENTORY.md (known landmines)
# DEFECT_INVENTORY.md — Sage memory substrate (Experiment 4)

Prioritised by how much each item distorts what the benchmarks measure. Status:
**FIXED** (red→green, committed) · **DOCUMENTED** (characterized/locked, no defect) ·
**FLAGGED** (design judgement for the owner, not fixed) · **DEFERRED** (out of substrate /
later experiment). Tests live in `overnight/contracts/`.

| # | Primitive | Intended contract | Actual (before) | Defect? · severity | Fix / disposition | Risk | Status |
|---|---|---|---|---|---|---|---|
| **1** | **Ingest/store + dedup-merge** | N distinct episodic turns → N **live** points, `scopeKey` preserved, gold retrievable | episodic routed through `fullStorePipeline` → unconditional 0.85/0.92 merge soft-deleted near-dups (12→5 on fixture) and **stripped scopeKey**; gold (planted early) was the merge loser | **YES · CRITICAL** (silently corrupts the benchmark at ingest; invalidated part of Exp2) | `storeEpisodic` **always** uses raw `db.store` (skip merge); removed the bench-only `episodicRawStore` flag (env.js + benchEnv) | behaviour-changing (correct for raw events) | **FIXED** `merge-bug` |
| **1b** | ↳ BM25 side-effect of the #1 fix | (raw store) episodic is vector-only; no in-process BM25 lexical index | n/a (new consequence) | not a defect — accepted regression, made **explicit** | Accept; deferred **harness-level** restore = re-trigger `bootstrapBM25Index` post-populate (no node_modules patch), only when a future experiment needs a realistic hybrid baseline. Conservative for scope-filtering today (BM25 would raise the *unscoped* baseline). | n/a | **DEFERRED** (documented + tested) |
| **2** | **Embedding hygiene** | `storeEpisodic` embeds clean content; structural fields in metadata payload | already correct (Exp2 fix) | no | locked against regression | none | **DOCUMENTED** `embedding-hygiene` |
| **2b** | ↳ semantic-fact tag embedding (D3.1) | facts embed clean content; tags in payload | `upsertSemanticFacts` still embeds `[scope][fact_key]…` tags | YES · LOW (dormant: mem0-fed path, OFF) | **document-only**, bundle with the mem0 clean-fact-path decision (reaches into deferred mem0 subsystem) | behaviour-changing if applied | **FLAGGED / DEFERRED** |
| **3** | **semanticTopK → limit** | `semanticTopK=k` → ≤ k results; knob controls count | already correct (Exp1 fix) | no | locked (ON exactly k; OFF ≤ k) | none | **DOCUMENTED** `semantic-topk` |
| **4** | **Episodic ring buffer** | per-scope FIFO, max 20, newest-first; `episodicTopK=0` behaviour | FIFO/cap correct; **`episodicTopK=0` floors at 1** (`Math.max(1, maxItems)`) | floor: **intent TBD** | **CHARACTERIZE + FLAG** — pinned (returns 1), not changed mid-validation. Decision: deliberate continuity vs over-aggressive guard (prevents clean semantic isolation in the harness) | low if changed | **FLAGGED** `episodic-buffer` |
| **5** | **Semantic recall pipeline** | OFF = recall (over-fetch×3 → hybrid → decay/intent-0.35/diversity rerank → slice); ON = plain filtered `db.search` | as described; **ON/OFF apply different post-processing** | no (but an A/B subtlety) | documented the real contract + the ON/OFF asymmetry (why Exp3 needed the raw-search control probe) | none | **DOCUMENTED** `recall-pipeline` |
| **6** | **Scope handling / filter** | scoped recall → **only** in-scope; unscoped may bleed | ON exact filter on `metadata.scopeKey`; OFF bleeds — but only works because #1 now preserves scopeKey | no (post #1) | locked: ON alpha-only, OFF surfaces beta | none | **DOCUMENTED** `scope-filter` |
| **7** | **Context-merge / trim** | order Identity→Graph→Semantic→Episodic; trim episodic→semantic→graph; identity protected | as designed; no scores threaded | no | locked (pure functions) | none | **DOCUMENTED** `context-merge` |
| **8** | **mem0 path** | OFF → inert, returns `[]` (bench contract) | extracted **0 facts** in Exp1 | **design judgement** | OFF-contract pinned; static 0-facts hypothesis recorded (no `MEM0_API_KEY` → `client` null → silent `[]`; reports `enabled:true`); cloud-only (`mem0ai`). **FLAG: should a clean-fact path exist at all?** No fix, no live calls. | n/a | **FLAGGED** `mem0-path` |
| **9** | **Config landmines** | `TTL=0` rejected; default `sage_mem_v2`; `partial` semantics | `TTL=0` rejected (✔ documented); `partial` true whenever Zep disabled | `partial`: **YES · MEDIUM** (active path; flag meaningless with Zep off) | **D3.2 FIXED** — `partial` ignores `reason:"disabled"` (only enabled-but-failing sources count); TTL=0 + collection default documented | small, in-controller; consumers read-only | **FIXED** `config-landmines`, `partial-flag` |
| **10** | **Harness validity** | completeness counts **live** points; offline ≠ live | completeness uses live `db.search` (✔); offline preview was over-optimistic (Exp2/Exp3) | no (lesson to lock) | locked: soft-deleted excluded from count+retrieval; offline-vs-live divergence surfaced (offline cos 0.94, unscoped miss, scoped hit) | none | **DOCUMENTED** `harness-validity` |
| **obs** | mnemosy-ai `db.store` write-wait | writes are durable+visible before return | `wait:true` sent in **body**; Qdrant honours it only as a **query param** → eventually-consistent reads | dependency quirk (not Sage) | harness `settle()` polls live count before asserting; noted for any future harness that reads-after-write | n/a | **DOCUMENTED** |

## Pre-existing (not introduced by Exp4)

- `test/memory-service.test.js` had a **stale** assertion (`/message_id:/` in embedded text)
  from before the Exp2 embedding-hygiene fix; it was already failing on the baseline. Updated
  to the correct hygiene contract (clean text; `message_id` in metadata) as part of #2, plus
  its stub gained `db.store`/`embeddings.embed` to match the #1-fixed `storeEpisodic`. Full
  `test/` suite: 97/97.

## Headline (the merge fix, before/after)

See `EXPERIMENT_4_OUTCOME.md` — homogeneous fixture live point count and `scopeKey`
preservation, old merge path vs new raw path.


## EXPERIMENT_4_OUTCOME.md (substrate readiness — TL;DR + readiness only)
# Experiment 4 — Outcome: memory substrate characterized, defects fixed-or-flagged, suite green

**Branch:** `experiment/4-memory-substrate` (off `overnight/retrieval-loop-v0.3` @ `a18e51f`)
**Date:** 2026-06-14 · **Spend:** $0 (no model/checkpoint calls; local Ollama embeddings only)
**Shape:** audit → contract-test suite → test-gated fixes (NOT a self-improving loop).

This experiment built the foundation the retrieval experiments lacked: every benchmarked
memory primitive + the harness now has a written contract and a deterministic test, and the
two real defects are fixed red→green. Sage is a hobby project, not in production — fixes
landed directly on the branch, test-gated and git-revertable.

---

## 1. TL;DR

- **Two defects fixed** (each red→green, committed):
  1. **The merge bug (#1, CRITICAL).** Episodic storage now **always** bypasses
     mnemosy-ai's unconditional 0.85/0.92 dedup/merge (raw `db.store`), the proper fix
     (the bench-only `episodicRawStore` flag is removed). **Headline on the 620-fact
     homogeneous fixture: 130 → 620 live points, scopeKey on live 18 → 620, gold markers
     retrievable 130 → 620 of 620.**
  2. **`partial`-when-Zep-off (D3.2, MEDIUM).** A result is `partial` only when an *enabled*
     source fails, not when an adapter is disabled by config.
- **All primitives + the harness characterized and locked** with a committed contract-test
  suite (`overnight/contracts/`, **30/30 green** via `npm run test:contracts`). Whole repo
  (`npm test`) **127/127** (97 pre-existing `test/` + 30 contracts).
- **Three items flagged for your judgement** (no guessing, no fix): the mem0 architecture
  question, the `episodicTopK=0` floor, and the dormant semantic-fact embedding hygiene
  (D3.1). One deferred restore recorded concretely: episodic BM25 re-indexing.

---

## 2. The headline fix (merge bug #1)

Reproduced at full scale on the frozen Exp2/Exp3 dataset (`benchuser_v02build1`, 620
homogeneous facts) via `overnight/contracts/verification/merge-before-after.mjs`:

| path | live | deleted | live w/ scopeKey | gold markers in live |
|---|---|---|---|---|
| **OLD** (`mnemosyneClient.store` → fullStorePipeline merge) | **130** | 480 | 18 | 130 / 620 |
| **NEW** (`storeEpisodic` → raw `db.store`) | **620** | 0 | **620** | **620 / 620** |

(OLD ≈ the Exp3 production measurement of 134 live / 476 deleted / 19 scopeKey — direct-client
reproduction lands at 130/480/18.) The deterministic unit version (`merge-bug.contract.test.mjs`)
shows the same on a 12-turn fixture: merge collapses to 5 live + drops scopeKey; the raw path
keeps 12 live, 0 deleted, scopeKey preserved, gold retrievable.

**Explicit consequence (accepted, your call):** raw-stored episodic points are **vector-only**
— no in-process BM25 lexical index (BM25's `addDocument` fires only inside fullStorePipeline;
the live index is private to mnemosy-ai). This is **conservative** for scope-filtering (BM25
would raise the *unscoped* baseline) and within-process only (BM25 re-bootstraps from Qdrant
at client startup). **Deferred restore:** a harness-level `bootstrapBM25Index` re-trigger
*after* populate (no node_modules patch), to run only when a future experiment needs a
realistic hybrid baseline. Tested + documented, not silent.

---

## 3. What was validated / fixed / flagged / deferred

| Primitive | Disposition |
|---|---|
| Ingest/store + dedup-merge | **FIXED** (raw episodic store) |
| `partial` flag (Zep off) | **FIXED** (D3.2) |
| Embedding hygiene (episodic) | **LOCKED** (was correct) |
| `semanticTopK`→`limit` | **LOCKED** (was correct) |
| Episodic ring buffer | **LOCKED**; `episodicTopK=0` floor **FLAGGED** |
| Semantic recall pipeline | **DOCUMENTED** (ON/OFF asymmetry) |
| Scope handling / filter | **LOCKED** (works now that #1 preserves scopeKey) |
| Context-merge / trim | **LOCKED** |
| mem0 path | **FLAGGED** (architecture decision) |
| Config landmines (TTL=0, collection, partial) | **DOCUMENTED** + partial **FIXED** |
| Harnes
…[truncated]…