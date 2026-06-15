// Local Ollama client — OpenAI-compatible /v1 for chat + embeddings, native /api
// for keep_alive pinning. Used at BUILD time for benchmark content generation and
// at CHECKPOINT time as the LoCoMo judge. Both are LOCAL + FREE: no billed tokens.
//
//   - chat()      -> POST /v1/chat/completions  (qwen3:14b content + judge)
//   - chatJson()  -> chat() + robust JSON extraction (qwen3 may emit <think>…)
//   - embed()     -> POST /v1/embeddings        (nomic-embed-text rank checks)
//   - warmup()    -> POST /api/generate with keep_alive so both models stay
//                    resident in 16 GB (no load-swap thrash during checkpoints)
//
// No third-party deps — reuses fetchJson (Node global fetch + AbortController).

import { fetchJson } from "./sage-client.js";

const DEFAULT_BASE = "http://127.0.0.1:11434";
const DEFAULT_GEN_MODEL = "qwen3:14b";
const DEFAULT_EMBED_MODEL = "nomic-embed-text";
const DEFAULT_KEEP_ALIVE = "30m";

// qwen3 is a "thinking" model; strip any reasoning block before parsing/returning.
function stripThink(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

// Best-effort JSON extraction: direct parse, then the first {...} / [...] span.
function extractJson(text) {
  const cleaned = stripThink(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through */
  }
  // Non-greedy: match the FIRST balanced-ish JSON span, not everything between the
  // first "{" and the last "}". Greedy matching turns `...{"a":1}...{"b":2}...` into
  // one invalid blob and fails even though a valid object exists earlier.
  const m = cleaned.match(/[{[][\s\S]*?[\]}]/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* give up */
    }
  }
  return null;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

class OllamaClient {
  constructor({
    baseUrl = DEFAULT_BASE,
    genModel = DEFAULT_GEN_MODEL,
    embedModel = DEFAULT_EMBED_MODEL,
    timeoutMs = 120000,
    keepAlive = DEFAULT_KEEP_ALIVE,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.genModel = genModel;
    this.embedModel = embedModel;
    this.timeoutMs = timeoutMs;
    this.keepAlive = keepAlive;
  }

  async listModels() {
    const res = await fetchJson(`${this.baseUrl}/api/tags`, { timeoutMs: 10000 });
    return (res?.models || []).map((m) => m.name);
  }

  // Pin models resident so the qwen3<->nomic swap never thrashes mid-run.
  // Embedding models can't serve /api/generate (400) — warm them via a tiny embed.
  async warmup(models = [this.genModel, this.embedModel]) {
    const out = {};
    for (const model of models) {
      try {
        if (model === this.embedModel) {
          await this.embed({ model, input: "warmup" });
        } else {
          await fetchJson(`${this.baseUrl}/api/generate`, {
            method: "POST",
            body: { model, prompt: "", keep_alive: this.keepAlive, stream: false },
            timeoutMs: this.timeoutMs,
          });
        }
        out[model] = true;
      } catch (error) {
        out[model] = `warmup failed: ${error.message}`;
      }
    }
    return out;
  }

  async chat({
    model = this.genModel,
    messages,
    temperature = 0,
    maxTokens,
    json = false,
    seed,
    timeoutMs = this.timeoutMs,
  }) {
    const body = {
      model,
      messages,
      stream: false,
      temperature,
      keep_alive: this.keepAlive,
    };
    if (maxTokens) body.max_tokens = maxTokens;
    if (json) body.response_format = { type: "json_object" };
    if (seed !== undefined) body.seed = seed;
    const res = await fetchJson(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      body,
      timeoutMs,
    });
    return stripThink(res?.choices?.[0]?.message?.content || "");
  }

  // chat() that returns parsed JSON ({ parsed, raw }); parsed is null on failure.
  async chatJson(opts) {
    const raw = await this.chat({ ...opts, json: true });
    return { parsed: extractJson(raw), raw };
  }

  async embed({ model = this.embedModel, input, timeoutMs = this.timeoutMs }) {
    const arr = Array.isArray(input) ? input : [input];
    const res = await fetchJson(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      body: { model, input: arr, keep_alive: this.keepAlive },
      timeoutMs,
    });
    const data = res?.data || [];
    return data.map((d) => d.embedding);
  }
}

export { OllamaClient, cosine, stripThink, extractJson };
