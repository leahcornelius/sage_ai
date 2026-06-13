# Sage — Technical Analysis

Read-only analysis of the `Sage` repository, written for an engineer who needs to build a
self-improvement loop that tunes Sage's **memory behaviour**. Everything below is derived from the
source in this repo; file/line citations are given so each claim can be checked. Where the code
diverges from the docs, that is called out explicitly.

## 0. What Sage is (one paragraph)

Sage is an **OpenAI-compatible HTTP facade** (Fastify, Node 24, ESM) that sits in front of an
upstream OpenAI-compatible chat API. It exposes `GET /health`, `GET /v1/models`, and
`POST /v1/chat/completions` (`README.md:5-11`). On every chat request it (a) augments the upstream
prompt with long-term memory context retrieved from a layered memory subsystem, (b) optionally runs
a bounded server-side tool loop, and (c) asynchronously ingests the user and assistant turns back
into memory. The HTTP layer is stateless — clients must resend full `messages` and supply a chat-id
header each request (`README.md:84-89`). The memory subsystem is a controller fanning out to four
backends: **Mnemosyne** (episodic + semantic store, primary read+write), **mem0** (write-path fact
extraction only), **Zep** (graph facts, read+write), and **Redis** (identity/query caches).
Entry point is `src/index.js`; orchestration is `src/services/chat-service.js`; the memory pipeline
is `src/services/memory-service.js` + `src/services/memory/*`.

---

## 1. Memory pipeline, end to end

Two public operations on the controller drive everything:
`processMessage` (WRITE) and `retrieveContext` (READ), both in
`src/services/memory/memory-controller.js`. The facade `src/services/memory-service.js` wraps them
and resolves the scope key.

### 1.1 Scope / identity resolution (shared by both paths)

`resolveScopeKey({ conversationId, user })` returns `user.trim()` if the request supplied a
non-empty `user` field, otherwise falls back to `conversationId` (the chat-id header)
(`memory-controller.js:501-506`, called via `memory-service.js:53,74`). **This is the only tenancy
boundary in the whole memory system.** All caches, Mnemosyne scope tags, Zep `userId`, and mem0
`user_id` key off this single string. If clients don't send `user`, every conversation gets its own
scope; if they do, scope is the user id.

### 1.2 WRITE path — `processMessage` (`memory-controller.js:261-439`)

Triggered three times per chat turn from `chat-service.js`:
- user turn, fire-and-forget, at request start (`chat-service.js:45-54`, `167-176`);
- assistant turn, fire-and-forget, after the response completes
  (`scheduleConversationMemoryIngestion`, `chat-service.js:951-997`, invoked at `141-151` non-stream
  and `299-308` streaming);
- on demand from the `add_memory` tool (`memory-service.js:167-217`, role `"user"`).

Guard: returns `{skipped:true}` immediately if `scopeKey`/`conversationId`/`messageText` missing or
`memoryMode === "off"` (`memory-controller.js:272-274`).

Writes are **serialized per conversation** via `enqueueByConversation` (a promise chain keyed by
`conversationId`, `memory-controller.js:614-626`) and **globally throttled** by an
`AsyncSemaphore(writeConcurrencyLimit)` (`memory-controller.js:17,279,436`).

Steps inside the queued task:
1. **Idempotency id**: `messageId = sha256(conversationId|role|turnIndex|normalizedText)`
   (`createMessageId`, `memory-controller.js:658-666`; whitespace-collapsed text). `turnIndex`
   counts only user/assistant turns (tool messages excluded), derived in
   `deriveLastUserAssistantTurnIndex` (`chat-service.js:1004-1017`) for user turns and from
   `conversationStore.getUaMessageCount` for assistant/tool writes
   (`memory-service.js:122,188,240-249`).
2. **Dedup**: `mnemosyneAdapter.hasMessageId(messageId)`. Checks an in-process `Set` first, then a
   Mnemosyne `recall({query:"message_id:<id>", topK:1})` substring match
   (`mnemosyne-adapter.js:18-37`). If found → `{skipped:true, reason:"duplicate_message_id"}`
   (`memory-controller.js:288-304`).
3. **Episodic store (Mnemosyne)**: `storeEpisodic` writes the raw message with bracketed metadata
   tags (`[scope:][conversation:][role:][turn:][message_id:][timestamp:]`) under category
   `"episodic"`, and also pushes it into an in-process per-scope ring buffer of the last 20 entries
   (`recentEpisodicByScope`, `mnemosyne-adapter.js:39-77,9-16`).
4. **Fact extraction (mem0)**: `mem0Adapter.extractFacts` calls `mem0` `client.add([{role,content}],
   {user_id: scopeKey, metadata})`; mem0 returns memory objects which are normalized into facts with
   inferred `predicate` (keyword match: prefers/likes/works → PREFERS/LIKES/WORKS_AT else KNOWS),
   `factKey = sha256(scope|predicate|object)`, `confidence` from mem0 `score`, etc.
   (`mem0-adapter.js:19-58,75-128`). **mem0 is the only fact extractor.** If mem0 is disabled or
   has no API key, `facts = []` and no semantic/graph facts are ever produced
   (`mem0-adapter.js:7-17,27-29`).
