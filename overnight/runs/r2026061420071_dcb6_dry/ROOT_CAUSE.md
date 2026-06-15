# V0.3 dry-run — ROOT CAUSE of the populate-completeness halt

**Run:** `r2026061420071_dcb6_dry` · **Date:** 2026-06-14 · **Spend:** $0 (halted before launch)
**Branch:** `overnight/retrieval-loop-v0.3` (commit `c035290`) · reused frozen V0.2 dataset `benchuser_v02build1`.

## Verdict
The halt is **NOT** a "scoped retrieval doesn't transfer" finding. It is **benchmark corruption by
mnemosy-ai's unconditional dedup/merge at ingest**, which destroys the gold facts *before any retrieval
runs*. No scope-filter (or any retrieval-side) change can pass while this holds. This also **supersedes part
of the Experiment-2 diagnosis** (see below).

## What the gates caught
Scoped populate-completeness (Change 2b: `verifyCompleteness` at `scopeFilter:1`, generous K s30/e20)
reported **56 markers missing** across the 61 scored questions, on all 6 settle attempts. Halted, $0.

## Direct diagnostics against `qdrant_bench` (collection `bench_..._dcb6_dry_e1`, persists after teardown)
`overnight/runs/.../diag_markers.mjs` + `diag_markers2.mjs`:

| metric | value |
|---|---|
| facts ingested | 620 |
| points stored | **610** (10 dropped as pure duplicates, never stored) |
| points **soft-deleted by merge** | **476** |
| **live (non-deleted) points** | **134** (≈4.6× collapse of 620 distinct facts) |
| live points retaining `metadata.scopeKey` | **19 / 134** |
| completeness questions | 61 |
| gold marker in **any live** point | **13 / 61** |
| gold marker **only in a soft-deleted** point | **48 / 61** |
| gold in a live point **with matching `scopeKey`** | **4 / 61** |

## Mechanism
`mnemosy-ai`'s `fullStorePipeline` (`dist/index.js`) runs an **unconditional** dedup/merge on every store:
`db.search(collection, vector, 1, 0.85)` → `isDuplicate`/`shouldSemanticMerge`. There is **no config flag**
to disable it (`dist/config.js` has none; the 0.85 threshold is hardcoded).

On the homogeneous benchmark facts (`"the {attr} for {entity} is {code}"`), pairwise cosine routinely
exceeds 0.85, so merge fires constantly. When it merges, it:
1. keeps the **incoming (later)** fact's text, **soft-deletes** the existing point, and demotes the existing
   text to `metadata.merged_old_text` (a non-searchable payload field); and
2. **overwrites `metadata`** with merge bookkeeping (`merged_from/at/old_text`), **dropping `scopeKey`**
   (`index.js`: `metadata: mergedMeta.length>0 ? mergedMeta : options.metadata`).

The **bury mechanic plants gold early**, so the gold fact is almost always the *earlier* point → the
**merge loser** → soft-deleted → unretrievable (`db.search` always filters `deleted=false`). Hence 48/61
gold markers live only in deleted points, and only 4/61 are scope-filterable.

## Why this supersedes part of the Experiment-2 finding
Exp2's `GATE_FAILURE_NIGHT_TWO.md` attributed the unfiltered halt to candidate-set competition among
homogeneous vectors ("`recall` returned only ~10/~3 items; gold never among them"). Those **low return
counts are the symptom of 78% of points being soft-deleted by merge**, not (only) ranking competition. The
six Exp2 diagnostics tested ranking but never checked the `deleted` flag or `points_stored` vs `ingested`.
Embedding hygiene improved things 0→~18% by making *surviving* points' content drive the cosine, but it
could not recover the soft-deleted gold.

## Consequence for the experiment
The benchmark cannot be stored intact through `mnemosyneClient.store()`. Until ingestion preserves the
distinct facts (and their `scopeKey`), the within-scope payload-filter cannot be evaluated — the gold it
would retrieve isn't in the live store. This is an **ingestion/infrastructure blocker beyond the agreed
two-change surgical scope**, so the run is halted and reported rather than fixed unilaterally (mirroring the
Exp2 precedent where the embedding-hygiene ingestion fix was explicitly authorized, not assumed).

## Candidate fix (not applied — pending authorization)
Bench-only "raw episodic store": in `storeEpisodic`, behind a new flag (default **OFF**; bench sets it ON),
write via the raw `mnemosyneClient.db.store(text, await embeddings.embed(text), { ...payload, metadata:{
memoryClass:"episodic", scopeKey, ... }})` — bypassing `fullStorePipeline`'s dedup/merge. This stores every
fact as a distinct live point and preserves `metadata.scopeKey`, with **zero production change** (flag off by
default). Then re-run the $0 dry-run and let the reframed Gate 1b adjudicate the actual hypothesis.
