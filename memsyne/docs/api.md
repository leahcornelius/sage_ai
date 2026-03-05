# API Endpoint Usage

## Overview
Sage exposes an OpenAI-compatible HTTP surface with memory augmentation and optional server-side tool execution.

- Public endpoint: `GET /health`
- Authenticated endpoints: `GET /v1/models`, `POST /v1/chat/completions`

## Base URL and Authentication

### Base URL
Default server bind is `http://0.0.0.0:8787`, so local calls are usually made to:
- `http://localhost:8787/health`
- `http://localhost:8787/v1/models`
- `http://localhost:8787/v1/chat/completions`

### Auth model
- `/health` does **not** require auth.
- All `/v1/*` routes require a bearer token:
  - Header: `Authorization: Bearer <SAGE_API_KEY>`

If auth fails, Sage returns an OpenAI-style error payload with HTTP `401` and `error.code = "invalid_api_key"`.

## Endpoint Reference

## `GET /health`
Health probe endpoint.

### Response
```json
{
  "status": "ok"
}
```

## `GET /v1/models`
Returns upstream OpenAI models (optionally filtered by `SAGE_OPENAI_MODEL_ALLOWLIST`).

### Example response shape
```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-5.2",
      "object": "model",
      "created": 1735689600,
      "owned_by": "openai"
    }
  ]
}
```

## `POST /v1/chat/completions`
OpenAI-compatible chat completions endpoint with Sage memory augmentation.

### Required request fields
- `model` (string)
- `conversation_id` (string) or `conversationId` (string alias)
- `messages` (non-empty array)

### Supported optional request fields
The following pass through to upstream OpenAI chat completions:
- `temperature`
- `top_p`
- `max_tokens`
- `max_completion_tokens`
- `stop`
- `seed`
- `presence_penalty`
- `frequency_penalty`
- `user`
- `stream_options` (only passed when `stream: true`)

`conversation_id`/`conversationId` is used by Sage for server-side conversation tracking and is **not** forwarded upstream.

### Tool-related fields
- `tools`: array of function tool definitions
- `tool_choice`: one of `none`, `auto`, `required`, or `{ "type": "function", "function": { "name": "..." } }`

Built-in web tools:
- `web_search`: Brave-backed query search (`llm_context` default), returns lightweight metadata/snippets plus `result_id` handles.
- `get_url_content`: Brave-first URL retrieval with direct-fetch fallback, caches full page text server-side and returns `document_id` + preview metadata.
- `read_document_chunk`: reads document chunks by `document_id`, `offset`, and token profile.
- `find_in_document`: searches cached documents and returns relevant passage offsets.

Token profile argument for web tools:
- `max_tokens` must be one of `2048` (simple factual), `8192` (standard), `16384` (complex research).

### Message rules (validated by Sage)
- Allowed roles: `system`, `developer`, `user`, `assistant`, `tool`
- `content` supports:
  - string
  - array of `{"type":"text","text":"..."}` parts (concatenated)
- Unsupported content/features:
  - non-text content parts (for example image/audio parts)
  - `function_call` message content
  - `audio` message content

### Guarded/unsupported top-level fields
- `functions` is rejected
- `function_call` is rejected
- `n` is supported only when `n = 1`

## Streaming Behavior (`stream: true`)
When `stream` is enabled, Sage returns Server-Sent Events (SSE):
- `Content-Type: text/event-stream; charset=utf-8`
- Each event line is `data: <json>`
- Stream ends with `data: [DONE]`

### Tool + stream behavior
When tools are active with `stream: true`, Sage executes native multi-round streaming tool calls:
- Upstream chunks are forwarded as SSE in real time, including `tool_calls` deltas.
- Sage executes server-handled tool calls between rounds and continues streaming subsequent assistant output.
- Stream still terminates with `data: [DONE]`.

## Error Envelope
Sage normalizes errors into OpenAI-style shape:

```json
{
  "error": {
    "message": "Human readable message",
    "type": "invalid_request_error",
    "param": "model",
    "code": "invalid_request_error"
  }
}
```

Common status/code examples:
- `401` + `invalid_api_key`
- `400` + `invalid_request_error`
- `400` + `unsupported_feature`
- `404` + `model_not_found`
- `502` + `upstream_error`

## Usage Examples

## 1) Non-stream chat completion (`curl`)
```bash
curl -sS http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $SAGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2",
    "conversation_id": "conv-demo-1",
    "messages": [
      {"role": "user", "content": "Summarize memory-augmented chat flow."}
    ]
  }'
```

## 1) Non-stream chat completion (JavaScript)
```js
const response = await fetch("http://localhost:8787/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.SAGE_API_KEY}`,
  },
  body: JSON.stringify({
    model: "gpt-5.2",
    conversation_id: "conv-demo-1",
    messages: [{ role: "user", content: "Summarize memory-augmented chat flow." }],
  }),
});

const data = await response.json();
console.log(data.choices?.[0]?.message?.content);
```

## 2) Streaming chat completion (`curl`)
```bash
curl -N http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $SAGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2",
    "conversation_id": "conv-demo-1",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Stream a short response."}
    ]
  }'
```

## 2) Streaming chat completion (JavaScript)
```js
const response = await fetch("http://localhost:8787/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.SAGE_API_KEY}`,
  },
  body: JSON.stringify({
    model: "gpt-5.2",
    conversation_id: "conv-demo-1",
    stream: true,
    messages: [{ role: "user", content: "Stream a short response." }],
  }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  process.stdout.write(decoder.decode(value, { stream: true }));
}
```

## 3) Tool-enabled completion (`curl`)
```bash
curl -sS http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $SAGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2",
    "conversation_id": "conv-demo-1",
    "messages": [
      {"role": "user", "content": "What memories do you have about coffee preferences?"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "web_search",
          "description": "Search with Brave",
          "parameters": {
            "type": "object",
            "properties": {
              "query": {"type": "string"},
              "max_tokens": {"type": "integer", "enum": [2048, 8192, 16384]}
            },
            "required": ["query"]
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "get_url_content",
          "parameters": {
            "type": "object",
            "properties": {
              "url": {"type": "string"},
              "result_id": {"type": "string"},
              "max_tokens": {"type": "integer", "enum": [2048, 8192, 16384]}
            }
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "read_document_chunk",
          "parameters": {
            "type": "object",
            "properties": {
              "document_id": {"type": "string"},
              "offset": {"type": "integer"},
              "max_tokens": {"type": "integer", "enum": [2048, 8192, 16384]}
            },
            "required": ["document_id", "offset"]
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "find_in_document",
          "parameters": {
            "type": "object",
            "properties": {
              "document_id": {"type": "string"},
              "query": {"type": "string"}
            },
            "required": ["document_id", "query"]
          }
        }
      }
    ],
    "tool_choice": "auto"
  }'
```

## 3) Tool-enabled completion (JavaScript)
```js
const response = await fetch("http://localhost:8787/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.SAGE_API_KEY}`,
  },
  body: JSON.stringify({
    model: "gpt-5.2",
    conversation_id: "conv-demo-1",
    messages: [{ role: "user", content: "Use get_memories for coffee preferences." }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_memories",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              top_k: { type: "integer" },
            },
            required: ["query"],
          },
        },
      },
    ],
    tool_choice: "auto",
  }),
});

const data = await response.json();
console.dir(data, { depth: null });
```
