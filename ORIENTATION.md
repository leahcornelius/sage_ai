# Sage — Orientation

A single navigation map for the repository. Read this first; it points at the
detailed docs rather than repeating them.

## What Sage is

Two things share this repo:

1. **An OpenAI-compatible API server** (`src/`) that layers long-term memory on top
   of the upstream Chat Completions API. It exposes `GET /health`, `GET /v1/models`,
   and `POST /v1/chat/completions` (streaming + tool calls), and transparently
   retrieves relevant long-term memory for each request and ingests new turns.
2. **A research harness** (`overnight/`) that runs reproducible retrieval
   experiments against an isolated benchmark instance of that server, gated by
   deterministic checks, to measure whether memory changes actually help recall.

The server is the product; the overnight harness is how memory-retrieval changes
are validated before they are trusted.

## The memory pipeline (request lifecycle)

```
POST /v1/chat/completions
  → validation/chat-completions.js   (normalize body + headers → requestBody)
  → services/chat-service.js         (orchestrates the turn)
      ├─ memory write (unless read-only): processMessage(user turn)
      ├─ memory read:  retrieveContext(query)  ──► injected as system context
      ├─ upstream model call (providers/openai-client.js or llm-router)
      └─ memory write (unless read-only): ingest(assistant turn)
```

`retrieveContext` / `processMessage` live in **`src/services/memory/memory-controller.js`**,
which fans out to adapters under `src/services/memory/`:

- **`mnemosyne-adapter.js`** — the durable vector store (mnemosy-ai / Qdrant). Raw
  episodic turns and clean semantic facts are written via the *raw* `db.store`
  path (bypassing the library's unconditional dedup/merge) and read back by content
  or by a scoped payload filter. This is the load-bearing retrieval surface.
- **`local-extractor-adapter.js`** — the local, `$0` "clean-fact" extractor that
  turns a turn into atomic durable facts (the live replacement for the dormant
  cloud mem0 path).
- **`mem0-adapter.js`** — the (dormant) cloud fact-extraction path, OFF by default.
- **`zep-adapter.js`** — optional graph memory (OFF by default).
- **`redis-cache.js`** — identity + per-query context cache.
- **`context-merge.js`** — merges the buckets and trims to a token budget.

`read-only mode` (header `x-sage-skip-memory-write`) retrieves context but writes
nothing — used by the benchmark checkpoint so a scored scope is never contaminated
by the checkpoint's own generated answers.

Server internals in depth: [`docs/architecture.md`](./docs/architecture.md),
[`docs/internals.md`](./docs/internals.md).

## The overnight research harness

- **`overnight/harness/loop.js`** — the experiment driver. Phases: `gates`
  (bring up an isolated bench Sage, populate, run Gate 0→3), `run` (adopt that
  bench Sage and run the mutation loop + capped checkpoints), plus `--dry-run`.
- **`overnight/harness/gates.js`** — the deterministic gate checks (e.g. Gate 1b
  measures the scoped vs. unscoped semantic channel). Gates decide pass/halt.
- **`overnight/harness/generate.js`** — synthetic buried-gold dataset generation.
- **`overnight/harness/adjudicator.mjs`** — the autonomous adjudicator that reads
  the substrate docs + run state and emits a structured decision.
- **`overnight/harness/lib/`** — building blocks: `sage-client.js` (HTTP client),
  `locomo.js` (real-benchmark checkpoint), `score.js`, `ollama.js`, `forbidden.js`
  (secret/forbidden-word guard), `archive.js`, `rng.js`.

### Contracts (regression guard)

**`overnight/contracts/*.contract.test.mjs`** are deterministic characterization +
contract tests that pin the substrate's behaviour (merge bypass, embedding hygiene,
clean-fact hygiene, episodic buffer, scope filter, secret guard, …). They are the
durable regression suite every future experiment inherits. See
[`overnight/contracts/README.md`](./overnight/contracts/README.md).

### Experiment records vs. raw runs

- **`overnight/experiments/exp<N>/`** — the curated spec + outcome for each
  experiment (`exp3`, `exp4`, `exp5`, and `v0-overnight-loop` for the v0.1–v0.3
  night-two retrieval-loop arc). Start here to understand *what was tried and why*.
- **`overnight/runs/<runid>/`** — raw per-run artifacts. Durable summaries
  (`RUN_REPORT.md`, `RUN_STATUS.md`, `VERIFICATION.md`, `gates-result.json`,
  `manifest.json`, `best.json`, `dataset.json`, `sage.boot.json`) are versioned;
  bulky mutable state (`archive.jsonl`, `grid.jsonl`, `loop-state.json`, logs) is
  git-ignored.
- **`overnight/MEMORY_CONTRACTS.md`** (intended substrate contracts) and
  **`overnight/DEFECT_INVENTORY.md`** (known landmines + fix status) are
  cross-experiment reference docs kept at the `overnight/` root — the adjudicator
  reads them and `src/` comments cite them.

## How to run

```bash
# install
npm install

# server (needs an upstream key wired via SAGE_LLM_*; see .env.example)
npm start                      # or: npm run dev   (watch mode)
npm run chat                   # terminal REPL client (cli/sage-chat.mjs)

# tests
npm test                       # unit suite + contract tests
npm run test:contracts         # just the substrate contract tests

# an overnight experiment (brings up throwaway Qdrant/Redis/FalkorDB on bench ports)
node overnight/harness/loop.js --dry-run --iterations 3 --grid   # cheap, no model calls
node overnight/harness/loop.js --phase gates --run <newid> --grid # real gated run
```

Local bring-up details (services, ports, env overrides) live in
[`docker_setup.md`](./docker_setup.md) and the `v0-overnight-loop` handoff doc.

## Directory map

```
src/                         OpenAI-compatible server
  app.js                     app assembly + route registration (admin guard)
  http/                      routes, validation, serializers, hooks
  services/                  chat-service, model-service, prompt-service, …
  services/memory/           memory-controller + adapters (the memory pipeline)
  providers/                 upstream OpenAI + mnemosyne clients
  tools/                     builtin tools + MCP client runtime
  config/env.js              runtime configuration
cli/                         terminal REPL client
test/                        server unit tests
overnight/
  harness/                   experiment driver, gates, adjudicator, lib/
  contracts/                 deterministic substrate regression tests
  experiments/exp<N>/        curated specs + outcomes
  runs/<runid>/              raw per-run artifacts
  MEMORY_CONTRACTS.md        intended substrate contracts (load-bearing)
  DEFECT_INVENTORY.md        known landmines + fix status (load-bearing)
docs/                        server documentation (architecture, internals, api)
scripts/                     maintenance/migration scripts
```
