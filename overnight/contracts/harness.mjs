// Experiment 4 — shared contract-test harness.
//
// Builds an ISOLATED mnemosy-ai client (separate, freshly-named throwaway
// collections; never the dev `sage_mem_v2` / `memory_private` / `agent_profiles` /
// `skill_library`) and exposes deterministic helpers for the contract tests:
//   - buildIsolatedClient() / buildIsolatedAdapter()  -> a real mnemosy-ai client +
//     Sage memory adapter wired to it, Redis/Falkor-free.
//   - Qdrant HTTP helpers (countLive/countDeleted/scrollPoints/dropCollections) so a
//     test can inspect LIVE (deleted=false) vs soft-deleted points and read
//     metadata.scopeKey directly (mnemosy-ai's db.count counts all points incl.
//     soft-deleted; soft-delete is a payload flag, so live counting needs a filter).
//   - preflight() -> pings Qdrant + Ollama so integration tests skip gracefully when
//     the backends are down (keeps the default `npm test` green on a box without Docker).
//
// Isolation guard: EVERY collection this harness creates must start with
// `sage_contract_` (an allowlist). That categorically excludes every dev/real
// collection, so a contract run can never touch local dev memories — even if pointed
// at the dev Qdrant by mistake.
//
// No model/checkpoint calls. Embeddings use local Ollama (nomic-embed-text); the same
// input yields the same vector, so the suite is deterministic.

import { randomUUID } from "node:crypto";

import pino from "pino";
import { createMnemosyne } from "mnemosy-ai";

import { createMnemosyneAdapter } from "../../src/services/memory/mnemosyne-adapter.js";

const COLLECTION_PREFIX = "sage_contract_";

// Default to the ISOLATED bench Qdrant (:6344), never the dev :6333 that holds the
// real sage_mem_v2. Override via env if your isolated Qdrant lives elsewhere.
const QDRANT_URL = process.env.SAGE_CONTRACT_QDRANT_URL || "http://127.0.0.1:6344";
const EMBEDDING_URL =
  process.env.SAGE_CONTRACT_EMBEDDING_URL || "http://127.0.0.1:11434/v1/embeddings";
const EMBEDDING_MODEL = process.env.SAGE_CONTRACT_EMBEDDING_MODEL || "nomic-embed-text";

const silentLogger = pino({ level: "silent" });

function assertContractCollection(name) {
  if (typeof name !== "string" || !name.startsWith(COLLECTION_PREFIX)) {
    throw new Error(
      `Isolation guard: refusing to operate on collection "${name}" — contract tests ` +
        `may only touch collections starting with "${COLLECTION_PREFIX}".`
    );
  }
  return name;
}

function uniqueCollectionNames() {
  // Math.random/Date.now are fine in test code (unlike workflow scripts). One unique
  // id per built client so concurrent test files never collide.
  const id = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  return {
    shared: assertContractCollection(`${COLLECTION_PREFIX}${id}_shared`),
    private: assertContractCollection(`${COLLECTION_PREFIX}${id}_private`),
    profiles: assertContractCollection(`${COLLECTION_PREFIX}${id}_profiles`),
    skills: assertContractCollection(`${COLLECTION_PREFIX}${id}_skills`),
  };
}

