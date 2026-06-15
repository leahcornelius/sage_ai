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
  suite (`overnight/contracts/`, **30/30 green** via `npm run test:contracts`). With the
  contract backends reachable, that is **127/127** total (97 pre-existing `test/` unit tests
  + 30 contracts); see the conditional note below.
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
| Harness validity (live-count, offline≠live) | **LOCKED** |
| mnemosy-ai write-wait (db.store) | **DOCUMENTED** (dependency quirk; harness `settle()`s) |

Full detail + code refs: `MEMORY_CONTRACTS.md`; prioritised table: `DEFECT_INVENTORY.md`.

---

## 4. Flagged for your judgement (report-and-pause — not guessed, not fixed)

1. **mem0 path — should a working clean-fact extraction path exist at all?** It extracted 0
   facts in Exp1. Static cause (no dynamic repro): the client is built only with a
   `MEM0_API_KEY`, and `extractFacts` returns `[]` when the client is null — so unconfigured,
   it reports `enabled:true` yet is silently inert. Even configured, it's the mem0 **cloud**
   service (networked/nondeterministic/billable), at odds with a local-first $0 design. This
   is an **architecture** call, likely its own experiment.
2. **`episodicTopK=0` floors at 1.** Deliberate continuity (always surface ≥1 recent turn) or
   an over-aggressive guard that blocks clean semantic isolation in the harness? Pinned by a
   characterization test; not changed mid-validation.
3. **D3.1 — `upsertSemanticFacts` still embeds structural tags** (same bug episodic had). It's
   **dormant** (mem0-fed path, OFF) and fixing it reaches into the deferred mem0 subsystem.
   Document-only now; apply with the mem0 clean-fact-path decision.

---

## 5. Readiness statement — which primitives are trustworthy to benchmark on

**Trustworthy now (locked by a passing contract test):**
- **Episodic ingest/store** — N distinct turns → N live points, scopeKey preserved
  (the corruption that invalidated Exp2/Exp3 is gone). ✅
- **Embedding hygiene** (episodic clean content). ✅
- **`semanticTopK`** count control (ON exact-k, OFF ≤k). ✅
- **Scope filter / scope isolation** — scoped recall is in-scope-only; unscoped bleeds. ✅
- **Context-merge / trim** order + identity protection. ✅
- **Semantic recall pipeline** — real behaviour documented, incl. the **ON/OFF
  post-processing asymmetry** (use a raw-`db.search` control probe when A/B-ing scopeFilter,
  per Exp3). ✅ with that caveat.
- **Harness** — completeness counts **live** points; offline preview is **not** a live proxy
  (surface both); reads are eventually-consistent (`settle()`). ✅

**Benchmark with a known caveat:**
- **Lexical/BM25 retrieval of episodic** is OFF under the raw-store fix (vector-only). Fine
  for vector/scope experiments; restore BM25 (deferred spike) before any *hybrid-baseline* claim.

**Not ready / out of scope (do not benchmark until decided):**
- **mem0 / durable clean-fact semantic path** — flagged architecture decision (#1 above).
- **`episodicTopK=0` true-zero isolation** — blocked by the floor pending the flag decision.

**Bottom line:** the substrate is trustworthy for the vector-semantic + scope-filtering
retrieval work Experiment 5 wants to resume, provided the BM25 caveat is respected and the
three flagged items are decided (or avoided) rather than silently assumed.

---

## 6. Verification

- `npm run test:contracts` → **green** (isolated Qdrant `:6344` + local Ollama; only
  `sage_contract_*` collections, auto-dropped — dev `sage_mem_v2` untouched).
- `npm test` (`test/` unit suite) → **97/97**; the contract suite (`npm run test:contracts`,
  +30) runs separately and skips gracefully when its backends are down — so the combined total
  is **127/127** with backends up, **97/97 (+30 skipped)** without.
- Headline: `node overnight/contracts/verification/merge-before-after.mjs` → 130 → 620 live,
  scopeKey 18 → 620.
- Isolation confirmed: the suite's hard guard refuses any collection not prefixed
  `sage_contract_`, and every test drops its collections in teardown.

## 7. Deliverables

- `overnight/MEMORY_CONTRACTS.md` — intended contract per primitive.
- `overnight/contracts/` — committed contract-test suite + `harness.mjs` + `README.md`
  + `verification/merge-before-after.mjs`; `npm run test:contracts`.
- `overnight/DEFECT_INVENTORY.md` — prioritised primitive · contract · actual · defect ·
  fix · status.
- The two fixes, each committed with its red→green test.
- This outcome + readiness statement.

## 8. Exit

Memory substrate **and** harness characterized; known defects **fixed-or-flagged**; contract
suite **passes**. Experiment 5 can resume retrieval work on a substrate that does what it
claims. Crisp finish — no drift into the rest of Sage.
