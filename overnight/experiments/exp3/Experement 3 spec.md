# Experiment 3 — Within-Scope Payload-Filter P1 + Gate 1b Reframe (V0.3)

**Run in a fresh Claude Code chat, plan mode, from the `sage_ai` repo. Plan first, show me the plan,
build + launch only after I approve.**

This is a **surgical delta on Experiment 2's committed build** — two targeted changes, not a rebuild.

## Orientation — read these first (they are the context)

Experiment 2 (`overnight/retrieval-loop-v0.2`, commit `2423b0a`) built the full semantic-stress rig and
**halted at the semantic-channel gate** with a precise, evidence-backed finding. Read, in order:

- `overnight/GATE_FAILURE_NIGHT_TWO.md` — **the finding that defines this experiment** (six controlled
  diagnostics; the root cause and the fix are in §4–§7).
- `overnight/Sage v2 night2 spec.md` — Experiment 2 spec (everything that carries forward).
- `overnight/HANDOFF_NIGHT_TWO.md`, `overnight/SAGE_V2_OVERNIGHT_SPEC.md` — Experiment 1 context + the
  carried-forward gate/isolation/caps discipline.

**Branch:** create `overnight/retrieval-loop-v0.3` off `overnight/retrieval-loop-v0.2`.

## 0. The finding this experiment acts on