async function qdrantRequest(path, options = {}) {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Qdrant ${options.method || "GET"} ${path}: ${res.status} ${body}`);
  }
  return res;
}

// Count points matching deleted=<deleted> (exact). Live = deleted:false.
async function countByDeleted(collection, deleted) {
  assertContractCollection(collection);
  const res = await qdrantRequest(`/collections/${collection}/points/count`, {
    method: "POST",
    body: JSON.stringify({
      exact: true,
      filter: { must: [{ key: "deleted", match: { value: deleted } }] },
    }),
  });
  const data = await res.json();
  return data.result.count;
}

async function countLive(collection) {
  return countByDeleted(collection, false);
}

async function countDeleted(collection) {
  return countByDeleted(collection, true);
}

// Scroll all points (optionally only live ones). Returns the raw Qdrant points with
// payloads so a test can read payload.text, payload.deleted, payload.metadata.scopeKey.
async function scrollPoints(collection, { liveOnly = false, limit = 1000 } = {}) {
  assertContractCollection(collection);
  const body = {
    limit,
    with_payload: true,
    with_vector: false,
  };
  if (liveOnly) {
    body.filter = { must: [{ key: "deleted", match: { value: false } }] };
  }
  const res = await qdrantRequest(`/collections/${collection}/points/scroll`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.result.points || [];
}

// Live scopeKeys seen on points in the collection (from payload.metadata.scopeKey).
async function liveScopeKeys(collection) {
  const points = await scrollPoints(collection, { liveOnly: true });
  return points.map((p) => p?.payload?.metadata?.scopeKey ?? null);
}

async function dropCollections(collections) {
  for (const name of Object.values(collections)) {
    assertContractCollection(name);
    try {
      await fetch(`${QDRANT_URL}/collections/${name}`, { method: "DELETE" });
    } catch {
      /* best-effort teardown */
    }
  }
}

// Build a real mnemosy-ai client against isolated collections. Redis/Falkor stay OFF
// (graphUrl/redisUrl default to "" in resolveConfig when omitted), so the only
// backends touched are Qdrant + Ollama.
async function buildIsolatedClient() {
  const collections = uniqueCollectionNames();
  const client = await createMnemosyne({
    vectorDbUrl: QDRANT_URL,
    embeddingUrl: EMBEDDING_URL,
    agentId: `contract-${randomUUID().slice(0, 6)}`,
    embeddingModel: EMBEDDING_MODEL,
    collections, // fully isolates shared/private/profiles/skills
  });
  return { client, collections, sharedCollection: collections.shared };
}

// A minimal Sage-style config for createMnemosyneAdapter. The adapter only reads
// config.memory.mode (for `enabled`) and — pre-fix — config.memory.episodicRawStore.
function makeMemoryConfig(overrides = {}) {
  return {
    memory: {
      mode: "soft",
      episodicRawStore: false,
      ...overrides,
    },
  };
}

// Build the Sage memory adapter wired to a fresh isolated client.
async function buildIsolatedAdapter(configOverrides = {}) {
  const { client, collections, sharedCollection } = await buildIsolatedClient();
  const adapter = createMnemosyneAdapter({
    mnemosyneClient: client,
    config: makeMemoryConfig(configOverrides),
    logger: silentLogger,
  });
  return { adapter, client, collections, sharedCollection };
}

// Ping Qdrant + Ollama. Returns { ok, reason }. Integration tests use this to skip
// gracefully when the backends are not running.
async function preflight() {
  try {
    const q = await fetch(`${QDRANT_URL}/collections`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!q.ok) return { ok: false, reason: `Qdrant ${QDRANT_URL} -> ${q.status}` };
  } catch (error) {
    return { ok: false, reason: `Qdrant ${QDRANT_URL} unreachable: ${error.message}` };
  }
  try {
    // Embed a token to confirm Ollama + the model are actually usable.
    const e = await fetch(EMBEDDING_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: "ping" }),
      signal: AbortSignal.timeout(15000),
    });
    if (!e.ok) return { ok: false, reason: `Ollama ${EMBEDDING_URL} -> ${e.status}` };
  } catch (error) {
    return { ok: false, reason: `Ollama ${EMBEDDING_URL} unreachable: ${error.message}` };
  }
  return { ok: true, reason: "" };
}

let _preflight = null;
async function preflightOnce() {
  if (!_preflight) _preflight = await preflight();
  return _preflight;
}

export {
  COLLECTION_PREFIX,
  QDRANT_URL,
  EMBEDDING_URL,
  EMBEDDING_MODEL,
  silentLogger,
  assertContractCollection,
  buildIsolatedClient,
  buildIsolatedAdapter,
  makeMemoryConfig,
  countLive,
  countDeleted,
  scrollPoints,
  liveScopeKeys,
  dropCollections,
  qdrantRequest,
  preflight,
  preflightOnce,
};
