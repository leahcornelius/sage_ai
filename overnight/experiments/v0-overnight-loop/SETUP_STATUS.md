# Sage — Local Bring-up Status

**Date:** 2026-06-13
**Scope:** Bring-up + memory round-trip smoke test only (no evolution/optimisation loop, no app-logic changes).
**Overall result:** ✅ **PASS — Sage is running locally and the memory write→read round-trip is proven.**

No application code was changed. `.env.local` was **not** modified; runtime tuning was applied as process-env overrides at launch only (see "How Sage was started").

---

## Service status

| Service | Role | Endpoint / Port | Status |
|---------|------|-----------------|--------|
| Sage server | OpenAI-compatible API | http://0.0.0.0:8787 | ✅ Up (PID logged as 23612) |
| Qdrant | Vector DB | http://localhost:6333 | ✅ Up (docker `qdrant`) |
| Redis (cache) | mnemosyne cache | redis://localhost:6379 | ✅ Up (docker `redis`) |
| FalkorDB | graph store | redis://localhost:6380 | ✅ Up (docker `falkordb`) |
| Ollama | embeddings (`nomic-embed-text`, 768-dim) | http://localhost:11434/v1/embeddings | ✅ Up (native, v0.21.0) |
| Upstream chat | OpenAI Chat Completions | https://api.openai.com/v1 | ✅ Working (key valid) |
| mem0 (cloud) | write-path fact extractor | https://api.mem0.ai | ✅ Health OK (but extracted 0 facts — see Findings) |
| Zep (cloud) | graph memory | https://api.getzep.com | ⏸️ Disabled for this run (see below) |

`/health` response:
```json
{"status":"ok","memory":{"mem0":{"status":"ok"},"zep":{"status":"disabled"},"redis":{"status":"ok"},"mnemosyne":{"status":"ok"}}}
```

---

## Prerequisites (verified)

| Tool | Required | Found |
|------|----------|-------|
| Node.js | 24+ | v24.14.0 ✅ |
| Docker | running | v29.2.1, daemon up ✅ |
| Ollama | running + `nomic-embed-text` | v0.21.0, model pulled ✅ |
| npm install | — | already done (node_modules + compiled better-sqlite3 present) ✅ |

---

## What I did

1. Verified prerequisites; Docker daemon was started by the user.
2. Started backing services using the commands in `docker_setup.md` (no compose file needed):
   - `docker run -d --name qdrant -p 6333:6333 qdrant/qdrant`
   - `docker run -d --name redis -p 6379:6379 -v redis_data:/data redis:7-alpine redis-server --appendonly yes`
   - `docker run -d --name falkordb -p 6380:6379 -v falkordb_data:/data falkordb/falkordb`
   - **Skipped the Ollama container** (docker_setup.md runs Ollama in Docker) because Ollama is already running natively on Windows at :11434 — a container would conflict on the port.
3. `ollama pull nomic-embed-text` (274 MB) and warmed the embeddings endpoint (verified 768-dim output).
4. Did **not** create/modify `.env.local` — it already existed, fully populated and git-ignored.
5. Started Sage and ran the smoke test.

### How Sage was started (non-destructive runtime overrides)
`.env.local` was left untouched. Sage was launched with these process-env overrides (dotenv uses `override:false`, so process env wins without editing the file):
```
SAGE_ZEP_ENABLED=false \
SAGE_MEMORY_RETRIEVAL_BUDGET_MS=8000 \
SAGE_MEMORY_RETRIEVAL_TIMEOUT_MS=8000 \
SAGE_MEMORY_TIMEOUT_MNEMOSYNE_MS=8000 \
node src/index.js
```
- **Zep disabled:** avoids a dependency on the Zep cloud backend for this local smoke test. (mem0 was left enabled; it is healthy.)
- **Retrieval budget raised to 8s:** the default `SAGE_MEMORY_RETRIEVAL_BUDGET_MS=180`/`TIMEOUT_MS=200` is too tight for a cold local stack — observed retrieval latency was **483ms** (embedding + Qdrant search). At the default budget, retrieval would time out and return empty context → a false negative. This is a **production latency knob**, not a correctness setting; see Recommendations.

---

## Smoke test — PASS ✅

Endpoints checked:
- `GET /health` → `200`, all enabled subsystems `ok`.
- `GET /v1/models` (Bearer `SAGE_API_KEY`) → `200`, returns `gpt-4.1-mini`, `gpt-5.2`.

Two-turn memory round-trip (model `gpt-4.1-mini`, fixed header `X-OpenWebUI-Chat-Id: sage-smoke-roundtrip-003`):
- **Turn 1 (state fact):** *"Please remember these facts about me: my favourite colour is teal, and my project codename is Albatross."* → assistant acknowledged.
- Waited for async write to settle — confirmed deterministically: Qdrant `sage_mem_v2` went from 0 → **2 points**.
- **Turn 2 (recall — only the question sent, no history resent):** *"Based only on what you remember about me, what is my favourite colour and my project codename?"*
- **Reply:** *"Your favorite color is teal, and your project codename is Albatross."* ✅

**Why this proves the write→read path (not just that the server boots):** the HTTP layer is stateless and the turn-2 request contained **only** the question — the fact was never re-sent. The only source of "teal/Albatross" is Sage's memory retrieval. The server log for the recall request confirms it:
```
"Memory retrieval completed" memoryRetrieveLatencyMs:483 graphCount:0 semanticCount:1 episodicCount:2
```
i.e. Mnemosyne returned 1 semantic + 2 episodic memories that were injected into the prompt.

