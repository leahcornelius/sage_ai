# Low-Level Internals

## Source Layout
```text
src/
  app.js
  index.js
  auth/
  config/
  errors/
  http/
    hooks/
    routes/
    serializers/
    validation/
  logging/
  providers/
  services/
  tools/
    builtin/
    mcp/
  utils/
```

## Directory Responsibilities
- `src/auth`: authentication helpers.
- `src/config`: environment parsing and validation.
- `src/errors`: app error model + OpenAI payload conversion.
- `src/http`: route hooks, handlers, validation, serializers.
- `src/logging`: pino logger and safe debug helpers.
- `src/providers`: external service clients (OpenAI, Mnemosyne).
- `src/services`: domain orchestration logic.
- `src/tools`: tool definitions, registry, execution, MCP support.
- `src/utils`: shared generic helpers.

## File-by-File Reference

| File | Main exports | Owns | Called by |
|---|---|---|---|
| `src/index.js` | `main` (invoked at module load) | Runtime bootstrap and shutdown wiring | Node entrypoint |
| `src/app.js` | `buildApp` | Fastify wiring, route registration, error handler | `src/index.js` |
| `src/auth/bearer-auth.js` | `authenticateBearerToken`, `extractBearerToken` | Bearer token parsing and secure compare | `src/http/hooks/auth.js` |
| `src/config/env.js` | `createConfig` | Env parsing, defaults, and validation | `src/index.js`, `test/env.test.js` |
| `src/errors/app-error.js` | `AppError`, `isAppError` | Canonical app error shape | Validation/services/errors modules |
| `src/errors/openai-error-response.js` | `coerceToAppError`, `toOpenAIErrorPayload` | Error normalization to OpenAI payloads | `src/app.js` |
| `src/http/hooks/auth.js` | `createAuthHook` | Route auth hook for `/v1` | `src/app.js` |
| `src/http/hooks/request-logging.js` | `registerRequestLogging` | Structured request lifecycle logging | `src/app.js` |
| `src/http/routes/health.js` | `registerHealthRoutes` | `/health` endpoint | `src/app.js` |
| `src/http/routes/models.js` | `registerModelRoutes` | `/v1/models` endpoint | `src/app.js` |
| `src/http/routes/chat-completions.js` | `registerChatCompletionRoutes` | `/v1/chat/completions`, SSE writing, post-stream extraction trigger | `src/app.js` |
| `src/http/serializers/openai-chat.js` | `serializeChatCompletion`, `serializeChatCompletionChunk`, extractors | OpenAI response/chunk normalization helpers | Routes/services/memory |
| `src/http/serializers/openai-models.js` | `serializeModel`, `serializeModelList` | Model list payload shaping | `src/http/routes/models.js` |
| `src/http/validation/chat-completions.js` | `validateChatCompletionsRequest` | Top-level chat request validation and normalization | `src/http/routes/chat-completions.js` |
| `src/http/validation/messages.js` | `normalizeMessages`, `getLastUserMessageContent` | Message normalization/constraints | `chat-completions` validation |
| `src/logging/logger.js` | `createLogger` | Console/file pino transport and redaction config | `src/index.js` |
| `src/logging/safe-debug.js` | `excerptText`, `textLength`, `roleSequence`, `objectKeys` | Safe debugging primitives | Many services/routes/tools |
| `src/providers/openai-client.js` | `createOpenAIClient` | OpenAI SDK client creation | `src/index.js` |
| `src/providers/mnemosyne-client.js` | `createMnemosyneClient` | Mnemosyne backend client creation | `src/index.js` |
| `src/services/chat-service.js` | `createChatService` | Main request orchestration, tool loop, streaming behavior | `src/index.js`, chat route |
| `src/services/memory-service.js` | `createMemoryService` | Recall, context formatting, extraction/store and memory tools API | `src/index.js`, chat/tool layers |
| `src/services/model-service.js` | `createModelService` | Upstream model cache, allowlist filtering, model existence checks | `src/index.js`, chat/model routes |
| `src/services/prompt-service.js` | `createPromptService` | System prompt file loading and active prompt selection | `src/index.js`, chat service |
| `src/tools/tool-registry.js` | `createToolRegistry` | Merge built-in, MCP, and client tools into effective tool context | `src/index.js`, chat service |
| `src/tools/tool-executor.js` | `createToolExecutor` | Concurrent tool execution with timeout/result envelope | `src/index.js`, chat service |
| `src/tools/builtin/get-memories.js` | `getMemoriesTool`, `createGetMemoriesHandler` | Built-in memory read tool contract/handler | Tool registry |
| `src/tools/builtin/add-memory.js` | `addMemoryTool`, `createAddMemoryHandler` | Built-in memory write tool contract/handler | Tool registry |
| `src/tools/builtin/web-search.js` | `webSearchTool`, `createWebSearchHandler` | Built-in web search tool contract/handler | Tool registry |
| `src/tools/mcp/mcp-client-manager.js` | `createMcpClientManager` | MCP server initialization, listing, invocation | `src/index.js`, tool registry |
| `src/tools/mcp/mcp-tool-adapter.js` | `mapMcpToolsToOpenAiTools`, `parseNamespacedToolName`, `toNamespacedToolName` | MCP tool name adaptation | MCP manager |
| `src/utils/abort.js` | `createAbortControllerFromRequest` | Request disconnect to abort-signal bridge | Chat route |
| `src/utils/ids.js` | `createSyntheticId` | Synthetic id generation | Chat serializer |
| `src/utils/time.js` | `toUnixSeconds` | Timestamp normalization | Model serializer |

