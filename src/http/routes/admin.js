import { AppError } from "../../errors/app-error.js";
import { createAuthHook } from "../hooks/auth.js";
import { countTokens } from "../../services/memory/context-merge.js";

/**
 * Guarded, localhost-only admin routes used ONLY by the overnight retrieval
 * benchmark harness. These are additive and never registered unless
 * `config.admin.enabled` (SAGE_ADMIN_ENABLED=true). They do not change behaviour
 * for normal traffic.
 *
 *   POST /admin/ingest         generation-free memory write (no model call)
 *   POST /admin/memory-config  mutate live read-side knobs in place (+ flush cache)
 *   POST /admin/retrieve       run retrieveContext, return buckets + post-trim block
 *
 * Hardening: bearer-authed (existing auth), localhost-bound + loopback guard,
 * mutations are logged (keys + values, never secrets).
 */

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// /admin/memory-config may ONLY mutate these read-side knobs. The retrieval time
// budget is intentionally NOT here: it is fixed at launch via env and the window
// is cached at controller init, so the loop can never tune it down.
const ALLOWED_CONFIG_KEYS = new Set([
  "semanticTopK",
  "episodicTopK",
  "graphMaxResults",
  "contextMaxTokens",
  // Boolean knob (coerced below): restrict semantic recall to the requesting
  // scope. Loop-toggleable so the harness can A/B scoped vs unscoped recall.
  "scopeFilter",
]);

// scopeFilter is a boolean; every other allowed key is a non-negative integer.
const BOOLEAN_CONFIG_KEYS = new Set(["scopeFilter"]);

function badRequest(message) {
  return new AppError({
    statusCode: 400,
    code: "invalid_request_error",
    type: "invalid_request_error",
    message,
  });
}