5. **Fan-out (only if `facts.length > 0`)**, via `Promise.allSettled` (`memory-controller.js:349-387`):
   - `mnemosyneAdapter.upsertSemanticFacts`: per fact, conflict-resolves against an **in-process**
     `canonicalFacts` Map keyed by `scope|subject|predicate` (newer eventTime > newer ingestedAt >
     higher confidence wins; loser tagged `status:"conflict"`), then stores to Mnemosyne with
     category (default `"semantic"`) and `importance = confidence` (`mnemosyne-adapter.js:79-115,206-259`).
   - `zepAdapter.upsertFacts`: `client.graph.addFactTriple(...)` per fact (`zep-adapter.js:15-46`).
   - Redis identity refresh: re-reads `mnemosyneAdapter.getIdentityContext` and writes it to the
     Redis identity cache (`memory-controller.js:371-385`).
6. **Cache invalidation**: `redisCache.invalidateScope(scopeKey)` always runs (deletes identity key,
   query index, and all indexed query keys) (`memory-controller.js:389-399`, `redis-cache.js:120-143`).

Failures are caught and logged at warn; the write never throws to the caller
(`memory-controller.js:419-434`). All adapter calls run through `runAdapter` with per-adapter
timeouts, circuit breakers, and enable checks (see §1.4).

> **Critical caveat for memory tuning:** identity context and semantic-fact conflict state live in
> **in-process Maps/Sets** on the Mnemosyne adapter (`seenMessageIds`, `canonicalFacts`,
> `recentEpisodicByScope`, `mnemosyne-adapter.js:4-6`). `getIdentityContext` (§1.3) only ever returns
> facts from this in-process `canonicalFacts` Map — it does **not** query Mnemosyne for identity. So
> identity memory is effectively empty after a restart and is never populated from durable storage;
> episodic summaries likewise come from the in-process ring buffer, not from Mnemosyne queries
> (`mnemosyne-adapter.js:138-180`).

### 1.3 READ path — `retrieveContext` (`memory-controller.js:28-259`)

Called synchronously (awaited) once per chat request before building the upstream payload
(`chat-service.js:56-63`, `178-185`). Query = `requestBody.lastUserMessage`.

1. **Off short-circuit**: `memoryMode === "off"` → `emptyContext` (`memory-controller.js:37-43`).
2. **Deadline**: `deadline = now + retrievalWindowMs`, where
   `retrievalWindowMs = max(retrievalBudgetMs, retrievalTimeoutMs)` (`memory-controller.js:24-26`,
   `env.js:44-47`). Default = `max(180, 200) = 200 ms`.
3. **Query normalization for cache**: lowercase, trim, slice to 256 chars (`normalizeQueryForCache`,
   `memory-controller.js:494-499`).
4. **Identity lookup**: Redis `getIdentityContext(scopeKey)`; on miss/empty, Mnemosyne
   `getIdentityContext` (in-process only, see caveat), and if non-empty, async-write back to Redis
   (`memory-controller.js:48-89`).
5. **Cold-start probe**: `mnemosyneAdapter.hasScopeMemories` (`recall({query:scopeKey,topK:1})`). If
   no identity **and** no scope memories → return `emptyContext({coldStart:true})` **without**
   running graph/semantic/episodic queries (`memory-controller.js:91-116`, `mnemosyne-adapter.js:160-169`).
6. **Query cache**: Redis `getQueryContext(scopeKey, normalizedQuery)`. On hit, rebuild the context
   block from cached buckets and return with `cacheHit:true` (`memory-controller.js:118-156`).
7. **Parallel retrieval (cache miss)** via `Promise.all` of three `runAdapter` calls
   (`memory-controller.js:158-203`):
   - **graph** → `zepAdapter.search({scopeKey, query, limit: graphMaxResults})`
     (`zep-adapter.js:48-77`; falls back to `graph.edge.getByUserId` + local term-overlap scoring on
     a Zep 404, `zep-adapter.js:60-76,118-148`);
   - **semantic** → `mnemosyneAdapter.searchSemantic({scopeKey, query, topK: semanticTopK})`
     (`mnemosyne-adapter.js:117-136`; strips bracket metadata via `cleanStoredText`);
   - **episodic** → `mnemosyneAdapter.getEpisodicSummaries({scopeKey, maxItems: episodicTopK})`
     (in-process ring buffer, last N reversed, `mnemosyne-adapter.js:171-180`).

   Note: Zep `search` ignores `scopeKey` for filtering at the controller level — it passes
   `userId: scopeKey` to Zep. Semantic search passes `scopeKey` to the adapter but the adapter does
   **not** use it to filter the Mnemosyne `recall` (only `query`/`topK`), so semantic recall is not
   actually scoped (`mnemosyne-adapter.js:117-124`).
8. **Merge + token-budget assembly** (see §1.5).
9. **Async cache write**: if a non-empty context block was produced, write merged buckets to the
   Redis query cache (`setQueryContext`, TTL `queryCacheTtlSec`) (`memory-controller.js:220-232`).
10. Return `{contextBlock, partial, cacheHit, coldStart, budgetExceeded, identityMemories,
    graphMemories, semanticMemories, episodicSummaries}`. `partial` is true if any of the three
    parallel adapters failed or the deadline was passed (`memory-controller.js:217-218`).

### 1.4 `runAdapter` — the per-call safety wrapper (`memory-controller.js:508-591`)

