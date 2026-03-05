# Sage OpenAI-Compatible Server

Sage now runs as an OpenAI-compatible API server that layers Sage's long-term memory behavior on top of the upstream OpenAI Chat Completions API.

## What it supports

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- Streaming chat completions via SSE
- Native tool calling for non-stream and streaming chat completions

## Documentation

- Docs index: [`docs/README.md`](./docs/README.md)
- API usage: [`docs/api.md`](./docs/api.md)
- Architecture: [`docs/architecture.md`](./docs/architecture.md)
- Internals: [`docs/internals.md`](./docs/internals.md)
- Limitations and known issues: [`docs/limitations-and-known-issues.md`](./docs/limitations-and-known-issues.md)

## Requirements

- Node.js 24+
- An OpenAI API key
- Running Mnemosyne dependencies for memory storage:
  - Qdrant
  - Redis
  - FalkorDB/graph backend
  - embedding endpoint

The existing Docker commands are in `docker_setup.md`.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` values into `.env.local` and set at minimum:

```env
OPENAI_API_KEY=...
SAGE_API_KEY=...
```

3. Start the server:

```bash
npm start
```

The default bind address is `http://0.0.0.0:8787`.

## Open WebUI setup

Configure a new OpenAI-compatible provider in Open WebUI with:

- Base URL: `http://<your-host>:8787/v1`
- API key: the value of `SAGE_API_KEY`

Open WebUI will call `/v1/models` to discover available upstream models. If `SAGE_OPENAI_MODEL_ALLOWLIST` is set, only those models are exposed.

## Behavior

- Requests are stateless at the HTTP layer.
- Clients must resend chat history in `messages` for every request.
- Clients must include `conversation_id` (or `conversationId`) on chat requests.
- Sage routes memory operations through a layered memory controller (`mem0`, `Zep`, `Mnemosyne`, `Redis`).
- Memory writes are asynchronous and idempotent (`messageId = sha256(...).hex()`).
- Memory retrieval runs under a global time budget and returns partial/empty context instead of blocking chat.
- mem0 is write-path only; retrieval does not call mem0.
- Sage can execute built-in tools and configured MCP tools in a bounded loop for both non-stream and streaming requests.
- Built-in web retrieval uses a document-handle workflow:
  - `web_search` returns metadata/snippets plus stable `result_id` handles.
  - `get_url_content` fetches and caches full page text server-side and returns `document_id`.
  - `read_document_chunk` and `find_in_document` progressively read/search cached documents.

## V1 limitations

- Chat Completions only
- No `/v1/completions`, `/v1/responses`, or embeddings
- Text-only message content
- Long-term memory is globally shared across all requests
- Old CLI conversation save/load flows are no longer part of the runtime

## Useful environment variables

- `SAGE_OPENAI_MODEL_ALLOWLIST`: comma-separated model ids
- `SAGE_DEFAULT_MODEL`: optional default chat model when request omits `model`
- `SAGE_ALLOW_MODEL_OVERRIDE`: allow/disallow API `model` overriding `SAGE_DEFAULT_MODEL`
- `SAGE_MEMORY_MODE`: memory runtime mode (`hard`, `soft`, `off`)
- `SAGE_MEM0_ENABLED`, `SAGE_ZEP_ENABLED`, `SAGE_REDIS_ENABLED`: backend toggles
- `SAGE_MEMORY_RETRIEVAL_BUDGET_MS`: global retrieval budget
- `SAGE_MEMORY_CONTEXT_MAX_TOKENS`: max injected memory tokens (tokenizer matched to active model)
- `SAGE_MEMORY_IDENTITY_CACHE_TTL_SEC`: identity context cache TTL
- `SAGE_MEMORY_GRAPH_MAX_RESULTS`: graph search result cap
- `SAGE_MEMORY_WRITE_CONCURRENCY_LIMIT`: global async memory write concurrency
- `SAGE_MEMORY_TOOL_WRITE_WHITELIST`: comma-separated tool names allowed to write memory
- `SAGE_MEMORY_EMBEDDING_PROVIDER`, `SAGE_MEMORY_EMBEDDING_MODEL`: semantic embedding settings
- `SAGE_LLM_LOCAL_*` and `SAGE_LLM_CLOUD_*`: primary/fallback LLM routing endpoints and keys
- `SAGE_CONVERSATION_DB_PATH`: SQLite path for persisted conversation history (default `./data/sage-conversations.sqlite`)
- OpenAI reasoning controls (`reasoning_effort` / `reasoning`) are supported as chat request passthrough options
- `SAGE_CORS_ORIGIN`: enable CORS for a frontend origin
- `OPENAI_BASE_URL`: point Sage at a compatible upstream if needed
- `SAGE_TOOLS_ENABLED`: enable server tool support
- `SAGE_MCP_SERVERS_JSON`: JSON array of MCP server definitions
- `WEB_SEARCH_ENABLED`: enable or disable built-in Brave web tools
- `BRAVE_API_KEY`: Brave Search API key for built-in web tools
- `SAGE_BRAVE_*`: Brave mode, locale, safesearch, limits and timeout controls
- `SAGE_DOC_CACHE_TTL_MS`: cached document/result handle TTL in milliseconds
- `SAGE_DOC_CACHE_MAX_DOCS`: maximum in-memory cached documents
- `SAGE_DOC_CACHE_MAX_DOC_BYTES`: max normalized bytes per cached document

## Maintenance scripts

- `npm run migrate:importance`:
  - one-time normalization of stored memory `importance` values from `1..10` to `0..1`
  - idempotent; records completion marker in Qdrant `sage_meta`
- `npm run verify:memory-deps`:
  - verifies `mem0ai` package/auth surface and pinned memory dependency presence

## MCP server config format

`SAGE_MCP_SERVERS_JSON` expects a JSON array of server definitions. Both `http` and `stdio` transports are supported.

HTTP example:

```json
[
  {
    "name": "web",
    "transport": "http",
    "url": "https://mcp.example.com",
    "headers": {
      "Authorization": "Bearer <token>"
    },
    "required": false
  }
]
```

Stdio example (Brave MCP):

```json
[
  {
    "name": "brave",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-brave-search"],
    "env": {
      "BRAVE_API_KEY": "<token>"
    },
    "required": false
  }
]
```

If `required` is `true` and the server cannot initialize, Sage startup will fail. If `required` is `false`, Sage logs a warning and continues.

Exposed MCP tools are namespaced as `mcp.<server>.<tool>`.
