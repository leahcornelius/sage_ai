// Thin HTTP clients for the benchmark Sage instance and the (isolated) Qdrant.
// No third-party deps — Node 24 global fetch + AbortController.

class HttpError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    if (cause) this.cause = cause;
  }
}

async function fetchJson(url, { method = "GET", headers = {}, body, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    if (!res.ok) {
      throw new HttpError(`${method} ${url} -> ${res.status}`, { status: res.status, body: json });
    }
    return json;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(`${method} ${url} failed: ${error.message}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

class SageClient {
  constructor({ baseUrl, apiKey, model = "gpt-4o-mini", timeoutMs = 45000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model; // model used for retrieval token-counting (stable encoder)
    this.timeoutMs = timeoutMs;
  }

  get _authHeaders() {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  async health() {
    return fetchJson(`${this.baseUrl}/health`, { timeoutMs: this.timeoutMs });
  }

  async adminIngest({ scope, text, conversationId, turnIndex, model }) {
    return fetchJson(`${this.baseUrl}/admin/ingest`, {
      method: "POST",
      headers: this._authHeaders,
      body: { scope, text, conversationId, turnIndex, model: model || this.model },
      timeoutMs: this.timeoutMs,
    });
  }

  async adminMemoryConfig(patch) {
    return fetchJson(`${this.baseUrl}/admin/memory-config`, {
      method: "POST",
      headers: this._authHeaders,
      body: patch,
      timeoutMs: this.timeoutMs,
    });
  }

  async adminRetrieve({ query, scope, model }) {
    return fetchJson(`${this.baseUrl}/admin/retrieve`, {
      method: "POST",
      headers: this._authHeaders,
      body: { query, scope, model: model || this.model },
      timeoutMs: this.timeoutMs,
    });
  }

  // Used ONLY by the capped checkpoint. Real upstream model call.
  async chatCompletion({ model, messages, chatId, timeoutMs = 60000 }) {
    return fetchJson(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { ...this._authHeaders, "x-openwebui-chat-id": chatId },
      body: { model, messages, stream: false },
      timeoutMs,
    });
  }
}

class QdrantClient {
  constructor({ url, timeoutMs = 10000 }) {
    this.url = url.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async listCollections() {
    const res = await fetchJson(`${this.url}/collections`, { timeoutMs: this.timeoutMs });
    const list = res?.result?.collections || [];
    return list.map((c) => c.name);
  }

  async hasCollection(name) {
    const names = await this.listCollections();
    return names.includes(name);
  }

  async pointCount(name) {
    try {
      const res = await fetchJson(`${this.url}/collections/${name}`, { timeoutMs: this.timeoutMs });
      const r = res?.result || {};
      return r.points_count ?? r.vectors_count ?? 0;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }
}

export { SageClient, QdrantClient, HttpError, fetchJson };