Every backend call goes through this. It: skips if the adapter is disabled (`isAdapterEnabled`,
`memory-controller.js:593-612`) or its circuit breaker is open; computes
`effectiveTimeout = min(timeoutMs, deadline - now)` and bails with `budget_exhausted` if ≤0; races
the operation against `withTimeout` (`memory-controller.js:640-656`); records circuit-breaker
success/failure (unless `skipCircuitBreaker`); and returns `{ok, value|error, timeout, durationMs}`.
Circuit breakers come from `CircuitBreakerRegistry` (`src/services/memory/circuit-breaker.js`),
configured by the `circuitBreaker.*` knobs.

### 1.5 Context merge / trim / formatting (`src/services/memory/context-merge.js`)

- `mergeMemoryBuckets` just coerces the four arrays into `{identity, graph, semantic, episodic}`
  (`context-merge.js:3-15`). **No cross-bucket ranking or dedup** — order within each bucket is
  whatever the backend returned. Zep returns score-sorted edges; Mnemosyne returns recall order.
- `buildMemoryContextBlock` (`context-merge.js:17-48`): renders all buckets to text via
  `formatBucketsAsContext`, then **trims to fit `maxTokens`** by popping items in the order
  `["episodic", "semantic", "graph"]` — i.e. episodic is dropped first, **identity is never
  trimmed** (`context-merge.js:30-41`). If even the identity-only block still exceeds budget, it
  returns the sentinel `"Memory context:\nIdentity memory is available but exceeds token budget."`
  (`context-merge.js:43-46`).
- Token counting: `js-tiktoken` `encodingForModel(modelId)`, fallback `cl100k_base`, final fallback
  whitespace word count (`context-merge.js:91-104`). The model id is the request's resolved model.
- Output text format (`formatBucketsAsContext`, `context-merge.js:50-89`):
  ```
  Memory context:
  Identity memories:
  - <text>
  Graph facts:
  - <text>
  Semantic memories:
  - <text>
  Episodic summaries:
  - <text>
  ```
  Empty buckets render as `<Bucket>: (none)`.

### 1.6 Injection into the final prompt (`chat-service.js:866-905`)

`buildUpstreamRequest` prepends **three system messages** before the client messages, in this order:
1. active system prompt (from `prompt-service`, loaded from `system_prompt.yaml`);
2. `Current Date: <ISO now>`;
3. the memory context block (or the "No relevant long-term memories…" sentinel if empty).

Then `...requestBody.messages` (client history) and `...requestBody.upstreamOptions` (passthrough
params). The chat-id header is **not** forwarded upstream. The memory block is always present as a
system message even when empty.

### 1.7 SQLite conversation store (`src/services/conversation-store.js`)

`better-sqlite3`, WAL mode, at `config.memory.conversationDbPath`. On each request
`replaceConversationMessagesFromClient` wipes and re-inserts the client message history and assigns
`ua_index` to user/assistant messages (`conversation-store.js:204-242`); `appendAssistantMessage`
adds the assistant reply (`244-269`). It backs `getUaMessageCount` (used for assistant/tool
`turnIndex`).

> **Dead code relevant to memory tuning:** the store also defines `conversations.summary_*`,
> `memory_generations`, and `memory_extraction_runs` tables plus methods
> (`createExtractionRun`, `addMemoryGeneration`, `listActiveMemoryGenerationsBySourceRange`,
> `updateConversationSummary`, `getUaMessagesInRange`, `deactivateActiveGenerationsByMemoryId`).
> A repo-wide grep shows **none of these are called outside `conversation-store.js` itself**. The
> batched-extraction-with-rolling-summary pipeline described in `docs/internals.md` "Deep Dive 6"
> and the env vars `SAGE_MEMORY_EXTRACT_EVERY`, `SAGE_MEM_EXT_HISTORY_MULTIPLIER`,
> `SAGE_MEMORY_EXTRACTION_MODEL`, `SAGE_MEMORY_SUMMARY_MODEL` are **not wired into the running code**
> — those config values are only parsed (`env.js:194-213`) and logged at startup
> (`index.js:34-35`). Actual extraction is single-message via mem0 (§1.2 step 4). This is the single
> biggest doc-vs-code divergence and a likely point of confusion when tuning extraction.

---

## 2. Memory config surface

All config is parsed in `src/config/env.js` (`createConfig`). The memory block is `config.memory`
(`env.js:91-234`). Defaults are the second arg to the parse helpers. "Used at" = where the value is
actually read at runtime (parsed-but-unused values are flagged).

### 2.1 Mode and backend enable flags
| Config (`config.memory.*`) | Env var | Default | What it does | Read at |
|---|---|---|---|---|
| `mode` | `SAGE_MEMORY_MODE` | `hard` | `hard`\|`soft`\|`off`. `off` disables all memory ops; `hard` makes startup fail if enabled backends are unhealthy (`assertReady`); `soft` logs health but tolerates failures. | `env.js:48-52`; `memory-controller.js:37,272,460-486` |
| `mem0Enabled` | `SAGE_MEM0_ENABLED` | `true` | Enables mem0 adapter (write-path fact extraction). | `env.js:93`; `mem0-adapter.js:7` |
| `zepEnabled` | `SAGE_ZEP_ENABLED` | `true` | Enables Zep adapter (graph read+write). | `env.js:94`; `zep-adapter.js:5` |
| `redisEnabled` | `SAGE_REDIS_ENABLED` | `true` | Enables Redis cache (identity/query caches). | `env.js:95`; `redis-cache.js:7` |

