# Sage OpenAI-Compatible Server

Sage now runs as an OpenAI-compatible API server that layers Sage's long-term memory behavior on top of the upstream OpenAI Chat Completions API.

## What it supports

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- Streaming chat completions via SSE
- Tool calling for non-stream chat completions

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
- Sage still recalls long-term memory for the latest user message.
- After a response completes, Sage tries to extract and store new long-term memories in the background.
- For non-stream chat requests, Sage can execute built-in tools and configured MCP tools in a bounded loop.

## V1 limitations

- Chat Completions only
- No `/v1/completions`, `/v1/responses`, or embeddings
- Text-only message content
- Long-term memory is globally shared across all requests
- Old CLI conversation save/load flows are no longer part of the runtime

## Useful environment variables

- `SAGE_OPENAI_MODEL_ALLOWLIST`: comma-separated model ids
- `SAGE_MEMORY_EXTRACTION_MODEL`: separate model for memory extraction
- `SAGE_CORS_ORIGIN`: enable CORS for a frontend origin
- `OPENAI_BASE_URL`: point Sage at a compatible upstream if needed
- `SAGE_TOOLS_ENABLED`: enable server tool support
- `SAGE_MCP_SERVERS_JSON`: JSON array of MCP server definitions
- `SAGE_WEB_SEARCH_*`: configure custom web search backend for `web_search`

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
