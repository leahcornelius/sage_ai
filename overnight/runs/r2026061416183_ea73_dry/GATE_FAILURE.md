# GATE_FAILURE.md — V0.2 dry-run HALTED (semantic-channel / Gate-1b-class failure)

**Run:** `r2026061416183_ea73_dry` (dry-run, `--dataset overnight/_build_dataset.json`)
**Date:** 2026-06-14 · **Branch:** `overnight/retrieval-loop-v0.2`
**Status:** HALTED at the populate-completeness pre-check (upstream of Gate 1b, same signal).
**Nothing was launched.** This is the run's most important signal, exactly what the gates exist to catch.

---

## 1. What halted

After populating the strengthened V0.2 benchmark (620 facts, 12 content scopes) into the isolated bench
Sage, the populate-completeness check found **60 / 60 scored gold markers not retrievable at generous K**
(`semanticTopK=30, episodicTopK=20, contextMaxTokens=4000`), across 6 settle attempts (points=612/620).
i.e. **none** of the buried gold facts could be recovered through the retrieval path.

This is a **Gate-1b-class failure**: the semantic channel does not carry the buried gold. Per spec §5 and
the explicit instruction for this run, that halts the build — it is not fixed-and-retried around.

## 2. What PASSED (so this is a precise, isolated finding)

- **P0 build** — generator produced 48 dev / 24 held-out questions, 620 ingests, gold-paraphrase fallback
  **5.95%** (< 20% hard-fail), burial invariant asserted (every gold/stale ≥25 turns deep), forbidden-word
  + marker-uniqueness clean. Offline (clean-text) preview was encouraging: within-5 unscoped 0.80 / scoped 1.00.
- **Gate 0 isolation** — PASS (separate qdrant 6344, collection `bench_…_dry_e1` ≠ real, separate port).
- **P1 scope-filter code** — built, default off, flag-gated, allowlisted; verified live-toggleable.
- **Machinery** — launch, populate, gates framework, LoCoMo instance, archive all functioned.

The burial mechanic (P0) **worked**. The blocker is the semantic channel itself.

## 3. Root-cause investigation (four controlled diagnostics)

1. **Unscoped & scoped generous-K retrieval of the buried gold:** ctxRecall **0/10**, gold **never** in
   `semanticMemories`; `recall(limit=30)` returned only **~10** items total, all *late-band filler* turns
   (turn 42–48), never the early-band gold (turn 0–6).
2. **Exact-content probes:** querying with the **verbatim gold fact text**, and with the **marker itself**,
   both failed to surface the gold (rank NOT FOUND of ~10). So this is **not** the paraphrase gap.
3. **Clean distinct facts (control):** 5 semantically-distinct facts (Paris / Everest / water-boiling / …)
   ingested the same way retrieve **perfectly — correct fact at rank 1** for each query. So embeddings
   (Ollama `nomic-embed-text`) and the retrieval pipeline work for *distinct* content.
4. **Offline embedding ranks (clean vs storeEpisodic-tagged), in-scope:** the tagged gold still ranks
   **1–2 of 50** within its own scope. So **in-scope ranking is fine** — the blocker is **global candidate
   generation**: among 620 homogeneous, tag-diluted vectors, `mnemosyneClient.recall` returns only ~10
   (its `minScore=0.3` + intent-threshold + diversity-rerank pipeline drops the rest), so the in-scope gold
   **never enters the candidate set** — and scope-filtering (P1) therefore cannot recover it.

## 4. Diagnosis

With **mem0 OFF** (bench config, as in night one), the only durable semantic vectors are the **episodic
turns**, stored as text dominated by a fixed structural prefix
(`[scope:…][conversation:…][role:…][turn:N][message_id:HASH][timestamp:…] <fact>`). When the synthetic
facts are also **homogeneous** ("the {attribute} for the {entity} is {code}"), the query↔document cosine is
low and nearly uniform, so mnemosy-ai's score/diversity filtering returns a small, content-irrelevant set
and the buried gold is unreachable. **Night one masked this** by resolving every gold from the 20-turn
**episodic ring buffer** — which is exactly why night one's `meanMRR` was **0**. V0.2's burial removed that
crutch and exposed that the bench's durable semantic channel does not do fine-grained content retrieval
over homogeneous, tag-diluted vectors.

**The spec's anticipated remedy (deeper burial / more facts) would NOT help** — burial already succeeded.

## 5. Candidate remedies (classified by scope) — for the morning decision

**In V0.2 scope (P0 generator only):**
- **Richer, more-distinctive fact content.** Make each fact a longer, naturally-varied sentence with
  per-fact distinctive context, so the content dominates the fixed tag prefix in the embedding (clears
  `minScore`) and separates from sibling facts — while keeping same-attribute cross-scope lookalikes so the
  P1 A/B stays measurable. **Tension to watch:** facts must stay similar enough that cross-scope lookalikes
  still bleed (else P1 is unmeasurable), yet distinct enough to clear retrieval thresholds. Whether both can
  hold simultaneously is itself an empirical question (re-run the dry-run to find out).
  - **Viability probe (run):** a single RICH, distinctive fact ("During the autumn overhaul of the east
    dock at the Olive Lynx depot, the outbound pallet routing marker was registered as RICHGLD7…") buried
    among 58 homogeneous distractors retrieved at **rank 1**; a homogeneous-template gold in the same
    collection was **NOT FOUND**. So richer content *does* clear the threshold. **But** `recall` returned
    only **3** candidates total — so richer/distinct facts also *shrink* the cross-scope bleed that P1 must
    remove, sharpening the distinct-vs-bleed tension above. This is real generator rework, not a quick patch.

**Out of V0.2 scope (night-three, code-level — would need explicit authorization):**
- **Embed clean content, not tag-polluted text** — strip the structural prefix before embedding in
  `mnemosyne-adapter.storeEpisodic`, or store a clean semantic-fact vector alongside the episodic one.
- **Loosen recall candidate generation** — pass a lower `minScore` / disable diversity-rerank in
  `searchSemantic`'s `recall()` so the buried gold enters the candidate set.
- **A clean-fact ingest path** (mem0-style) so durable vectors aren't episodic-tag-polluted.

## 6. Recommendation

**Do not launch.** The V0.2 machinery (P0 generator, P1 scope-filter, Gate 1b, LoCoMo checkpoint) is built
and the gate caught a real, fundamental limitation of the bench semantic channel before any spend. Decide
between (a) accepting this as the run's finding, (b) an in-scope P0 richer-content retry, or (c) authorizing
an out-of-scope night-three code fix.

## Evidence appendix
- loop.log: `overnight/runs/r2026061416183_ea73_dry/logs/loop.log` (6 completeness settle attempts, 60 missing).
- Diagnostics (transient scripts, removed): unscoped/scoped 0/10; exact-gold-text NOT FOUND; clean-distinct
  rank-1; offline tagged in-scope rank 1–2/50.
- Offline build preview (over-optimistic — clean text only): `_build_dataset.json` meta.offlinePreview
  within-5 unscoped 0.80 / scoped 1.00, meanGoldCosine 0.854.
