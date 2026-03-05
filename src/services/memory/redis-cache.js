import crypto from "node:crypto";

import Redis from "ioredis";

function createRedisCache({ config, logger }) {
  const cacheLogger = logger.child({ component: "redis-cache" });
  const enabled = config.memory.redisEnabled !== false && config.memory.mode !== "off";
  const url = config.memory.redisUrl;
  const prefix = "sage:memory";
  const inMemory = new Map();
  let redis = null;

  if (enabled) {
    redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
  }

  function createKey(parts) {
    return `${prefix}:${parts.join(":")}`;
  }

  function createQueryDigest(scopeKey, normalizedQuery) {
    return crypto
      .createHash("sha256")
      .update(`${scopeKey}|${normalizedQuery}`)
      .digest("hex");
  }

  function getIdentityKey(scopeKey) {
    return createKey(["identity", scopeKey]);
  }

  function getQueryKey(scopeKey, normalizedQuery) {
    const digest = createQueryDigest(scopeKey, normalizedQuery);
    return createKey(["query", scopeKey, digest]);
  }

  function getQueryIndexKey(scopeKey) {
    return createKey(["query-index", scopeKey]);
  }

  async function connect() {
    if (!redis) {
      return;
    }
    if (redis.status === "ready" || redis.status === "connecting") {
      return;
    }
    await redis.connect();
  }

  async function setJson(key, value, ttlSeconds) {
    const payload = JSON.stringify(value);
    if (!redis) {
      inMemory.set(key, {
        value: payload,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      return;
    }
    await connect();
    await redis.set(key, payload, "EX", ttlSeconds);
  }

  async function getJson(key) {
    if (!redis) {
      const entry = inMemory.get(key);
      if (!entry) {
        return null;
      }
      if (Date.now() >= entry.expiresAt) {
        inMemory.delete(key);
        return null;
      }
      return JSON.parse(entry.value);
    }
    await connect();
    const payload = await redis.get(key);
    if (!payload) {
      return null;
    }
    return JSON.parse(payload);
  }

  async function getIdentityContext(scopeKey) {
    return getJson(getIdentityKey(scopeKey));
  }

  async function setIdentityContext(scopeKey, value) {
    await setJson(getIdentityKey(scopeKey), value, config.memory.identityCacheTtlSec);
  }

  async function getQueryContext(scopeKey, normalizedQuery) {
    return getJson(getQueryKey(scopeKey, normalizedQuery));
  }

  async function setQueryContext(scopeKey, normalizedQuery, value) {
    const queryKey = getQueryKey(scopeKey, normalizedQuery);
    await setJson(queryKey, value, config.memory.queryCacheTtlSec);

    const indexKey = getQueryIndexKey(scopeKey);
    if (!redis) {
      const entry = inMemory.get(indexKey);
      const known = entry ? new Set(JSON.parse(entry.value)) : new Set();
      known.add(queryKey);
      inMemory.set(indexKey, {
        value: JSON.stringify(Array.from(known)),
        expiresAt: Date.now() + config.memory.queryCacheTtlSec * 1000,
      });
      return;
    }
    await connect();
    await redis.sadd(indexKey, queryKey);
    await redis.expire(indexKey, config.memory.queryCacheTtlSec);
  }

  async function invalidateScope(scopeKey) {
    const indexKey = getQueryIndexKey(scopeKey);
    const identityKey = getIdentityKey(scopeKey);

    if (!redis) {
      inMemory.delete(identityKey);
      const entry = inMemory.get(indexKey);
      if (entry) {
        const known = JSON.parse(entry.value);
        for (const queryKey of known) {
          inMemory.delete(queryKey);
        }
      }
      inMemory.delete(indexKey);
      return;
    }

    await connect();
    const queryKeys = await redis.smembers(indexKey);
    const keys = [identityKey, indexKey, ...queryKeys];
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  async function ping() {
    if (!redis) {
      return "PONG";
    }
    await connect();
    return redis.ping();
  }

  async function close() {
    if (!redis) {
      return;
    }
    try {
      await redis.quit();
    } catch (error) {
      cacheLogger.debug({ err: error }, "Redis quit failed, disconnecting forcefully");
      redis.disconnect(false);
    }
  }

  return {
    enabled,
    getIdentityContext,
    setIdentityContext,
    getQueryContext,
    setQueryContext,
    invalidateScope,
    ping,
    close,
  };
}

export { createRedisCache };
