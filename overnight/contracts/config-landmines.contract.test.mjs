// Config landmines — documented, deterministic, no backend.
//
// Contract (these are the ACTUAL behaviours future experiments must design around):
//  - parsePositiveInteger rejects 0, so TTL=0 is REJECTED at config load. "Disable the
//    query cache" must be expressed as SAGE_REDIS_ENABLED=false, NOT TTL=0.
//  - The mnemosyne collection name defaults to the hardcoded "sage_mem_v2".
//  - Cache TTL defaults: identity 300s, query 120s.

import assert from "node:assert/strict";
import test from "node:test";

import { createConfig } from "../../src/config/env.js";

// Minimal valid env (createConfig requires OPENAI_API_KEY + SAGE_API_KEY; WEB_SEARCH off
// avoids the conditional BRAVE_API_KEY requirement). Passing an explicit env object means
// process.env / .env.local are not consulted.
function baseEnv(overrides = {}) {
  return {
    OPENAI_API_KEY: "test-openai-key",
    SAGE_API_KEY: "test-sage-key",
    WEB_SEARCH_ENABLED: "false",
    ...overrides,
  };
}

test("default config loads with hardcoded collection name and cache TTL defaults", () => {
  const config = createConfig(baseEnv());
  assert.equal(config.memory.mnemosyne.collectionName, "sage_mem_v2", "hardcoded default collection");
  assert.equal(config.memory.queryCacheTtlSec, 120, "query cache TTL default");
  assert.equal(config.memory.identityCacheTtlSec, 300, "identity cache TTL default");
});

test("landmine: SAGE_MEMORY_QUERY_CACHE_TTL_SEC=0 is REJECTED (cannot disable cache via TTL=0)", () => {
  assert.throws(
    () => createConfig(baseEnv({ SAGE_MEMORY_QUERY_CACHE_TTL_SEC: "0" })),
    /SAGE_MEMORY_QUERY_CACHE_TTL_SEC/,
    "TTL=0 must be rejected by parsePositiveInteger"
  );
});

test("landmine: SAGE_MEMORY_IDENTITY_CACHE_TTL_SEC=0 is REJECTED", () => {
  assert.throws(
    () => createConfig(baseEnv({ SAGE_MEMORY_IDENTITY_CACHE_TTL_SEC: "0" })),
    /SAGE_MEMORY_IDENTITY_CACHE_TTL_SEC/
  );
});

test("the supported way to disable the query cache is SAGE_REDIS_ENABLED=false", () => {
  const config = createConfig(baseEnv({ SAGE_REDIS_ENABLED: "false" }));
  assert.equal(config.memory.redisEnabled, false, "redis disabled -> controller short-circuits the cache");
});