async function registerAdminRoutes(app) {
  const config = app.sageConfig;
  const authHook = createAuthHook(config);

  // Loopback guard (defense in depth on top of SAGE_HOST=127.0.0.1 binding).
  app.addHook("onRequest", async (request) => {
    const ip = request.ip || request.socket?.remoteAddress || "";
    if (!LOOPBACK.has(ip)) {
      throw new AppError({
        statusCode: 403,
        code: "admin_forbidden",
        type: "invalid_request_error",
        message: "Admin routes are localhost-only.",
      });
    }
  });
  // Reuse the existing bearer auth.
  app.addHook("onRequest", authHook);

  function resolveModelId(body) {
    if (typeof body.model === "string" && body.model.trim()) {
      return body.model.trim();
    }
    return config.openai.defaultModel || "gpt-4o-mini";
  }

  // ---- POST /admin/ingest -------------------------------------------------
  app.post("/admin/ingest", async (request) => {
    const body = request.body || {};
    const scope = typeof body.scope === "string" ? body.scope.trim() : "";
    const text = typeof body.text === "string" ? body.text : "";
    if (!scope) {
      throw badRequest("admin/ingest requires a non-empty 'scope'.");
    }
    if (!text || !text.trim()) {
      throw badRequest("admin/ingest requires non-empty 'text'.");
    }
    const conversationId =
      typeof body.conversationId === "string" && body.conversationId.trim()
        ? body.conversationId.trim()
        : scope;
    const turnIndex = Number.isInteger(body.turnIndex) ? body.turnIndex : 0;

    // Passing user=scope makes the effective scopeKey exactly `scope`
    // (resolveScopeKey prefers a non-empty user). role:"user", no model call.
    const result = await app.sageServices.memoryService.processMessage({
      conversationId,
      user: scope,
      role: "user",
      turnIndex,
      messageText: text,
      modelId: resolveModelId(body),
      requestId: request.id,
      logger: request.log,
    });

    return { ok: true, scope, conversationId, turnIndex, result };
  });

  function effectiveMemoryConfig() {
    return {
      semanticTopK: config.memory.semanticTopK,
      episodicTopK: config.memory.episodicTopK,
      graphMaxResults: config.memory.graphMaxResults,
      contextMaxTokens: config.memory.contextMaxTokens,
      scopeFilter: Boolean(config.memory.scopeFilter),
    };
  }

  // ---- GET /admin/memory-config (read-only snapshot of the live knobs) -----
  app.get("/admin/memory-config", async () => {
    return { ok: true, effective: effectiveMemoryConfig() };
  });

  // ---- POST /admin/memory-config -----------------------------------------
  app.post("/admin/memory-config", async (request) => {
    const body = request.body || {};
    const updates =
      body.config && typeof body.config === "object" ? body.config : body;

    const keys = Object.keys(updates).filter(
      (k) => k !== "config" && k !== "model"
    );
    const unknown = keys.filter((k) => !ALLOWED_CONFIG_KEYS.has(k));
    if (unknown.length > 0) {
      throw badRequest(
        `Unknown/forbidden memory-config keys: ${unknown.join(", ")}. ` +
          `Allowed: ${[...ALLOWED_CONFIG_KEYS].join(", ")}.`
      );
    }
    if (keys.length === 0) {
      throw badRequest(
        `No allowed memory-config keys provided. Allowed: ${[...ALLOWED_CONFIG_KEYS].join(", ")}.`
      );
    }

    const applied = {};
    for (const key of keys) {
      const rawValue = updates[key];
      let value;
      if (BOOLEAN_CONFIG_KEYS.has(key)) {
        // Coerce a boolean knob: accept true/false or 1/0 (the loop sends 0/1).
        if (typeof rawValue === "boolean") {
          value = rawValue;
        } else if (rawValue === 1 || rawValue === 0) {
          value = rawValue === 1;
        } else {
          throw badRequest(
            `memory-config '${key}' must be a boolean (true/false or 1/0).`
          );
        }
      } else {
        if (!Number.isInteger(rawValue) || rawValue < 0) {
          throw badRequest(`memory-config '${key}' must be a non-negative integer.`);
        }
        value = rawValue;
      }
      // Live, in-place mutation of the shared config object: the next retrieval
      // request reads the new value off config.memory.* with no restart.
      config.memory[key] = value;
      applied[key] = value;
    }

    // Defensively flush the query-context cache so a stale cached block can never
    // mask a config change (belt-and-suspenders; the bench instance disables the
    // cache anyway via SAGE_REDIS_ENABLED=false + TTL=0).
    let cacheFlushed = false;
    try {
      if (typeof app.sageServices.memoryService.flushQueryCache === "function") {
        await app.sageServices.memoryService.flushQueryCache();
        cacheFlushed = true;
      }
    } catch (error) {
      request.log.warn({ err: error }, "admin/memory-config cache flush failed");
    }

    request.log.info(
      { adminMemoryConfigApplied: applied, cacheFlushed },
      "Applied admin memory-config mutation"
    );

    return {
      ok: true,
      applied,
      cacheFlushed,
      effective: effectiveMemoryConfig(),
    };
  });

  // ---- POST /admin/retrieve ----------------------------------------------
  app.post("/admin/retrieve", async (request) => {
    const body = request.body || {};
    const query = typeof body.query === "string" ? body.query : "";
    const scope = typeof body.scope === "string" ? body.scope.trim() : "";
    if (!query || !query.trim()) {
      throw badRequest("admin/retrieve requires a non-empty 'query'.");
    }
    if (!scope) {
      throw badRequest("admin/retrieve requires a non-empty 'scope'.");
    }
    const modelId = resolveModelId(body);

    const result = await app.sageServices.memoryService.retrieveContext({
      conversationId: scope,
      user: scope,
      query,
      modelId,
      requestId: request.id,
      logger: request.log,
    });

    // Score against what the model would actually see: the post-trim block.
    // Use the SAME countTokens + modelId the trim used so the count matches.
    const contextBlock = result.contextBlock || "";
    const contextTokenCount = countTokens(contextBlock, modelId);

    return {
      semanticMemories: result.semanticMemories || [],
      episodicSummaries: result.episodicSummaries || [],
      graphMemories: result.graphMemories || [],
      identityMemories: result.identityMemories || [],
      contextBlock,
      contextTokenCount,
      partial: Boolean(result.partial),
      cacheHit: Boolean(result.cacheHit),
      coldStart: Boolean(result.coldStart),
      budgetExceeded: Boolean(result.budgetExceeded),
    };
  });
}

export { registerAdminRoutes };
