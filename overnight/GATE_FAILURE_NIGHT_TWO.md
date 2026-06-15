# SAGE V0.2 — Night-Two Outcome: HALTED at the semantic-channel gate (no launch)

**Branch:** `overnight/retrieval-loop-v0.2` · **Date:** 2026-06-14
**Status:** Build COMPLETE; **Gate failed → HALTED, nothing launched, $0 spent.** The gate caught a real
limitation of the bench semantic channel before any overnight run — which is exactly its job.

This is the authoritative night-two write-up. The most important signal of the run is the finding below.

---

## 1. TL;DR

- The full V0.2 machinery was built per spec: **P0** semantic-stress benchmark (bury mechanic + cross-scope
  distractors + Qwen3 paraphrase content), **P1** scope-filter (flag, default off), **Gate 1b**, Gate
  0/2/3 extensions, the **LoCoMo** checkpoint (isolated instance, evidence-recall + cloud-answerer /
  local-Qwen3-judge), `--dataset` reuse.
- The dry-run **halted at the populate-completeness pre-check**: the buried gold facts were **not
  retrievable through the bench semantic channel**. Root-caused with six controlled diagnostics.
- **Burial (P0) worked.** The blocker is that the bench's durable semantic channel cannot surface a
  specific buried fact among many **homogeneous** facts. Night one had hidden this — its recall came
  entirely from the 20-turn **episodic ring buffer** (which is why night one's `meanMRR` was 0); V0.2's
  burial removed that crutch and exposed it.
- **One additional code change was authorized and applied: embedding hygiene** (embed clean content, not
  the boilerplate-tagged string, in `storeEpisodic`). It **helped but did not clear the bar**: full-scale
  retrievable-at-generous-K went **0/60 → 11/60**, `meanMRR` 0 → ~0.26 — still far below Gate 1b's
  thresholds. Per the run's rule (*one change; if Gate 1b doesn't pass, accept the halt; no iterative
  tuning*), the run is **halted and reported**.

---

## 2. What passed (so the failure is precise and isolated)

- **P0 build** — 12 scopes / 620 facts / 48 dev + 24 held-out; burial invariant asserted (every
  required+forbidden marker ≥25 turns deep); gold-paraphrase fallback **5.95%** (< 20% hard-fail);
  forbidden-word + marker-uniqueness clean.
- **Gate 0 isolation** — PASS (separate qdrant `:6344`, collection ≠ real `sage_mem_v2`, separate port;
  LoCoMo-collection isolation wired).
- **P1 scope-filter** — built, default off, allowlisted, live-toggleable; the Gate-2 scopeFilter fixture
  confirmed the flag changes returned ids.
- **Machinery** — launch, populate, gate framework, LoCoMo second instance, archive, `--dataset` reuse all
  functioned.

## 3. The failure

Populate-completeness (gold retrievable at generous K = `s30/e20/c4000`, unfiltered):

| Stage | missing / 60 scored | retrievable |
|---|---|---|
| Before embedding hygiene | **60 / 60** | 0% |
| After embedding hygiene (authorized fix) | **49 / 60** | ~18% |

Completeness requires ~100%; both runs HALTED before the loop. (Logs:
`overnight/runs/r2026061416183_ea73_dry/` and `…/r2026061417083_b829_dry/`.)

## 4. Root-cause investigation (six controlled diagnostics)

1. Unscoped & scoped generous-K retrieval of the buried gold → **0/10** recall; `recall()` returned only
   ~10 items for any query; the gold was never among them; returned items were late-band filler.
2. **Exact-content probes** (verbatim gold text, and the marker itself) also failed → not the paraphrase gap.
3. **Control — 5 clean, semantically-distinct facts** retrieved **perfectly (rank 1)** → embeddings
   (Ollama `nomic-embed-text`) and the pipeline work for *distinct* content.
