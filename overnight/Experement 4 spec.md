# Experiment 4 — Memory-Substrate Characterization, Contract Tests & Gated Fixes (V0.4)

**Run in a fresh Claude Code chat, plan mode, from the `sage_ai` repo. Plan first, show me the plan,
then proceed.** This is a **different shape** from Experiments 1–3: not a self-improving loop with
gates and an overnight run, but an **audit → contract-test suite → test-gated fixes** pass over the
memory-retrieval substrate. Fully local, **$0** (no checkpoint/model calls).

Sage is a **hobby project, not in production anywhere** — so fixes land directly on the branch, gated by
tests and reversible via git; no flag-default-off-for-safety mandate and no per-fix authorization needed.

## Why this experiment exists

Experiments 2–3 kept turning into bug hunts because we optimised retrieval on a substrate we'd never
validated: `semanticTopK` was inert (Exp1), embeddings were tag-polluted (Exp2), and — the big one —
mnemosy-ai's unconditional 0.85-cosine **dedup/merge silently soft-deleted the gold at ingest** (Exp3),
which even invalidated part of the Exp2 diagnosis. **You cannot autonomously improve a memory system whose
primitives don't do what they claim.** Experiment 4 builds the foundation the later experiments need: prove
each benchmarked primitive behaves as intended, lock it with a permanent test, and fix what's broken.

**Branch:** `experiment/4-memory-substrate` off `overnight/retrieval-loop-v0.3`.

## Scope — the memory-retrieval substrate + the harness (NOT all of Sage)

Hold this boundary. The benchmarked path only:

- **Ingest / store** — `mnemosyneClient.store`, `storeEpisodic`, and the **dedup/merge** behaviour (entry #1).
- **Embedding** — what text actually gets embedded (post Exp2 hygiene).
- **Episodic ring buffer** — per-scope FIFO, the 20-turn window, the `episodicTopK=0` floor-at-1.
- **Semantic recall** — `recall` (`limit` vs `topK`), `minScore`, the over-fetch + diversity-rerank pipeline.
- **Scope handling** — `metadata.scopeKey`, the payload filter, cross-scope behaviour.
- **Context-merge / trim** — bucket order, trim order (episodic→semantic), how scores are (or aren't) threaded.
- **mem0 path** — characterise whether it's dead/usable (it extracted 0 facts in Exp1).
- **Config landmines** — `TTL=0` rejected, `partial` always true with Zep off, hardcoded collection names.
- **The harness** — does it measure *live* behaviour? (offline preview was over-optimistic; the Exp2
  diagnostics never checked the `deleted` flag; completeness must count *live* points, not all points).

Do **not** expand to auth, HTTP, Stripe, WordPress, or anything outside the memory-retrieval path.

## Method

For each primitive, three steps:

1. **Write the intended contract** — one short statement of expected behaviour ("episodic storage preserves
   every distinct turn as a live point and retains `scopeKey`"; "`semanticTopK=k` returns at most k semantic
   results"; etc.). Where "intended" is genuinely ambiguous (e.g. should the mem0 path work at all?), **flag
   it for my judgement** rather than guessing — that's a design call, not a test failure.
2. **Write a characterization test** — deterministic, against an **isolated bench stack** (separate Qdrant/
   Redis/Falkor + collection, same isolation pattern as the experiments, so it never touches your local dev
   memories), no model calls. The test asserts actual-vs-intended.
3. **Record the result** in the defect inventory: primitive · intended contract · actual behaviour ·
   defect? · severity · proposed fix · fix-risk (trivial-correct vs behaviour-changing).

Then **fix the defects**, each gated by its characterization test going **red → green**. Behaviour-changing
fixes *may* sit behind a flag where that helps future benchmark A/B (e.g. old-vs-new), but flags are now a
**measurement** convenience, not a safety requirement — default them however is cleanest. Trivial-correct
fixes land directly with a test.

**Prioritise by how much each defect distorts what the benchmarks measure** — a primitive that silently
corrupts data (the merge) ranks above a cosmetic inconsistency.

## Starting inventory (seed the audit — confirm + extend each)

- **#1 — the merge bug (already diagnosed; fix this first).** mnemosy-ai's `fullStorePipeline` runs an
  unconditional 0.85-cosine dedup/merge; episodic turns are raw events that should never be semantically
  merged. **Intended contract:** ingesting N distinct episodic turns yields N live points with `scopeKey`
  preserved. **Fix:** episodic storage skips semantic dedup/merge (or routes to a non-deduped path — the
  Exp3 `episodicRawStore` bypass is the seed; make it the proper fix, not a bench-only flag). **Test:**
  ingest N distinct turns → assert N live (non-deleted) points, `scopeKey` intact, gold retrievable.
- **Embedding hygiene (Exp2, already applied)** — lock it with a contract test so it can't silently regress.
- **`semanticTopK`→`limit` (Exp1, already fixed)** — lock with a test.
- **Cross-scope semantic bleed / scope-filter** — characterise unscoped vs scoped behaviour; the payload
  filter exists (Exp3); contract: scoped recall returns only in-scope points.
- **`episodicTopK=0` floors at 1** — characterise; is the floor intended? Document the contract.
- **The recall pipeline** (over-fetch ×3 → rerank → top-K, `minScore` 0.3) — characterise what it actually
  does (Exp3's control probe showed it recovers ~+0.125 of gold globally); write down the real contract.
- **mem0 path** (0 facts extracted) — characterise; flag the "is this meant to work?" call to me.
- **Config landmines** — document the actual behaviour (`TTL=0` rejected, `partial` always true w/ Zep off,
  hardcoded `memory_private`/`agent_profiles`/`skill_library`).
- **Harness validity** — completeness counts *live* points; the offline preview's relationship to the live
  pipeline is documented (the Exp2/Exp3 over-optimism gap); add a test that flags offline-vs-live divergence.

Discover and add anything else in the substrate; **do not** chase defects outside it.

## Autonomy & discipline

Autonomous audit, test-writing, and fixing — gated by: **every fix proven by a characterization test
(red→green)**, **scope held to the memory substrate + harness**, **git-revertable**. No overnight loop, no
$ spend. **Report-and-pause only** when "intended" is a genuine design judgement (flag it, don't guess) or
when a fix would reach outside the substrate (don't — surface it for a later experiment). No unbounded
"fix everything and iterate" — work the inventory, then stop at the exit condition.

## Deliverables

- **`MEMORY_CONTRACTS.md`** — the intended contract per primitive (the written definition of "as intended").
- **A committed, runnable contract-test suite** (e.g. `overnight/contracts/` or `test/memory-contracts/`) —
  the durable prize: regression protection every future experiment inherits.
- **`DEFECT_INVENTORY.md`** — primitive · contract · actual · defect · severity · fix · status, prioritised.
- **The fixes**, each committed with its red→green test.
- **`EXPERIMENT_4_OUTCOME.md`** — what was validated, what was fixed, what's flagged for my judgement, what's
  deferred, and an explicit **readiness statement**: which primitives are now trustworthy to benchmark on.

## Exit condition

The memory substrate **and** the harness are characterised, known defects are fixed-or-flagged, and the
contract-test suite passes. At that point the substrate is trustworthy and Experiment 5 can resume retrieval
work on it. Crisp finish line — don't drift past it into the rest of Sage.

## Verification

Run the contract-test suite (all green for fixed items; documented-and-flagged for the design-judgement
items). Confirm the isolated bench stack was used throughout (no touch to local dev memories). Summarise the
before/after for the merge bug specifically (live point count 134→620 on the homogeneous fixture, `scopeKey`
preserved) as the headline fix.