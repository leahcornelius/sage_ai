# RUN_REPORT.md — Overnight retrieval loop (V0.1)

Run `r2026061323123_8577_dry` — 3 iterations, 0.02h elapsed.

## Comparison (same dev set / held-out set / checkpoint)

| Config | Knobs | Dev utility | Held-out retrieval (recall / utility) | e2e checkpoint (gpt-5.2) |
|---|---|---|---|---|
| baseline | semanticTopK=5, episodicTopK=3, contextMaxTokens=1200, graphMaxResults=20 | 0.1866 | 0.192 / 0.1481 | — |
| grid-best | semanticTopK=1, episodicTopK=10, contextMaxTokens=400, graphMaxResults=20 | 0.5191 | 0.385 / 0.3657 | skipped |
| loop-best | semanticTopK=20, episodicTopK=10, contextMaxTokens=3900, graphMaxResults=20 | 0.4084 | 0.462 / 0.3702 | skipped |

**Verdict:** the loop **UNDERPERFORMED** grid-best (§7.1: rediscovering grid-best is a PASS — it proves the loop behaves correctly in a known-small space).

- iterations run: 3
- wall-clock elapsed: 0.02h
- checkpoint runs: 0 / 60
- estimated checkpoint spend (CONSERVATIVE upper-bound): $0.00 / $40 ceiling
- checkpoint rates used: in $3/1M, out $15/1M (gpt-5.2)
- determinism noise band: 0

## Overfitting
Free held-out retrieval checks were logged every 25 iterations (see archive `phase:heldout-retrieval`).
If dev climbed while held-out stayed flat, that is logged as a generator-quirk overfitting signal.

## External benchmarks
LoCoMo / LongMemEval were **skipped** (not present locally; spec marks them optional). The required
synthetic held-out checkpoint above is the authoritative end-to-end signal.

## Night-two levers (code-level retrieval — out of V0.1 scope)
- **Scope-filter the semantic recall.** Today `mnemosyneClient.recall` is NOT scope-filtered, so a
  query retrieves across all scopes in the collection. Per-scope filtering would cut cross-scope noise
  and raise precision (and make `semanticTopK` more effective).
- **Cross-bucket ranking / fusion.** Identity/graph/semantic/episodic are concatenated then trimmed
  episodic→semantic→graph. A unified relevance ranking before trim would keep the best items per token.
- **Dedup / rerank.** Episodic storage repeats near-identical turns; dedup + a reranker would reduce
  wasted context tokens and improve `contextMaxTokens` efficiency.
- **Query rewriting / multi-hop decomposition.** Multi-hop questions need both facts; decomposing the
  query into sub-queries would raise multi-hop recall beyond what a single top-K pass achieves.
- **Temporal recency ranking.** Temporal-update items rely on phrasing to suppress the stale marker;
  an explicit recency/supersession signal would make 'stale absent' robust.