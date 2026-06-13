// HTTP client for the Sage OpenAI-compatible server.

const PASSTHROUGH_FIELDS = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "reasoning_effort",
  "reasoning",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "user",
];

class SageError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = "SageError";
    this.code = code || null;
    this.status = status || null;
  }
}

function authHeaders(settings) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiKey}`,
    "X-OpenWebUI-Chat-Id": settings.chatId,
  };
}

function buildBody(settings) {
  const body = {
    messages: settings.messages,
    stream: settings.stream,
  };
  if (settings.model) {
    body.model = settings.model;
  }
  for (const field of PASSTHROUGH_FIELDS) {
    if (settings.params[field] !== undefined) {
      body[field] = settings.params[field];
    }
  }
  if (settings.toolChoice !== null && settings.toolChoice !== undefined) {
    body.tool_choice = settings.toolChoice;
  }
  if (Array.isArray(settings.customTools) && settings.customTools.length > 0) {
    body.tools = settings.customTools;
  }
  if (settings.stream) {
    body.stream_options = { include_usage: true };
  }
  return body;
}

async function parseError(response) {
  let code = null;
  let message = `HTTP ${response.status}`;
  try {
    const payload = await response.json();
    if (payload?.error) {
      code = payload.error.code || payload.error.type || null;
      message = payload.error.message || message;
    }
  } catch {
    // Non-JSON error body; keep the default message.
  }
  return new SageError(message, { code, status: response.status });
}

function wrapNetworkError(error, baseUrl) {
  if (error.name === "AbortError") {
    return error;
  }
  const cause = error.cause?.code || error.code;
  if (cause === "ECONNREFUSED" || cause === "ENOTFOUND" || cause === "ECONNRESET") {
    return new SageError(`Sage not reachable at ${baseUrl} — is it running?`, { code: cause });
  }
  return error;
}

async function health(settings) {
  const response = await fetch(`${settings.baseUrl}/health`).catch((error) => {
    throw wrapNetworkError(error, settings.baseUrl);
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return response.json();
}

async function listModels(settings) {
  const response = await fetch(`${settings.baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${settings.apiKey}` },
  }).catch((error) => {
    throw wrapNetworkError(error, settings.baseUrl);
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function chat(settings, signal) {
  const response = await fetch(`${settings.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(settings),
    body: JSON.stringify(buildBody({ ...settings, stream: false })),
    signal,
  }).catch((error) => {
    throw wrapNetworkError(error, settings.baseUrl);
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  const payload = await response.json();
  const choice = payload?.choices?.[0];
  return {
    content: choice?.message?.content ?? "",
    model: payload?.model || settings.model || null,
    usage: payload?.usage || null,
  };
}

// Streams the reply, invoking onDelta(text) for each content fragment.
async function streamChat(settings, signal, onDelta) {
  const response = await fetch(`${settings.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(settings),
    body: JSON.stringify(buildBody({ ...settings, stream: true })),
    signal,
  }).catch((error) => {
    throw wrapNetworkError(error, settings.baseUrl);
  });
  if (!response.ok) {
    throw await parseError(response);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let model = settings.model || null;
  let usage = null;

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of rawEvent.split("\n")) {
        if (!line.startsWith("data:")) {
          continue;
        }
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          continue;
        }
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.model) {
          model = json.model;
        }
        if (json.usage) {
          usage = json.usage;
        }
        const delta = json.choices?.[0]?.delta;
        if (delta?.role === "tool") {
          continue;
        }
        if (typeof delta?.content === "string" && delta.content.length > 0) {
          content += delta.content;
          onDelta(delta.content);
        }
      }
    }
  }

  return { content, model, usage };
}

export { health, listModels, chat, streamChat, buildBody, SageError, PASSTHROUGH_FIELDS };
