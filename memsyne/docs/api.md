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

### Tool-related fields
- `tools`: array of function tool definitions
- `tool_choice`: one of `none`, `auto`, `required`, or `{ "type": "function", "function": { "name": "..." } }`

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

### Tool + stream fallback behavior
If you send `tools` with `stream: true`, Sage currently executes through a non-stream completion path first, then emits a synthetic chunk stream:
- First chunk contains full assistant text in one delta.
- Final chunk contains `finish_reason: "stop"` (and usage when available).
- This is not token-by-token incremental streaming in that mode.

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
    "messages": [
      {"role": "user", "content": "What memories do you have about coffee preferences?"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_memories",
          "description": "Retrieve relevant long-term memories",
          "parameters": {
            "type": "object",
            "properties": {
              "query": {"type": "string"},
              "top_k": {"type": "integer"}
            },
            "required": ["query"]
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