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
| **2b** | ↳ semantic-fact tag embedding (D3.1) | facts embed clean content; tags in payload | was: `upsertSemanticFacts` embedded `[scope][fact_key]…` tags + routed through merge | YES · LOW (was dormant) | **FIXED in Exp5**: `upsertSemanticFacts` rewritten — embeds fact text only, raw `db.store` (no merge), structural fields in `metadata` (`semantic_fact`/`scopeKey`/`factKey`); mem0-era `normalizeFact` removed | behaviour-changing (intended; clean-fact path) | **FIXED** `clean-fact-hygiene` |
| **3** | **semanticTopK → limit** | `semanticTopK=k` → ≤ k results; knob controls count | already correct (Exp1 fix) | no | locked (ON exactly k; OFF ≤ k) | none | **DOCUMENTED** `semantic-topk` |
| **4** | **Episodic ring buffer** | per-scope FIFO, max 20, newest-first; `episodicTopK=0` behaviour | FIFO/cap correct; **`episodicTopK=0` floors at 1** (`Math.max(1, maxItems)`) | floor: **intent TBD** | **CHARACTERIZE + FLAG** — pinned (returns 1), not changed mid-validation. Decision: deliberate continuity vs over-aggressive guard (prevents clean semantic isolation in the harness) | low if changed | **FLAGGED** `episodic-buffer` |
| **5** | **Semantic recall pipeline** | OFF = recall (over-fetch×3 → hybrid → decay/intent-0.35/diversity rerank → slice); ON = plain filtered `db.search` | as described; **ON/OFF apply different post-processing** | no (but an A/B subtlety) | documented the real contract + the ON/OFF asymmetry (why Exp3 needed the raw-search control probe) | none | **DOCUMENTED** `recall-pipeline` |
| **6** | **Scope handling / filter** | scoped recall → **only** in-scope; unscoped may bleed | ON exact filter on `metadata.scopeKey`; OFF bleeds — but only works because #1 now preserves scopeKey | no (post #1) | locked: ON alpha-only, OFF surfaces beta | none | **DOCUMENTED** `scope-filter` |
| **7** | **Context-merge / trim** | order Identity→Graph→Semantic→Episodic; trim episodic→semantic→graph; identity protected | as designed; no scores threaded | no | locked (pure functions) | none | **DOCUMENTED** `context-merge` |
| **8** | **mem0 path / clean-fact extraction** | a working clean-fact path should exist, local not cloud | mem0 extracted **0 facts** (cloud-only, inert without key) | **design judgement → answered** | **RESOLVED in Exp5**: built a $0 **local** extractor (`local-extractor-adapter.js`, qwen3:14b, `SAGE_CLEANFACT_ENABLED`) as a sibling adapter; **mem0 stays OFF/inert** (its OFF-contract unchanged). Validated marker-preservation 12/12 + determinism 1.0. | behaviour-changing (new opt-in path) | **RESOLVED** `mem0-path` + local extractor |
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
