import { AppError } from "../errors/app-error.js";

/**
 * The model service keeps a short-lived cache of upstream OpenAI model metadata.
 * That lets Open WebUI discover available models without hammering OpenAI on
 * every request and gives us a stale fallback when refreshes fail.
 */
function createModelService({ openaiClient, config, logger }) {
  const serviceLogger = logger.child({ service: "model-service" });
  let cache = {
    models: null,
    fetchedAt: 0,
  };

  async function listModels({ logger: requestLogger, forceRefresh = false } = {}) {
    const operationLogger = requestLogger || serviceLogger;
    const cacheAgeMs = Date.now() - cache.fetchedAt;
    if (!forceRefresh && cache.models && cacheAgeMs < config.openai.modelCacheTtlMs) {
      const filteredModels = filterModels(cache.models, config.openai.modelAllowlist);
      operationLogger.debug(
        {
          cacheAgeMs,
          forceRefresh,
          cachedModelCount: cache.models.length,
          filteredModelCount: filteredModels.length,
        },
        "Serving models from cache"
      );
      return filteredModels;
    }

    try {
      const response = await openaiClient.models.list();
      cache = {
        models: Array.isArray(response?.data) ? response.data : [],
        fetchedAt: Date.now(),
      };

      operationLogger.info(
        { modelCount: cache.models.length, cacheAgeMs: 0 },
        "Refreshed upstream model cache"
      );

      return filterModels(cache.models, config.openai.modelAllowlist);
    } catch (error) {
      if (cache.models) {
        operationLogger.warn(
          {
            err: error,
            staleModelCount: cache.models.length,
            cacheAgeMs,
          },
          "Falling back to stale model cache after upstream model refresh failed"
        );
        return filterModels(cache.models, config.openai.modelAllowlist);
      }

      throw new AppError({
        statusCode: 502,
        code: "upstream_error",
        type: "server_error",
        message: "Failed to fetch models from the upstream OpenAI API.",
        cause: error,
      });
    }
  }

  async function assertModelAvailable(modelId, { logger: requestLogger } = {}) {
    const operationLogger = requestLogger || serviceLogger;
    operationLogger.debug(
      {
        modelId,
        hasAllowlist: Boolean(config.openai.modelAllowlist),
      },
      "Validating requested model availability"
    );
    if (config.openai.modelAllowlist && !config.openai.modelAllowlist.includes(modelId)) {
      throw createModelNotFoundError(modelId);
    }

    const cacheAgeMs = Date.now() - cache.fetchedAt;
    const willRefreshCache =
      !cache.models || cacheAgeMs >= config.openai.modelCacheTtlMs;
    const models = await listModels({ logger: operationLogger });
    operationLogger.debug(
      {
        modelId,
        hasAllowlist: Boolean(config.openai.modelAllowlist),
        cacheRefreshTriggered: willRefreshCache,
        availableModelCount: models.length,
      },
      "Checked model list for requested model"
    );
    const isAvailable = models.some((model) => model.id === modelId);
    if (!isAvailable) {
      throw createModelNotFoundError(modelId);
    }
  }

  return {
    listModels,
    assertModelAvailable,
  };
}

function filterModels(models, allowlist) {
  if (!allowlist) {
    return models;
  }

  const allowed = new Set(allowlist);
  return models.filter((model) => allowed.has(model.id));
}

function createModelNotFoundError(modelId) {
  return new AppError({
    statusCode: 404,
    code: "model_not_found",
    type: "invalid_request_error",
    message: `The model \"${modelId}\" does not exist or is not available to this server.`,
  });
}

export { createModelService };