## Deep Dive 1: Request Validation

### `validateChatCompletionsRequest` (`src/http/validation/chat-completions.js`)
- Ensures JSON object body.
- Rejects unsupported fields (`functions`, `function_call`).
- Enforces `n` to be omitted or `1`.
- Validates `model`.
- Normalizes:
  - `messages` through `normalizeMessages`
  - `stream` to boolean
  - passthrough upstream options
  - `tools` and `tool_choice`
  - `lastUserMessage` for memory recall

### `normalizeMessages` (`src/http/validation/messages.js`)
- Enforces supported role set.
- Coerces array text-parts into plain text string.
- Validates assistant `tool_calls` schema.
- Requires `tool_call_id` for `tool` messages.
- Explicitly rejects unsupported multimodal/function-call message forms.

## Deep Dive 2: Upstream Payload Construction

### `createChatService` (`src/services/chat-service.js`)
`buildUpstreamRequest` prepends three system messages before client messages:
1. Active system prompt from `prompt-service`.
2. Current date (`new Date().toISOString()`).
3. Formatted memory context from `memory-service`.

This guarantees every upstream call receives consistent system context independent of client state.

## Deep Dive 3: Tool Context Merge

### `createToolRegistry` (`src/tools/tool-registry.js`)
Effective tool list per request is built as:
1. All enabled built-in tools.
2. All discovered MCP tools (namespaced as `mcp.<server>.<tool>`).
3. Client-provided tools that do not conflict with built-in names.

Handler map contains only server-resolvable tool handlers (built-in + MCP). Client-only tools may still be advertised upstream but are not executed server-side.

## Deep Dive 4: Tool Execution Semantics

### `createToolExecutor` (`src/tools/tool-executor.js`)
- Concurrency: bounded by `SAGE_TOOL_MAX_PARALLEL_CALLS` and tool call count.
- Timeout: each tool call is raced against `SAGE_TOOL_TIMEOUT_MS`.
- Argument contract: must parse to JSON object.
- Result contract:
  - `handled: false` when no server-side handler exists.
  - `handled: true` with JSON string payload containing `{ ok, data|error }`.
- Oversized result protection: payloads over 8000 bytes are replaced with truncation error envelope.

## Deep Dive 5: Memory Extraction Pipeline

### `extractAndStoreMemories` (`src/services/memory-service.js`)
1. Chooses extraction model (`SAGE_MEMORY_EXTRACTION_MODEL` or request model).
2. Sends extraction prompt + conversation transcript to upstream OpenAI.
3. Parses assistant output as JSON.
4. Normalizes each memory entry:
   - non-empty text required
   - `importance` coerced to integer in range 1..10 else null
   - optional `category` and `eventTime`
5. Stores each memory best-effort through Mnemosyne client.

Parse/store failures are logged and do not bubble to the client request path.

## Configuration Appendix

## Environment Variables and Defaults
Derived from `src/config/env.js` and `.env.example`.