### 2.2 Retrieval depth / buckets
| Config | Env var | Default | What it does | Read at |
|---|---|---|---|---|
| `topK` | `SAGE_MEMORY_TOP_K` | `5` | Default cap for the `get_memories` tool result list (and tool fallback). **Not used by the chat retrieval path.** | `env.js:96`; `memory-service.js:157` |
| `semanticTopK` | `SAGE_MEMORY_SEMANTIC_TOP_K` | `5` | `topK` passed to Mnemosyne semantic search. | `env.js:97-101`; `memory-controller.js:185` |
| `episodicTopK` | `SAGE_MEMORY_EPISODIC_TOP_K` | `3` | `maxItems` for episodic ring-buffer summaries. | `env.js:102-106`; `memory-controller.js:199` |
| `graphMaxResults` | `SAGE_MEMORY_GRAPH_MAX_RESULTS` | `20` | `limit` for Zep graph search. | `env.js:107-111`; `memory-controller.js:170` |

### 2.3 Token budget / trim
| Config | Env var | Default | What it does | Read at |
|---|---|---|---|---|
| `contextMaxTokens` | `SAGE_MEMORY_CONTEXT_MAX_TOKENS` | `1200` | Max tokens for the assembled memory block; trim order episodic→semantic→graph (identity never trimmed). Tokenizer matched to request model. | `env.js:112-116`; `memory-controller.js:132,213`; `context-merge.js:33-46` |

### 2.4 Time budgets / deadlines
| Config | Env var | Default | What it does | Read at |
|---|---|---|---|---|
| `retrievalTimeoutMs` | `SAGE_MEMORY_RETRIEVAL_TIMEOUT_MS` | `200` | Component of the retrieval window (see below). | `env.js:34-38` |
| `retrievalBudgetMs` | `SAGE_MEMORY_RETRIEVAL_BUDGET_MS` | `180` | Component of the retrieval window. | `env.js:39-43` |
| `retrievalWindowMs` | (derived) | `max(timeout,budget)` = `200` | The real deadline for the whole `retrieveContext` fan-out; per-call timeouts are clamped to remaining window. | `env.js:44-47`; `memory-controller.js:24-26,46` |
| `timeouts.mem0Ms` | `SAGE_MEMORY_TIMEOUT_MEM0_MS` | `250` | Per-call timeout for mem0 (write path only). | `env.js:142-146`; `memory-controller.js:329` |
| `timeouts.zepMs` | `SAGE_MEMORY_TIMEOUT_ZEP_MS` | `120` | Per-call timeout for Zep. | `env.js:147-151`; `memory-controller.js:169,366` |
| `timeouts.mnemosyneMs` | `SAGE_MEMORY_TIMEOUT_MNEMOSYNE_MS` | `120` | Per-call timeout for Mnemosyne ops. | `env.js:152-156`; multiple in controller |
| `timeouts.redisMs` | `SAGE_MEMORY_TIMEOUT_REDIS_MS` | `30` | Per-call timeout for Redis ops. | `env.js:157-161`; multiple in controller |

> Note on budgeting: with defaults, the window is 200 ms but the Mnemosyne identity lookup, scope
> probe, and query-cache lookup happen **sequentially before** the parallel fan-out, each up to 120/30
> ms, so the window can be largely consumed before graph/semantic/episodic even start — increasing
> `partial`/timeout likelihood. Tuning the window upward is often necessary for non-trivial recall.

### 2.5 Circuit breaker
| Config | Env var | Default | What it does | Read at |
|---|---|---|---|---|
| `circuitBreaker.failureThreshold` | `SAGE_MEMORY_CB_FAILURE_THRESHOLD` | `5` | Failures within window before a backend is skipped. | `env.js:163-168`; `memory-controller.js:18-22` |
| `circuitBreaker.windowMs` | `SAGE_MEMORY_CB_WINDOW_MS` | `60000` | Rolling failure window. | `env.js:169-173` |
| `circuitBreaker.cooldownMs` | `SAGE_MEMORY_CB_COOLDOWN_MS` | `30000` | How long the breaker stays open. | `env.js:174-178` |

### 2.6 Caches
| Config | Env var | Default | What it does | Read at |
|---|---|---|---|---|
| `identityCacheTtlSec` | `SAGE_MEMORY_IDENTITY_CACHE_TTL_SEC` | `300` | TTL for Redis identity cache. | `env.js:120-124`; `redis-cache.js:93` |
| `queryCacheTtlSec` | `SAGE_MEMORY_QUERY_CACHE_TTL_SEC` | `120` | TTL for Redis query-context cache + index. | `env.js:125-129`; `redis-cache.js:102,111,117` |
| `redisUrl` | `SAGE_REDIS_URL` \|\| `MNEMOSYNE_CACHE_URL` | `redis://localhost:6379` | Redis connection for the cache layer. | `env.js:180-183`; `redis-cache.js:8,14` |