---

## Findings worth knowing (diagnoses)

1. **`SAGE_DEFAULT_MODEL=gpt-5.2-mini` is not available upstream.** `/v1/models` returns only `gpt-4.1-mini` and `gpt-5.2` (the allowlist also lists `gpt-5.2-mini`/`gpt5.2-turbo`, which OpenAI does not currently expose, so they're filtered out). A request that omits `model` would fall back to `gpt-5.2-mini` and **404 (model_not_found)**. The smoke test used `gpt-4.1-mini` explicitly. **Fix:** set `SAGE_DEFAULT_MODEL` to `gpt-5.2` or `gpt-4.1-mini`.

2. **The word "secret" silently blocks storage (initial false negative).** My first attempt used *"my **secret** project codename"*. The `mnemosy-ai` package classifies any text matching `/\bsecret\b/i` (also `password`, `token`, `api key`, card/SSN patterns) as **SECRET** and `store()` throws "Cannot store SECRET-classified content"; Sage's adapter wrapper swallows the error, so the turn is silently **not** persisted (Qdrant stayed at 0 points, no error surfaced to the client). Removing the word "secret" fixed it. This is by-design secret-redaction in the memory layer, but it fails silently — worth noting for anyone testing or debugging memory.

3. **mem0 extracted 0 facts (`extractedFactCount:0`).** Even with mem0 healthy, it returned no structured facts for these messages, so no *semantic-fact* upsert occurred via the mem0 path. The round-trip still succeeded because Mnemosyne stores every raw turn as **episodic** memory (and one was also classified semantic), and retrieval recalls those. So memory works without relying on mem0 extraction; mem0's contribution here was nil. If structured-fact extraction is important, investigate the mem0 adapter/config separately.

4. **Collection naming:** `createMnemosyne({collectionName:"sage_mem_v2"})` maps to the package's **SHARED** collection. Public content → `sage_mem_v2`; private → `memory_private`; profiles → `agent_profiles`; skills → `skill_library`. (Initially confusing when `sage_mem_v2` showed 0 points — content can land in `memory_private`.)

5. **Leftover test data:** the smoke test left a few points in Qdrant `sage_mem_v2` (scopes `sage-smoke-roundtrip-002/003`) and rows in `data/sage-conversations.sqlite`. Harmless; delete the `qdrant`/`redis`/`falkordb` containers' volumes if you want a clean slate.

---

## Human-only tasks (credentials / signups / decisions)

Most are already satisfied because `.env.local` is fully populated. Listed for completeness with exact locations.

| # | Task | Location / variable | Status |
|---|------|---------------------|--------|
| 1 | OpenAI (or compatible) chat API key | `.env.local` → `OPENAI_API_KEY` (also `SAGE_LLM_LOCAL_API_KEY`, `SAGE_LLM_CLOUD_API_KEY`) | ✅ Present & valid (chat + models work) |
| 2 | Sage API bearer key | `.env.local` → `SAGE_API_KEY` | ✅ Present (`local-dev-keynew`) |
| 3 | Brave Search key (required while `WEB_SEARCH_ENABLED=true`, enforced at startup `src/config/env.js:271`) | `.env.local` → `BRAVE_API_KEY` | ✅ Present (not exercised in smoke test) |
| 4 | mem0 cloud account/key | `.env.local` → `MEM0_API_KEY`, `MEM0_PROJECT_ID` | ✅ Present, health OK (extracts 0 facts — review if needed) |
| 5 | Zep cloud account/key | `.env.local` → `ZEP_API_KEY`, `ZEP_BASE_URL` | ✅ Present, but **disabled for this run**; re-enable + verify to use it |
| 6 | **Decision:** keep Zep + tight retrieval budget for production, or the local-test overrides used here | `.env.local` (`SAGE_ZEP_ENABLED`, `SAGE_MEMORY_RETRIEVAL_BUDGET_MS`) | ⚠️ Needs human decision |
| 7 | **Decision:** fix `SAGE_DEFAULT_MODEL` to an available model | `.env.local` → `SAGE_DEFAULT_MODEL` | ⚠️ Recommended fix |

### 🔐 Security note
`.env.local` contains **live-looking** OpenAI / Brave / mem0 / Zep keys. They are git-ignored (`.gitignore:2`), so not in version control — good. I did not print, copy, or transmit any key value. **Recommendation:** if these are real keys, confirm they have not been exposed and rotate as appropriate; prefer per-developer keys on shared machines.

---

## Recommendations (optional, not done — would change config/behavior)
- Set `SAGE_DEFAULT_MODEL=gpt-5.2` (or `gpt-4.1-mini`) so default-model requests don't 404.
- If running the local Mnemosyne stack as the norm, raise `SAGE_MEMORY_RETRIEVAL_BUDGET_MS`/`SAGE_MEMORY_RETRIEVAL_TIMEOUT_MS` (e.g. 1500–3000ms) — the 180/200ms default is too tight for a cold local embedding model and causes empty memory context.
- Consider whether the silent swallow of SECRET-classification store failures should be logged at `warn` so operators can see why a memory wasn't stored.