4. **Offline clean-vs-tagged embedding ranks** → tagged in-scope gold still ranks 1–2 of 50 *within scope*;
   the blocker is **global candidate generation** (the gold's global rank among 620 homogeneous facts is
   below mnemosy-ai's `recall` candidate set, so it is never fetched).
5. **Viability probe** — a single *rich, distinctive* fact buried among homogeneous distractors retrieved
   at rank 1, while a homogeneous-template gold in the same store was NOT FOUND — but `recall` returned only
   ~3 items, i.e. richer facts also **destroy the cross-scope bleed** P1 must remove.
6. **After embedding hygiene** (clean content embedded; scope moved to metadata payload): unfiltered
   semantic recall rose to ~0.27 (3-scope) / ~0.18 (12-scope); `meanMRR` ~0.26; **cross-scope bleed
   present** (67% of candidates cross-scope); **scope-filtering did NOT help** (scoped ≤ unscoped) because
   the gold is absent from the candidate pool, which post-filtering cannot recover.

## 5. Diagnosis

Two compounding causes, now both evidenced:
- **(fixed) Tag-polluted embeddings.** With **mem0 OFF**, the only durable vectors are episodic turns whose
  stored text was dominated by a fixed `[scope][conversation][role][turn][message_id:HASH][timestamp]`
  prefix; the content was a small fraction of the embedded tokens. **Embedding hygiene removed this**
  (0 → ~18% retrievable), confirming it was a real cause.
- **(residual) Homogeneous facts.** All 620 facts share the form "the {attribute} for the {entity} is
  {code}", so even with clean embeddings the buried gold's absolute similarity is too low to clear
  mnemosy-ai's candidate filtering among hundreds of near-duplicates. Post-filter scope-filtering cannot
  help when the gold never enters the candidate set — so the P1 A/B is flat, for an uninteresting reason.

**The spec's anticipated remedy (deeper burial / more facts) would not help** — burial succeeded.

## 6. The fundamental tension this run discovered

Measuring scope-filtering needs **two things at once**: (a) cross-scope lookalikes that *bleed* into
unfiltered recall (⇒ facts must be **similar**), and (b) the in-scope gold actually **retrievable**
(⇒ facts must be **distinct enough** to clear the candidate threshold). On homogeneous facts (a) holds but
(b) fails; on rich/distinct facts (b) holds but (a) collapses (probe #5). A **post-filter** P1 cannot
square this because it can only re-rank the unfiltered candidate pool.

## 7. Night-three levers (evidence-backed)

1. **True scope payload-filter P1** (the spec's *other* P1 option): query Qdrant with a `scope` payload
   filter so search happens *within scope*, where the in-scope gold ranks 1–2 of ~50 (diagnostic #4). This
   makes **scoped** recall high while **unscoped** stays low — the real, dramatic A/B — and squares the §6
   tension (post-filter cannot). Note Gate 1b (which tests the *unfiltered* channel) would still need the
   benchmark to be less homogeneous, OR Gate 1b's intent reframed as "scoped semantic carries gold."
2. **Re-enable a clean-fact semantic path** (mem0-style distinct fact vectors) so durable retrieval isn't
   limited to episodic turns.
3. **Moderate fact heterogeneity** — richer per-fact context that still shares the discriminating
   attribute, tuned so both bleed and retrievability hold (a careful generator design, not a quick patch).

## 8. Code changes made (two, both principled production fixes — for Gate-4 expectations)

1. **Scope-filter (P1)** — `config.memory.scopeFilter` (default off), `searchSemantic` over-fetch +
   scope post-filter (reads metadata scope), `/admin/memory-config` allowlist + boolean coercion, env wire.
2. **Embedding hygiene (authorized)** — `storeEpisodic` embeds clean content; structural fields moved to
   the Qdrant metadata payload (unconditional, the fixed substrate). `searchSemantic`'s scope filter reads
   `entry.metadata.scopeKey` (legacy in-text tag as fallback).

**No other retrieval changes** (no P2 ranking/dedup/rerank/query-rewrite). Both are merge-safe: scope-filter
is flag-gated off; embedding hygiene strictly improves what is embedded.

## 9. Recommendation

Accept this as the run's finding. The bench's semantic channel, with mem0 off, does not support
fine-grained content retrieval over homogeneous facts; the night-two benchmark exposed it, embedding
hygiene partially fixed it, and the remaining work (a within-scope payload-filter P1 + a less homogeneous
benchmark) is a night-three design. No overnight loop was launched; no spend incurred.