### 2.7 Embedding / Mnemosyne backend
| Config | Env var | Default | What it does | Read at |
|---|---|---|---|---|
| `embeddingProvider` | `SAGE_MEMORY_EMBEDDING_PROVIDER` | `mnemosyne` | Stored on config; **only logged**, not used to select a provider in code. | `env.js:130-131` |
| `embeddingModel` | `SAGE_MEMORY_EMBEDDING_MODEL` \|\| `MNEMOSYNE_EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model passed to the Mnemosyne client. | `env.js:132-135`; `mnemosyne-client.js:32` |
| `mnemosyne.vectorDbUrl` | `MNEMOSYNE_VECTOR_DB_URL` | `http://localhost:6333` | Qdrant vector DB. | `env.js:218-220`; `mnemosyne-client.js:27` |
| `mnemosyne.embeddingUrl` | `MNEMOSYNE_EMBEDDING_URL` | `http://localhost:11434/v1/embeddings` | Embedding endpoint (Ollama-style). | `env.js:221-223`; `mnemosyne-client.js:28` |
| `mnemosyne.graphDbUrl` | `MNEMOSYNE_GRAPH_DB_URL` | `redis://localhost:6380` | Mnemosyne graph backend. | `env.js:224-225`; `mnemosyne-client.js:29` |
| `mnemosyne.cacheUrl` | `MNEMOSYNE_CACHE_URL` | `redis://localhost:6379` | Mnemosyne internal cache. | `env.js:226-227`; `mnemosyne-client.js:30` |
| `mnemosyne.agentId` | `MNEMOSYNE_AGENT_ID` | `sage-api` | Mnemosyne agent identity. | `env.js:228`; `mnemosyne-client.js:31` |
| `mnemosyne.collectionName` | `MNEMOSYNE_COLLECTION_NAME` | `sage_mem_v2` | Mnemosyne/Qdrant collection. **(`docs/internals.md:225` wrongly lists `testing_container`.)** | `env.js:231-232`; `mnemosyne-client.js:33` |

### 2.8 Write concurrency
| Config | Env var | Default | What it does | Read at |
|---|---|---|---|---|
| `writeConcurrencyLimit` | `SAGE_MEMORY_WRITE_CONCURRENCY_LIMIT` | `8` | Global semaphore size for concurrent memory writes. | `env.js:136-140`; `memory-controller.js:17` |

### 2.9 mem0 / Zep credentials
| Config | Env var | Default | Read at |
|---|---|---|---|
| `mem0.apiKey` | `MEM0_API_KEY` | none | `env.js:185`; `mem0-adapter.js:10-16`. **No key ⇒ mem0 client is null ⇒ zero fact extraction.** |
| `mem0.baseUrl` | `MEM0_BASE_URL` | `https://api.mem0.ai` | `env.js:186` |
| `mem0.organizationId` / `projectId` | `MEM0_ORG_ID` / `MEM0_PROJECT_ID` | none | `env.js:187-188` |
| `zep.apiKey` | `ZEP_API_KEY` | none | `env.js:191`; `zep-adapter.js:8-13`. No key ⇒ Zep client null ⇒ graph read/write are no-ops. |
| `zep.baseUrl` | `ZEP_BASE_URL` | none | `env.js:192` |

### 2.10 Parsed-but-unused memory config (landmines)
These are read into config and logged but **not consumed** by the running memory pipeline (confirmed
by grep; see §1.7):
`extractionModel` (`SAGE_MEMORY_EXTRACTION_MODEL`), `extractionAllowModelOverride`,
`summaryModel` (`SAGE_MEMORY_SUMMARY_MODEL`), `summaryAllowModelOverride`,
`extractEvery` (`SAGE_MEMORY_EXTRACT_EVERY`), `extractionHistoryMultiplier`
(`SAGE_MEM_EXT_HISTORY_MULTIPLIER`) — all `env.js:194-213`.

### 2.11 Tool-side memory knobs (`config.tools.*`)
| Config | Env var | Default | What it does | Read at |
|---|---|---|---|---|
| `memoryWriteEnabled` | `SAGE_MEMORY_TOOL_WRITE_ENABLED` | `true` | Gate on `add_memory` tool. | `env.js:265`; `add-memory.js:38-45` |
| `memoryWriteWhitelist` | `SAGE_MEMORY_TOOL_WRITE_WHITELIST` | `["add_memory"]` | Tool names allowed to write memory. | `env.js:266-267`; `add-memory.js:46-56`, `memory-service.js:178-186` |

---

## 3. Config mutability

**Read once at startup; no hot reload.** `createConfig()` is called exactly once in `main()`
(`index.js:24`) and reads `process.env` after loading `.env.local` once at module import
(`env.js:6-10`). The resulting object is passed by reference into every service/adapter constructor
(`index.js:64-109`) and the adapters cache derived state at construction time — most importantly the
`enabled` flags (`mem0-adapter.js:7`, `zep-adapter.js:5`, `mnemosyne-adapter.js:3`, `redis-cache.js:7`),
the mem0/Zep/Redis clients, and the semaphore/circuit-breaker registry in the controller
(`memory-controller.js:17-22`). Nothing watches the file or re-reads `process.env`.

Consequences for a tuning loop:
- Any memory knob change requires a **process restart** (or `node --watch` in dev, `package.json:9`).
- There is **no admin/control endpoint** to mutate config — only `GET /health`, `GET /v1/models`,
  `POST /v1/chat/completions` exist (`docs/api.md`, route files under `src/http/routes`).
