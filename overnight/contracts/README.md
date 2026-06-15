# Memory-substrate contract tests (Experiment 4)

Deterministic, `$0` characterization/contract tests that pin the behaviour of Sage's
memory-retrieval substrate (ingest/store, embedding, episodic buffer, semantic recall,
scope handling, context-merge/trim, mem0, config landmines) and its benchmark harness.
They are the durable regression guard every future experiment inherits.

See `../MEMORY_CONTRACTS.md` (intended contracts) and `../DEFECT_INVENTORY.md`
(findings + fix status). The arc write-up is `../experiments/exp4/EXPERIMENT_4_OUTCOME.md`.

## Run

```bash
npm run test:contracts          # this suite only
npm test                        # whole repo (these included; they skip-gracefully)
```

## Backends (isolation)

Integration tests need an **isolated Qdrant** + **local Ollama** (`nomic-embed-text`).
They never touch local dev memories:

- They build a mnemosy-ai client on **freshly-named throwaway collections**
  (`sage_contract_<ts>_<rand>_{shared,private,profiles,skills}`), created per test and
  **deleted in teardown**.
- A hard **isolation guard** (`harness.mjs:assertContractCollection`) refuses to operate
  on any collection whose name does not start with `sage_contract_` — categorically
  excluding `sage_mem_v2`, `memory_private`, `agent_profiles`, `skill_library`, and the
  harness `bench_*` collections.
- Redis/Falkor are **not** required (the client is built without `graphUrl`/`redisUrl`).
- No model/checkpoint calls. Embeddings use local Ollama; same input → same vector, so
  the suite is deterministic.

Defaults (override via env):

| env | default | purpose |
|---|---|---|
| `SAGE_CONTRACT_QDRANT_URL` | `http://127.0.0.1:6344` | isolated bench Qdrant (NOT dev `:6333`) |
| `SAGE_CONTRACT_EMBEDDING_URL` | `http://127.0.0.1:11434/v1/embeddings` | local Ollama |
| `SAGE_CONTRACT_EMBEDDING_MODEL` | `nomic-embed-text` | embedder |

If the backends are unreachable, integration tests **skip** (with a reason) instead of
failing, so `npm test` stays green on a box without Docker. Pure-function tests
(context-merge, ring buffer, config parsing) always run.

## Test kinds

- **Contract test** — asserts the *intended* behaviour. For a fixed defect it was
  RED before the fix, GREEN after.
- **Characterization test** — *pins current actual behaviour* where intent is flagged
  for a human decision (e.g. `episodicTopK=0` floor, mem0-OFF path). It documents
  reality and trips if the behaviour silently changes.