| Variable | Default | Effect |
|---|---|---|
| `OPENAI_API_KEY` | none (required) | Upstream OpenAI auth key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Overrides upstream OpenAI base URL |
| `SAGE_API_KEY` | none (required) | Bearer token expected on `/v1/*` |
| `SAGE_HOST` | `0.0.0.0` | Server bind host |
| `SAGE_PORT` | `8787` | Server bind port |
| `SAGE_CORS_ORIGIN` | unset | Enables CORS for matching origin |
| `SAGE_OPENAI_MODEL_ALLOWLIST` | unset | Comma-separated model filter for visibility/validation |
| `SAGE_MODEL_CACHE_TTL_MS` | `60000` | Model list cache TTL |
| `SAGE_MEMORY_TOP_K` | `5` | Number of recalled memories |
| `SAGE_MEMORY_EXTRACTION_MODEL` | unset | Alternate model for extraction stage |
| `SAGE_SYSTEM_PROMPT_PATH` | `./system_prompt.yaml` | Active prompt file path |
| `SAGE_TOOLS_ENABLED` | `true` | Global server tool support toggle |
| `SAGE_TOOL_MAX_ROUNDS` | `6` | Max assistant-tool rounds in loop |
| `SAGE_TOOL_TIMEOUT_MS` | `10000` | Per tool call timeout |
| `SAGE_TOOL_MAX_PARALLEL_CALLS` | `4` | Max concurrent server-side tool calls |
| `SAGE_MEMORY_TOOL_WRITE_ENABLED` | `true` | Enables/disables `add_memory` tool writes |
| `SAGE_MCP_SERVERS_JSON` | `[]` | MCP server definitions JSON array |
| `SAGE_WEB_SEARCH_ENABLED` | `true` | Enables/disables built-in `web_search` tool |
| `SAGE_WEB_SEARCH_API_URL` | unset | Web search provider endpoint |
| `SAGE_WEB_SEARCH_API_KEY` | unset | Web search provider auth token |
| `SAGE_WEB_SEARCH_MAX_RESULTS` | `5` | Default max web search results |
| `SAGE_WEB_SEARCH_TIMEOUT_MS` | `8000` | Web search provider timeout |
| `SAGE_LOG_LEVEL` | `info` | Legacy shared log level fallback |
| `SAGE_LOG_CONSOLE_LEVEL` | derived | Console log level |
| `SAGE_LOG_FILE_LEVEL` | derived | File log level |
| `SAGE_LOG_FILE_PATH` | `logs/sage.log` | File log destination |
| `SAGE_LOG_FILE_ENABLED` | `true` | Toggle file logging |
| `SAGE_LOG_PRETTY` | `true` on TTY else `false` | Pretty console output toggle |
| `MNEMOSYNE_VECTOR_DB_URL` | `http://localhost:6333` | Vector DB endpoint |
| `MNEMOSYNE_EMBEDDING_URL` | `http://localhost:11434/v1/embeddings` | Embedding endpoint |
| `MNEMOSYNE_GRAPH_DB_URL` | `redis://localhost:6380` | Graph DB endpoint |
| `MNEMOSYNE_CACHE_URL` | `redis://localhost:6379` | Cache endpoint |
| `MNEMOSYNE_AGENT_ID` | `sage-api` | Mnemosyne agent identity |
| `MNEMOSYNE_EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model name |
| `MNEMOSYNE_COLLECTION_NAME` | `testing_container` | Mnemosyne collection |

## Test Coverage Map

| Test file | Main behavior covered |
|---|---|
| `test/app.test.js` | Route auth behavior, endpoint responses, SSE wiring, error mapping |
| `test/chat-service.test.js` | Upstream payload ordering, stream behavior, tool loop/fallback |
| `test/messages.test.js` | Message normalization rules and unsupported content rejection |
| `test/model-service.test.js` | Allowlist filtering and stale cache fallback |
| `test/memory-service.test.js` | Recall/extraction failure tolerance |
| `test/tool-registry.test.js` | Built-in precedence and MCP inclusion |
| `test/tool-executor.test.js` | Missing handler behavior and timeout envelope |
| `test/builtin-tools.test.js` | Built-in tool handlers and normalization |
| `test/env.test.js` | Config parsing/defaults/validation |
| `test/logger.test.js` | File logging and redaction behavior |
| `test/openai-chat-serializer.test.js` | Serializer compatibility with SDK non-enumerable fields |