- A few knobs (`semanticTopK`, `episodicTopK`, `graphMaxResults`, `contextMaxTokens`,
  per-call `timeouts.*`, cache TTLs, `memoryWriteWhitelist`) are read **per request** off the live
  `config` object, so an in-memory mutation of `config.memory.*` *would* take effect without restart
  **if** something mutated it — but nothing does, and the adapter `enabled` flags and clients are
  fixed at construction, so toggling backends or credentials still needs a restart. A self-improvement
  loop could exploit the per-request reads by mutating the shared config object in-process, but that
  is not a supported/wired path today.

---

## 4. Driving a single query programmatically (`/v1/chat/completions`)

Contract enforced by `validateChatCompletionsRequest` (`src/http/validation/chat-completions.js`)
and the route (`src/http/routes/chat-completions.js`).

### 4.1 Identity / scope
- **Required header**: exactly one of `X-OpenWebUI-Chat-Id` or `X-Conversation-ID` (must match if
  both given); becomes `requestBody.chatId` → `conversationId` (`chat-completions` validation `211-246`).
  Missing → HTTP 400.
- **Optional `user` body field**: passthrough to upstream *and* used as the memory `scopeKey` when
  present (`validation:69,77-83`; `memory-controller.js:501-506`). This is the lever for per-user
  memory scoping; without it, scope = chat-id.
- **Bearer auth**: `Authorization: Bearer <SAGE_API_KEY>` on all `/v1/*` (`docs/api.md:17-22`,
  `src/http/hooks/auth.js`).

### 4.2 Streaming vs non-streaming
- `stream: false` (default) → `createChatCompletion`, returns one OpenAI completion JSON
  (`route:44-53`, `chat-service.js:28-154`).
- `stream: true` → SSE: `Content-Type: text/event-stream`, `data: <json>` lines, terminated by
  `data: [DONE]` (`route:55-129`, `chat-service.js:156-311`). `stream_options` only forwarded when
  streaming (`validation:57-59`).
- Both paths run memory READ (awaited) + user-turn WRITE (fire-and-forget) before upstream, and an
  assistant-turn WRITE after.

### 4.3 Passthrough params (forwarded upstream)
`temperature, top_p, max_tokens, max_completion_tokens, reasoning_effort, reasoning, stop, seed,
presence_penalty, frequency_penalty, user` (`validation:5-17`). `reasoning_effort:"none"` /
`reasoning.effort:"none"` are stripped (`validation:248-261`). Rejected: `functions`,
`function_call`, `n != 1` (`validation:4,29-49`).

### 4.4 Tool calling
- `tools` (array of `{type:"function", function:{name,description?,parameters?}}`) and `tool_choice`
  (`none`|`auto`|`required`|`{type:"function",function:{name}}`) (`validation:94-209`).
- Server merges built-in tools (`get_memories`, `add_memory`, web tools), MCP tools
  (`mcp.<server>.<tool>`), and non-conflicting client tools (`tool-registry`, `docs/internals.md:118-126`).
- Bounded loop: up to `SAGE_TOOL_MAX_ROUNDS` (default 6); per-call timeout `SAGE_TOOL_TIMEOUT_MS`;
  parallelism `SAGE_TOOL_MAX_PARALLEL_CALLS` (`chat-service.js:333-553`, `env.js:256-264`). Tool
  results appended as `tool` role messages between rounds.

### 4.5 Minimal call to WRITE a memory
The user turn of any chat request is auto-ingested, but extraction only produces durable facts via
mem0. To force an explicit, deterministic write, call the `add_memory` tool. Minimal non-stream
request that gets the model to store a memory:
```bash
curl -sS http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $SAGE_API_KEY" \
  -H "X-Conversation-ID: tune-001" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2",
    "messages": [{"role":"user","content":"Remember that I prefer tea over coffee."}],
    "tools": [{"type":"function","function":{"name":"add_memory",
      "parameters":{"type":"object","properties":{
        "text":{"type":"string"},"importance":{"type":"integer"},
        "category":{"type":"string"},"event_time":{"type":"string"}},
        "required":["text"]}}}],
    "tool_choice": {"type":"function","function":{"name":"add_memory"}}
  }'
```
`add_memory` routes to `memory-service.addMemoryFromTool` → `processMessage(role:"user")`
(`add-memory.js:112-119`, `memory-service.js:167-198`). The write is still asynchronous relative to
backend persistence and depends on mem0 for fact extraction; episodic storage to Mnemosyne is
unconditional. Note `importance` is `1..10` at the tool boundary, normalized to `0..1` internally
(`add-memory.js:68-88`, `memory-service.js:251-266`).

### 4.6 Minimal call to RETRIEVE against it
Two ways:
1. **Implicit** — any subsequent chat request with the **same scope** (same `X-Conversation-ID`, or
   same `user`) injects recalled memory as the third system message; you observe it indirectly via
   the model's answer.
2. **Explicit** — call the `get_memories` tool, which returns the recalled memories as structured
   JSON in the tool result (best for a tuning loop that wants to inspect recall directly):