Experiment 2 proved: burial worked, embedding hygiene fixed one of two causes (retrievable 0→~18%), but
the **post-filter P1 cannot work** on homogeneous facts. Mechanism: with clean embeddings the in-scope
gold and the cross-scope lookalikes have equally high cosines, so *globally* (across 620 vectors) they
compete for mnemosy-ai's ~10 candidate slots and the gold loses — it never enters the candidate set, so a
post-filter has nothing to recover. **But within its own scope the gold ranks 1–2 of 50** (diagnostic #4).

⇒ The fix is the spec's **other** P1 option: search **within scope** via a Qdrant payload filter, not
post-filter a global search. **The benchmark is correct and does not change** — cross-scope lookalikes
swamping global retrieval is the realistic condition scope-filtering exists to solve; making facts more
distinct would *weaken* the demonstration.

## 1. Carries forward UNCHANGED from Experiment 2 (reuse the committed build)

P0 strengthened benchmark (12 scopes / 620 facts / 48 dev + 24 held-out, bury mechanic, cross-scope
distractors, Qwen3-14B paraphrase content, `--dataset` reuse); **embedding hygiene** (storeEpisodic embeds
clean content, structural fields in Qdrant metadata payload — keep, it's a committed production fix);
the LoCoMo checkpoint (isolated instance, evidence-recall + gpt-5.4-mini answerer / local-Qwen3 judge with
the LoCoMo-Refined prompt, answerer≠judge); Gates 0/2/3/4 framework + §8.1 retry policy; loop/grid/archive;
isolation; detached launch + RUN_STATUS; manifest/VC discipline; **$30 ceiling**. Do not rebuild any of it.

## 2. Change 1 (the one behavioral change) — P1 as a within-scope Qdrant payload-filter

Re-implement `searchSemantic`'s scopeFilter-ON path in `src/services/memory/mnemosyne-adapter.js`.
Keep the flag, the `/admin/memory-config` allowlist entry, the env wire, and the OFF path exactly as
committed. **Only the ON behaviour changes:**

- **scopeFilter ON:** query the Qdrant collection **directly** with a payload filter on the scope field
  (now `entry.metadata.scopeKey` per the Experiment 2 embedding-hygiene commit — **verify the exact payload
  key against the committed `storeEpisodic`**), using the **same query embedding the current path uses**
  (reuse Sage's embedder so query and stored vectors share a space), limited to `semanticTopK`. This
  constrains the vector search to in-scope points, where the gold ranks 1–2 of ~50. mnemosy-ai's `recall`
  has no scope param, so this is a direct Qdrant search (reuse the collection name + URL already known to
  the bench instance; reuse any Qdrant handle mnemosy-ai exposes, else a thin client to the same collection).
- **scopeFilter OFF:** unchanged — global `recall` via mnemosy-ai. This is the contrast arm.
- **Minimal.** No reranking, dedup, query-rewriting, or threshold-loosening (no P2+; do **not** also touch
  `minScore` — within-scope cosines (~0.85) clear it). Filter on the metadata scope field, never re-pollute.

This is the principled fix the gate's evidence points to; it is the **only** new behavioural change.

## 3. Change 2 (measurement, to match the corrected architecture) — reframe Gate 1b to the scoped channel

Gate 1b currently tests the **unfiltered** channel and demands it carry the gold — but unfiltered global
search is *supposed* to be hard here (that's the premise of scope-filtering). Point the gate at the channel
actually being tested. Its purpose is unchanged: prove **semantic, not episodic**, does the work.

At `contextMaxTokens=2000`, on the dev set (single-hop + temporal for floors; multi-hop reported separately):

- **A** scoped, both channels (`s5/e3`, scopeFilter ON): `meanMRR_A ≥ 0.20`.
- **B'** scoped, semantic-isolated (`s5/e0`, scopeFilter ON; episodic leaks 1 filler turn per Exp-2 fact #1):
  `meanRecall_B' ≥ 0.50` — scoped semantic carries the gold.
- **C** episodic-isolated (`s0/e3`, scopeFilter off; verified no semantic leak, Exp-2 fact #7):
  `meanRecall_C ≤ 0.10` — burial holds.
- **B_unscoped** semantic-isolated, scopeFilter **OFF** (`s5/e0`): measured as the contrast. Require the
  **headline gap** `meanRecall_B' − meanRecall_B_unscoped ≥ 0.30` — scoping demonstrably recovers the gold
  the global pool buried.
- Per-question pathology guard carries over (on the scoped channel): `≥70%` of `recall_A==1` items have
  `mrr_A > 0`.

**On failure: HALT, write `GATE_FAILURE.md`** with the failed sub-criterion + per-item ranks. This is the
ONE behavioural change — if the reframed Gate 1b doesn't pass, **accept the halt, no iterative tuning.**

## 4. What passing means + the expected result

If Gate 1b passes, the scoped-vs-unscoped gap is already the headline — proven at the gate, before the loop.
The overnight loop then demonstrates the full original vision: the self-improving loop, optimising utility,
**autonomously discovers and converges on `scopeFilter = ON`**, tunes the read-side knobs around it, and the
LoCoMo checkpoint shows it **transfers to a real benchmark**. That is the payoff of the whole arc — an AI
memory system measurably and autonomously improving its own retrieval.

Honest caveat carried forward: the in-scope rank-1–2 evidence is **offline**; we don't assume it transfers
to the live pipeline, we let the gate adjudicate. Same discipline as every run.

## 5. LoCoMo checkpoint

Unchanged, and the payload-filter applies cleanly: each LoCoMo conversation is one scope, so scopeFilter ON
= search within the conversation (correct — the answer lives there), OFF = search across all 10
(cross-conversation noise). Report the LoCoMo scoped-vs-unscoped A/B alongside the synthetic one.

## 6. Gates 0/2/3/4 (carry forward; small updates)

- **Gate 2:** the scopeFilter toggle check now verifies the **search behaviour** changes (within-scope vs
  global returned ids / token count / MRR), not just post-filtered ids.
- **Gate 4** (read-only audit, pass-or-halt): expects the committed embedding-hygiene + the re-implemented
  payload-filter scopeFilter, default off, as the **only** retrieval changes; **no P2+**; LoCoMo isolated;
  judge local (answerer≠judge). Confirms the payload-filter reads the metadata scope field and does not
  touch `minScore`/rerank.
- Gates 0/1/3 + §8.1 retry + Gate 1b-halts-with-diagnosis: unchanged.

## 7. Outputs

`RUN_REPORT.md` with the scoped-vs-unscoped A/B made explicit (the dramatic result), the reframed Gate 1b
numbers, whether the loop converged on `scopeFilter=ON`, LoCoMo transfer (both signals), iterations /
wall-clock / spend, overfitting flags, and a forward-levers section (P2 cross-bucket ranking, P3
dedup/rerank, P4 query rewriting, P5 temporal, a clean-fact semantic path, LongMemEval). `manifest.json`
records the payload-filter P1 + the carried-forward config. VC discipline as before.

## 8. Verification + launch

1. **Dry run first** (`--dry-run --iterations 3 --grid`, `--dataset` reuse of the frozen Experiment 2
   dataset): generate/reuse dataset → populate (clean embeddings) → Gates 0/1/**1b (reframed)**/2/3 → a few
   loop iterations incl. scopeFilter toggles → teardown. **This proves the reframed Gate 1b for $0.** If it
   fails here, halt and write the diagnosis rather than launching.
2. **Gated foreground run** → leaves bench instances up.
3. **Gate 4** read-only audit → `VERIFICATION.md`.
4. **Detached overnight launch** (`Start-Process`) → `RUN_STATUS.md`; verify alive after detaching; writes
   `RUN_REPORT.md` on completion.

**Do not launch unless Gates 0–4 incl. the reframed Gate 1b pass.** One behavioural change (payload-filter
P1). If it doesn't pass, accept the halt and report. Stay strictly within scope — no P2+ retrieval changes.