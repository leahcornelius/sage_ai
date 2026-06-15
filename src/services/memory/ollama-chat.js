// Minimal local-LLM chat client (Ollama, OpenAI-compatible endpoint) for the Sage
// clean-fact extraction path (Experiment 5). Production-side mirror of the harness
// client `overnight/harness/lib/ollama.js`; no third-party deps (Node 24 fetch).
//
// Used by local-extractor-adapter.js to turn a conversation turn into distinct
// atomic facts with a local model (qwen3:14b) — a $0, local replacement for the
// dead cloud-mem0 extraction path. Temperature 0 + fixed seed for determinism;
// qwen3 is a thinking model, so we suppress thinking (/no_think) and strip any
// <think> block defensively.

// Remove qwen3 <think>…</think> reasoning blocks if the model emits them anyway.
function stripThink(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "") // unterminated think block
    .trim();
}

// Robustly extract a JSON object/array from model output (handles stray prose).
function extractJson(text) {
  const t = stripThink(text);
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const start = t.search(/[[{]/);
  if (start === -1) return null;
  // Try the largest balanced-looking slice first, then shrink.
  for (let end = t.length; end > start; end--) {
    const slice = t.slice(start, end);
    const last = slice[slice.length - 1];
    if (last !== "}" && last !== "]") continue;
    try {
      return JSON.parse(slice);
    } catch {
      /* keep shrinking */
    }
  }
  return null;
}

async function postJson(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`POST ${url} -> ${res.status} ${text.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function createOllamaChat({
  baseUrl = "http://127.0.0.1:11434",
  model = "qwen3:14b",
  temperature = 0,
  seed = 7,
  keepAlive = "30m",
  timeoutMs = 30000,
} = {}) {
  const base = String(baseUrl).replace(/\/$/, "");

  // Returns { parsed, raw }. `parsed` is null if no JSON could be extracted.
  async function chatJson({ system, user, maxTokens, timeoutMs: t = timeoutMs }) {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: user });
    const body = {
      model,
      messages,
      stream: false,
      temperature,
      keep_alive: keepAlive,
      response_format: { type: "json_object" },
    };
    if (seed !== undefined && seed !== null) body.seed = seed;
    if (maxTokens) body.max_tokens = maxTokens;
    const res = await postJson(`${base}/v1/chat/completions`, body, t);
    const raw = res?.choices?.[0]?.message?.content || "";
    return { parsed: extractJson(raw), raw };
  }

  async function ping(timeoutMs2 = 5000) {
    // Cheap reachability check against the Ollama tags endpoint.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs2);
    try {
      const res = await fetch(`${base}/api/tags`, { signal: controller.signal });
      return res.ok ? "OK" : "ERROR";
    } finally {
      clearTimeout(timer);
    }
  }

  return { chatJson, ping, model, baseUrl: base };
}

export { createOllamaChat, stripThink, extractJson };