```bash
curl -sS http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $SAGE_API_KEY" \
  -H "X-Conversation-ID: tune-001" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2",
    "messages": [{"role":"user","content":"What do you remember about my drink preference?"}],
    "tools": [{"type":"function","function":{"name":"get_memories",
      "parameters":{"type":"object","properties":{
        "query":{"type":"string"},"top_k":{"type":"integer"}},"required":["query"]}}}],
    "tool_choice": {"type":"function","function":{"name":"get_memories"}}
  }'
```
`get_memories` → `getMemoriesForTool` retrieves via the controller and returns
`identity + graph + semantic` memories sliced to `top_k` (default `config.memory.topK`)
(`get-memories.js:28-56`, `memory-service.js:135-165`). **It deliberately omits episodic.** It also
uses `conversationId:"tool-memory"` and `user:null` unless wired otherwise, so its scope is
`"tool-memory"` — **not** the request's chat scope (`memory-service.js:140-150`). That is a
mismatch to be aware of: `get_memories` will not see memories written under a different scope key
unless the caller passes a matching `user`/conversation (which the tool handler does not currently
thread through). For faithful read-back in a tuning loop, prefer the implicit path (same scope) or
account for this fixed scope.

---

## 5. Retrieval backends — read vs write roles

| Backend | Client / pkg | On READ path? | On WRITE path? | Contributes |
|---|---|---|---|---|
| **Mnemosyne** | `mnemosy-ai` `createMnemosyne` (`mnemosyne-client.js`) | **Yes** — identity probe (in-proc), cold-start probe, semantic search, episodic summaries (in-proc) | **Yes** — episodic store, semantic fact upsert, dedup lookup | Primary store. Episodic raw turns + semantic facts in Qdrant; the **semantic search** is the main durable recall channel. Identity & episodic *reads* are in-process only (lost on restart). |
| **mem0** | `mem0ai` `MemoryClient` (`mem0-adapter.js`) | **No** (test `memory-controller.test.js:38-87` asserts retrieval never calls mem0; `README.md:90`) | **Yes** — the *only* fact extractor; its output feeds Mnemosyne semantic + Zep graph upserts | Turns raw messages into structured facts. If absent, no semantic/graph facts are ever created. |
| **Zep** | `@getzep/zep-cloud` `ZepClient` (`zep-adapter.js`) | **Yes** — `graph.search` (the "graph facts" bucket), with 404 fallback to `edge.getByUserId` | **Yes** — `graph.addFactTriple` per extracted fact | Graph/relational recall keyed on `userId = scopeKey`. |
| **Redis** | `ioredis` (`redis-cache.js`) | **Yes** — identity cache + query-context cache (read), with in-memory `Map` fallback when no client | **Yes** — identity refresh + scope invalidation | Latency cache only; never an authoritative source. Falls back to a process-local Map if `redis` client is null (only constructed when `redisEnabled`). |

Net: **durable cross-restart recall flows through Mnemosyne semantic search and Zep graph search.**
Identity and episodic buckets are in-process and ephemeral. mem0 is strictly write-side.

---

## 6. Tests and how they would run (not run here)

Runner: Node's built-in test runner — `npm test` → `node --test` (`package.json:10`), no extra
framework, no coverage tooling configured. Test files live in `test/` (16 files). Memory-relevant:

- `test/memory-controller.test.js` — asserts: retrieval never calls mem0 (write-only invariant);
  cold-start short-circuit skips graph/semantic when no identity & no scope memories;
  `graphMaxResults` is threaded to Zep; `normalizeQueryForCache` behavior; `createMessageId`
  stability/sha256 shape; global write semaphore enforces concurrency. Uses fully mocked adapters,
  no live backends.
- `test/memory-service.test.js` — recall/extraction failure tolerance (per `docs/internals.md:237`).
- `test/conversation-store.test.js` — SQLite mirror-sync + assistant-append (per `internals.md:233`).
- `test/env.test.js` — config parsing/defaults/validation.
- `test/chat-service.test.js` — upstream payload ordering (the three system messages), streaming,
  tool loop.
- Others: `app.test.js` (auth, routes, SSE, error mapping), `messages.test.js`,
  `model-service.test.js`, `tool-registry.test.js`, `tool-executor.test.js`,
  `builtin-tools.test.js`, `chat-completions-validation.test.js`, `document-cache.test.js`,
  `logger.test.js`, `mcp-client-manager.test.js`, `openai-chat-serializer.test.js`.

Tests mock external clients, so they should run without Redis/Qdrant/Zep/mem0/OpenAI. (`better-sqlite3`
is a native module; `conversation-store`/`document-cache` tests need it compiled for the platform.)
There is **no integration test** exercising live memory backends, and `docs/limitations-and-known-issues.md:38-41`
lists missing tests: max-tool-round overflow, stream-logging reliability, prompt-load integrity.

To run (do not in this task): `npm install` then `npm test`; a single file via
`node --test test/memory-controller.test.js`.

Maintenance scripts (not tests): `scripts/migrate-importance-scale.js`
(`npm run migrate:importance`, normalizes stored `importance` 1..10→0..1, idempotent marker in
Qdrant `sage_meta`) and `scripts/verify-memory-deps.js` (`npm run verify:memory-deps`).

---

## 7. Known limitations / landmines

From `docs/limitations-and-known-issues.md`:
- **Confirmed**: Chat Completions only; text-only content; `n=1` only; **long-term memory is globally
  shared / not partitioned per tenant at the HTTP layer**; clients must resend history each request.
