# Phase 1 — local clean-fact substrate (Gate 1 PASS ✅)

Built a $0, local, deterministic clean-fact extraction path to replace the dead cloud-mem0 path,
storing facts as clean, scope-tagged, raw (un-merged) Qdrant points.

## What was built
- `src/services/memory/ollama-chat.js` — minimal local-LLM chat client (Ollama OpenAI-compat).
- `src/services/memory/local-extractor-adapter.js` — per-turn qwen3:14b extractor (temp 0, seed 7,
  verbatim-preservation prompt, `/no_think`). Gated by `SAGE_CLEANFACT_ENABLED` (default OFF).
- `src/services/memory/mnemosyne-adapter.js` — **rewrote `upsertSemanticFacts`**: embed fact text
  ONLY (D3.1 fix), raw `db.store` (Exp4 merge-bug fix on the semantic path), metadata
  `{memoryClass:"semantic_fact", scopeKey, factKey, version, status, sourceMessageId, sourceTurnIds}`.
  Removed mem0-era `normalizeFact`/`compareFacts`/`asTimestamp`/`normalizeConfidence`.
- Wiring: `memory-service.js` (create adapter), `memory-controller.js` (cleanfact extraction call,
  unioned with mem0; `isAdapterEnabled("cleanfact")`; health), `env.js` (`cleanFactEnabled`,
  `cleanFact{}`, `timeouts.cleanfactMs`), `supervisor.js benchEnv` (`SAGE_CLEANFACT_ENABLED=true`).
- `overnight/contracts/clean-fact-hygiene.contract.test.mjs` — new red→green contract (3 tests).
- `overnight/harness/cleanfact-validate.mjs` — Gate 1a/1c validation harness.
- Docs: `MEMORY_CONTRACTS.md` (#2, #8) + `DEFECT_INVENTORY.md` (#2b FIXED, #8 RESOLVED) updated.

## Gate 1 results
| Sub-gate | Result |
|---|---|
| **1a** extracts + marker preservation | ✅ 12 facts / 12 gold turns, **markers preserved 12/12 (1.0)**, 0 filler facts, ~4s/turn (~9.4 min for 140 turns). Not near-zero → no hard-fail. |
| **1b** hygiene contract (red→green) | ✅ `clean-fact-hygiene.contract.test.mjs` — fact-text-only embed, scopeKey/factKey/semantic_fact in metadata, near-dupes NOT merged, scoped-only retrieval. |
| **1c** determinism | ✅ determinismOverlap **1.0**, markerStability **1.0** (qwen3:14b deterministic at temp 0 + seed; verified by a 3× identical-output probe). |
| **1d** full contract suite | ✅ `npm run test:contracts` **33/33**; full repo `npm test` **135/135** (no regressions). |

**Verdict:** clean-fact substrate is valid, deterministic, marker-preserving, clean, scope-tagged,
un-merged. Proceed to Phase 2. mem0 stays OFF (its OFF-contract is intact; Gate 0 isolation unaffected).
