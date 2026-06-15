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

**D3.1 — FIXED in Experiment 5** (`clean-fact-hygiene.contract.test.mjs`): `upsertSemanticFacts`
was rewritten to embed the **fact text only** (no `[scope][fact_key][version]…` tags) and store
each distinct atomic fact via **raw `db.store`** (bypassing the merge, like `storeEpisodic`), with
structural fields in payload `metadata` (`memoryClass:"semantic_fact"`, `scopeKey`, `factKey`,
`version`, `status`, `sourceMessageId`, `sourceTurnIds`). This resolves the tag-pollution bug AND
applies the Exp4 merge-bug fix to the semantic path. Clean-fact points live in the shared
collection tagged `semantic_fact`, so the scoped semantic search (`db.search` filtered on
`metadata.scopeKey`) returns them **in addition to** the raw episodic ring. Fed by the local
clean-fact extractor (see #8), no longer the dead mem0 path. The mem0-era `normalizeFact`
conflict/versioning helpers were removed (distinct atomic facts are not duplicates).

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

**RESOLVED in Experiment 5 — local clean-fact extractor:** the architecture question ("should a
clean-fact path exist, and if so local not cloud?") was answered by building a **$0 local
extractor** (`src/services/memory/local-extractor-adapter.js` + `ollama-chat.js`): per-turn
`qwen3:14b`/Ollama extraction (temperature 0 + fixed seed) of distinct atomic facts, preserving
codes/identifiers verbatim, gated by **`SAGE_CLEANFACT_ENABLED`** (default OFF; the bench turns it
ON). **mem0 stays OFF/inert** — this is a sibling adapter, not a mem0 revival. Validated by
`overnight/harness/cleanfact-validate.mjs` (Gate 1a marker-preservation 12/12, Gate 1c determinism
1.0). Facts are stored clean per the rewritten `upsertSemanticFacts` (#2). The mem0-OFF contract
above is unchanged.

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