- **Operational**: memory extraction is background best-effort (never affects request success); Brave
  tools fail at runtime if key/network bad; MCP startup gated by per-server `required`; **document
  cache is process-local in-memory** (`document_id`/`result_id` lost on restart, not shared across
  instances); direct URL fallback allows private hosts (SSRF risk — put egress controls around Sage).
- **Code-level (documented, unfixed)**: `streamRequested` logging unreliable at `onRequest`
  (`src/http/hooks/request-logging.js`); `system_prompt.yaml` contains mojibake/encoding artifacts
  that degrade prompt fidelity.

Additional risks I observed in the code (not in the docs), ordered by relevance to a memory-tuning loop:
1. **Doc-vs-code extraction divergence (highest impact).** `docs/internals.md` "Deep Dive 6" and the
   `SAGE_MEMORY_EXTRACT_EVERY` / `SAGE_MEM_EXT_HISTORY_MULTIPLIER` / `SAGE_MEMORY_EXTRACTION_MODEL` /
   `SAGE_MEMORY_SUMMARY_MODEL` env vars describe a batched, summarized, ID-preserving extraction
   pipeline backed by the `memory_generations`/`memory_extraction_runs` SQLite tables. **None of that
   is wired in.** Actual extraction is single-message via mem0 (`memory-controller.js:326-344`), and
   the SQLite extraction tables/methods are never called. Tuning those env vars will have **no effect**.
2. **In-process identity & episodic state.** `getIdentityContext` returns only from the in-process
   `canonicalFacts` Map (never queries Mnemosyne for identity), and episodic summaries come from a
   20-entry in-process ring buffer (`mnemosyne-adapter.js:138-180,4-16`). Both reset on restart and
   are not shared across instances — so two of the four read buckets are ephemeral/non-distributed.
3. **mem0 is a single point of fact creation.** No mem0 key ⇒ `facts=[]` ⇒ nothing is ever written
   to the Mnemosyne *semantic* store or Zep graph (`mem0-adapter.js:10-16,27-29`,
   `memory-controller.js:345-349`). Recall then degrades to episodic raw turns only (which themselves
   are in-process for reads). This makes mem0 availability the dominant factor in recall quality.
4. **Semantic recall isn't scope-filtered.** `searchSemantic` passes only `query`/`topK` to the
   Mnemosyne client and never filters by `scopeKey` (`mnemosyne-adapter.js:117-124`). Combined with
   globally-shared memory, recall can surface other scopes' facts.
5. **`get_memories` uses a fixed `"tool-memory"` scope** and omits episodic, so explicit read-back
   does not match the implicit chat-recall scope (`memory-service.js:135-150`). Easy to mis-measure
   recall in a tuning loop.
6. **Tight default retrieval window (200 ms) with sequential pre-steps** before the parallel fan-out
   (§2.4 note) makes `partial`/timeout the common case on cold or remote backends; recall is silently
   degraded, not errored.
7. **Importance scale split**: tool boundary is 1..10 (`add-memory.js`), persisted scale 0..1
   (`memory-service.js:251-266`); a migration script exists, implying historical data may be mixed.
8. **`config.memory.topK` does not affect chat retrieval** — only the `get_memories` tool and the
   tool fallback use it; chat recall depth is governed by `semanticTopK`/`episodicTopK`/`graphMaxResults`.

---

## 8. Open questions / ambiguities (unresolved from code alone)

1. **`mnemosy-ai` client semantics.** The package (`mnemosyne-client.js:1`) is external; the actual
   filtering/ranking of `recall({query, topK})` and whether stored bracket-tags (`[scope:...]`) are
   used for server-side filtering is opaque. I could only confirm Sage passes `query`/`topK` and does
   not pass scope, so scope-isolation of semantic recall depends on undocumented `mnemosy-ai` behavior.
2. **Does Mnemosyne ever surface identity-category facts on read?** Sage's adapter never queries
   Mnemosyne for identity (only the in-process Map), so even if `mnemosy-ai` stored identity facts
   durably, Sage would not read them back post-restart. Intended? Unclear.
3. **mem0 retrieval intentionally disabled vs incomplete?** README and a test assert mem0 is
   write-only, but mem0 natively supports search; whether read-path mem0 was dropped deliberately or
   is unfinished is not derivable from code.
4. **Extraction pipeline status.** Whether the unused SQLite extraction tables/`extractEvery` machinery
   is planned-but-unwired, or removed-but-left-behind, can't be determined from the repo (no TODOs in
   the relevant files; the docs still describe it as live).
5. **Intended tenancy model.** Docs say memory is "globally shared," yet `scopeKey` keys off
   `user`/`conversationId`. Whether the global-sharing statement reflects the semantic-recall
   non-filtering (#4 in §7) or a deeper design intent is ambiguous.
6. **`MNEMOSYNE_COLLECTION_NAME` default discrepancy** between code (`sage_mem_v2`, `env.js:232`,
   `.env.example:86`) and `docs/internals.md:225` (`testing_container`) — which is authoritative for a
   given deployment depends on what was actually set in env; the code default is `sage_mem_v2`.
7. **`embeddingProvider` knob** (`SAGE_MEMORY_EMBEDDING_PROVIDER`) is parsed but never branched on;
   whether alternate embedding providers were intended is unknown.
