import { config as loadDotEnv } from "dotenv";
import path from "node:path";

import { AppError } from "../errors/app-error.js";

loadDotEnv({
  path: path.resolve(process.cwd(), ".env.local"),
  override: false,
  quiet: true,
});

/**
 * Reads environment variables once and converts them into a validated config
 * object so the rest of the app can avoid direct process.env access.
 */
function createConfig(env = process.env) {
  const logPrettyDefault = Boolean(process.stdout.isTTY);
  const hasLegacyLogLevel = optionalString(env.SAGE_LOG_LEVEL) !== null;
  const legacyLogLevel = parseLogLevel(optionalString(env.SAGE_LOG_LEVEL) || "info", "SAGE_LOG_LEVEL");
  const hasConsoleLevel = optionalString(env.SAGE_LOG_CONSOLE_LEVEL) !== null;
  const hasFileLevel = optionalString(env.SAGE_LOG_FILE_LEVEL) !== null;
  const consoleLevel = parseLogLevel(
    optionalString(env.SAGE_LOG_CONSOLE_LEVEL) || legacyLogLevel,
    "SAGE_LOG_CONSOLE_LEVEL"
  );
  const fileLevel = parseLogLevel(
    optionalString(env.SAGE_LOG_FILE_LEVEL) ||
      (hasLegacyLogLevel || hasConsoleLevel || hasFileLevel ? legacyLogLevel : "debug"),
    "SAGE_LOG_FILE_LEVEL"
  );
  const webEnabled = parseBoolean(env.WEB_SEARCH_ENABLED, true);
  const defaultModel = optionalString(env.SAGE_DEFAULT_MODEL);
  const allowModelOverride = parseBoolean(env.SAGE_ALLOW_MODEL_OVERRIDE, true);
  const memoryMode = parseEnum(
    optionalString(env.SAGE_MEMORY_MODE) || "hard",
    ["hard", "soft", "off"],
    "SAGE_MEMORY_MODE"
  );
  if (!allowModelOverride && !defaultModel) {
    throw new AppError({
      statusCode: 500,
      code: "config_error",
      type: "server_error",
      message: "SAGE_DEFAULT_MODEL is required when SAGE_ALLOW_MODEL_OVERRIDE is false.",
    });
  }

  return {
    openai: {
      apiKey: requireString(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
      baseUrl: optionalString(env.OPENAI_BASE_URL),
      defaultModel,
      allowModelOverride,
      modelAllowlist: parseCsvList(env.SAGE_OPENAI_MODEL_ALLOWLIST),
      modelCacheTtlMs: parsePositiveInteger(
        env.SAGE_MODEL_CACHE_TTL_MS,
        60_000,
        "SAGE_MODEL_CACHE_TTL_MS"
      ),
    },
    auth: {
      apiKey: requireString(env.SAGE_API_KEY, "SAGE_API_KEY"),
    },
    server: {
      host: optionalString(env.SAGE_HOST) || "0.0.0.0",
      port: parsePositiveInteger(env.SAGE_PORT, 8787, "SAGE_PORT"),
      corsOrigin: optionalString(env.SAGE_CORS_ORIGIN),
    },
    logging: {
      level: legacyLogLevel,
      pretty: parseBoolean(env.SAGE_LOG_PRETTY, logPrettyDefault),
      consoleLevel,
      fileLevel,
      filePath: path.resolve(process.cwd(), optionalString(env.SAGE_LOG_FILE_PATH) || "logs/sage.log"),
      fileEnabled: parseBoolean(env.SAGE_LOG_FILE_ENABLED, true),
    },
    memory: {
      mode: memoryMode,
      mem0Enabled: parseBoolean(env.SAGE_MEM0_ENABLED, true),
      zepEnabled: parseBoolean(env.SAGE_ZEP_ENABLED, true),
      redisEnabled: parseBoolean(env.SAGE_REDIS_ENABLED, true),
      topK: parsePositiveInteger(env.SAGE_MEMORY_TOP_K, 5, "SAGE_MEMORY_TOP_K"),
      semanticTopK: parsePositiveInteger(
        env.SAGE_MEMORY_SEMANTIC_TOP_K,
        5,
        "SAGE_MEMORY_SEMANTIC_TOP_K"
      ),
      episodicTopK: parsePositiveInteger(
        env.SAGE_MEMORY_EPISODIC_TOP_K,
        3,
        "SAGE_MEMORY_EPISODIC_TOP_K"
      ),
      graphMaxResults: parsePositiveInteger(
        env.SAGE_MEMORY_GRAPH_MAX_RESULTS,
        20,
        "SAGE_MEMORY_GRAPH_MAX_RESULTS"
      ),
      contextMaxTokens: parsePositiveInteger(
        env.SAGE_MEMORY_CONTEXT_MAX_TOKENS,
        1200,
        "SAGE_MEMORY_CONTEXT_MAX_TOKENS"
      ),
      retrievalTimeoutMs: parsePositiveInteger(
        env.SAGE_MEMORY_RETRIEVAL_TIMEOUT_MS,
        200,
        "SAGE_MEMORY_RETRIEVAL_TIMEOUT_MS"
      ),
      retrievalBudgetMs: parsePositiveInteger(
        env.SAGE_MEMORY_RETRIEVAL_BUDGET_MS,
        180,
        "SAGE_MEMORY_RETRIEVAL_BUDGET_MS"
      ),
      identityCacheTtlSec: parsePositiveInteger(
        env.SAGE_MEMORY_IDENTITY_CACHE_TTL_SEC,
        300,
        "SAGE_MEMORY_IDENTITY_CACHE_TTL_SEC"
      ),
      queryCacheTtlSec: parsePositiveInteger(
        env.SAGE_MEMORY_QUERY_CACHE_TTL_SEC,
        120,
        "SAGE_MEMORY_QUERY_CACHE_TTL_SEC"
      ),
      embeddingProvider:
        optionalString(env.SAGE_MEMORY_EMBEDDING_PROVIDER) || "mnemosyne",
      embeddingModel:
        optionalString(env.SAGE_MEMORY_EMBEDDING_MODEL)
        || optionalString(env.MNEMOSYNE_EMBEDDING_MODEL)
        || "nomic-embed-text",
      writeConcurrencyLimit: parsePositiveInteger(
        env.SAGE_MEMORY_WRITE_CONCURRENCY_LIMIT,
        8,
        "SAGE_MEMORY_WRITE_CONCURRENCY_LIMIT"
      ),
      timeouts: {
        mem0Ms: parsePositiveInteger(
          env.SAGE_MEMORY_TIMEOUT_MEM0_MS,
          250,
          "SAGE_MEMORY_TIMEOUT_MEM0_MS"
        ),
        zepMs: parsePositiveInteger(
          env.SAGE_MEMORY_TIMEOUT_ZEP_MS,
          120,
          "SAGE_MEMORY_TIMEOUT_ZEP_MS"
        ),
        mnemosyneMs: parsePositiveInteger(
          env.SAGE_MEMORY_TIMEOUT_MNEMOSYNE_MS,
          120,
          "SAGE_MEMORY_TIMEOUT_MNEMOSYNE_MS"
        ),
        redisMs: parsePositiveInteger(
          env.SAGE_MEMORY_TIMEOUT_REDIS_MS,
          30,
          "SAGE_MEMORY_TIMEOUT_REDIS_MS"
        ),
      },
      circuitBreaker: {
        failureThreshold: parsePositiveInteger(
          env.SAGE_MEMORY_CB_FAILURE_THRESHOLD,
          5,
          "SAGE_MEMORY_CB_FAILURE_THRESHOLD"
        ),
        windowMs: parsePositiveInteger(
          env.SAGE_MEMORY_CB_WINDOW_MS,
          60_000,
          "SAGE_MEMORY_CB_WINDOW_MS"
        ),
        cooldownMs: parsePositiveInteger(
          env.SAGE_MEMORY_CB_COOLDOWN_MS,
          30_000,
          "SAGE_MEMORY_CB_COOLDOWN_MS"
        ),
      },
      redisUrl:
        optionalString(env.SAGE_REDIS_URL)
        || optionalString(env.MNEMOSYNE_CACHE_URL)
        || "redis://localhost:6379",
      mem0: {
        apiKey: optionalString(env.MEM0_API_KEY),
        baseUrl: optionalString(env.MEM0_BASE_URL) || "https://api.mem0.ai",
        organizationId: optionalString(env.MEM0_ORG_ID),
        projectId: optionalString(env.MEM0_PROJECT_ID),
      },
      zep: {
        apiKey: optionalString(env.ZEP_API_KEY),
        baseUrl: optionalString(env.ZEP_BASE_URL),
      },
      extractionModel: optionalString(env.SAGE_MEMORY_EXTRACTION_MODEL),
      extractionAllowModelOverride: parseBoolean(
        env.SAGE_MEMORY_EXTRACTION_ALLOW_MODEL_OVERRIDE,
        false
      ),
      summaryModel: optionalString(env.SAGE_MEMORY_SUMMARY_MODEL),
      summaryAllowModelOverride: parseBoolean(
        env.SAGE_MEMORY_SUMMARY_ALLOW_MODEL_OVERRIDE,
        false
      ),
      extractEvery: parsePositiveInteger(
        env.SAGE_MEMORY_EXTRACT_EVERY,
        4,
        "SAGE_MEMORY_EXTRACT_EVERY"
      ),
      extractionHistoryMultiplier: parsePositiveNumber(
        env.SAGE_MEM_EXT_HISTORY_MULTIPLIER,
        2.0,
        "SAGE_MEM_EXT_HISTORY_MULTIPLIER"
      ),
      conversationDbPath: path.resolve(
        process.cwd(),
        optionalString(env.SAGE_CONVERSATION_DB_PATH) || "./data/sage-conversations.sqlite"
      ),
      mnemosyne: {
        vectorDbUrl:
          optionalString(env.MNEMOSYNE_VECTOR_DB_URL) || "http://localhost:6333",
        embeddingUrl:
          optionalString(env.MNEMOSYNE_EMBEDDING_URL) ||
          "http://localhost:11434/v1/embeddings",
        graphDbUrl:
          optionalString(env.MNEMOSYNE_GRAPH_DB_URL) || "redis://localhost:6380",
        cacheUrl:
          optionalString(env.MNEMOSYNE_CACHE_URL) || "redis://localhost:6379",
        agentId: optionalString(env.MNEMOSYNE_AGENT_ID) || "sage-api",
        embeddingModel:
          optionalString(env.MNEMOSYNE_EMBEDDING_MODEL) || "nomic-embed-text",
        collectionName:
          optionalString(env.MNEMOSYNE_COLLECTION_NAME) || "sage_mem_v2",
      },
    },
    llm: {
      localBaseUrl: optionalString(env.SAGE_LLM_LOCAL_BASE_URL)
        || optionalString(env.OPENAI_BASE_URL),
      localApiKey: optionalString(env.SAGE_LLM_LOCAL_API_KEY)
        || requireString(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
      cloudBaseUrl: optionalString(env.SAGE_LLM_CLOUD_BASE_URL)
        || optionalString(env.OPENAI_BASE_URL),
      cloudApiKey: optionalString(env.SAGE_LLM_CLOUD_API_KEY)
        || requireString(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
      localStreamWarmupMs: parsePositiveInteger(
        env.SAGE_LLM_LOCAL_STREAM_WARMUP_MS,
        2_000,
        "SAGE_LLM_LOCAL_STREAM_WARMUP_MS"
      ),
    },
    prompt: {
      systemPromptPath: path.resolve(
        process.cwd(),
        optionalString(env.SAGE_SYSTEM_PROMPT_PATH) || "./system_prompt.yaml"
      ),
    },
    tools: {
      enabled: parseBoolean(env.SAGE_TOOLS_ENABLED, true),
      maxRounds: parsePositiveInteger(env.SAGE_TOOL_MAX_ROUNDS, 6, "SAGE_TOOL_MAX_ROUNDS"),
      timeoutMs: parsePositiveInteger(env.SAGE_TOOL_TIMEOUT_MS, 10_000, "SAGE_TOOL_TIMEOUT_MS"),
      maxParallelCalls: parsePositiveInteger(
        env.SAGE_TOOL_MAX_PARALLEL_CALLS,
        4,
        "SAGE_TOOL_MAX_PARALLEL_CALLS"
      ),
      memoryWriteEnabled: parseBoolean(env.SAGE_MEMORY_TOOL_WRITE_ENABLED, true),
      memoryWriteWhitelist:
        parseCsvList(env.SAGE_MEMORY_TOOL_WRITE_WHITELIST) || ["add_memory"],
      mcpServers: parseJsonArray(env.SAGE_MCP_SERVERS_JSON, "SAGE_MCP_SERVERS_JSON"),
      web: {
        enabled: webEnabled,
        braveApiKey: webEnabled
          ? requireString(env.BRAVE_API_KEY, "BRAVE_API_KEY")
          : optionalString(env.BRAVE_API_KEY),
        mode: parseEnum(
          optionalString(env.SAGE_BRAVE_MODE) || "llm_context",
          ["llm_context", "web_search"],
          "SAGE_BRAVE_MODE"
        ),
        maxResults: parsePositiveInteger(
          env.SAGE_BRAVE_MAX_RESULTS,
          5,
          "SAGE_BRAVE_MAX_RESULTS"
        ),
        timeoutMs: parsePositiveInteger(
          env.SAGE_BRAVE_TIMEOUT_MS,
          8_000,
          "SAGE_BRAVE_TIMEOUT_MS"
        ),
        safeSearch: parseEnum(
          optionalString(env.SAGE_BRAVE_SAFESEARCH) || "off",
          ["off", "moderate", "strict"],
          "SAGE_BRAVE_SAFESEARCH"
        ),
        country: parseCountryCode(optionalString(env.SAGE_BRAVE_COUNTRY) || "GB", "SAGE_BRAVE_COUNTRY"),
        searchLang: parseSearchLanguage(
          optionalString(env.SAGE_BRAVE_SEARCH_LANG) || "en",
          "SAGE_BRAVE_SEARCH_LANG"
        ),
      },
      documentCache: {
        ttlMs: parsePositiveInteger(
          env.SAGE_DOC_CACHE_TTL_MS,
          3_600_000,
          "SAGE_DOC_CACHE_TTL_MS"
        ),
        maxDocuments: parsePositiveInteger(
          env.SAGE_DOC_CACHE_MAX_DOCS,
          500,
          "SAGE_DOC_CACHE_MAX_DOCS"
        ),
        maxDocumentBytes: parsePositiveInteger(
          env.SAGE_DOC_CACHE_MAX_DOC_BYTES,
          4_194_304,
          "SAGE_DOC_CACHE_MAX_DOC_BYTES"
        ),
      },
    },
  };
}

function requireString(value, name) {
  const parsed = optionalString(value);
  if (!parsed) {
    throw new AppError({
      statusCode: 500,
      code: "config_error",
      type: "server_error",
      message: `Missing required environment variable ${name}.`,
    });
  }
  return parsed;
}

function optionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError({
      statusCode: 500,
      code: "config_error",
      type: "server_error",
      message: `${name} must be a positive integer.`,
    });
  }

  return parsed;
}

function parsePositiveNumber(value, fallback, name) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError({
      statusCode: 500,
      code: "config_error",
      type: "server_error",
      message: `${name} must be a positive number.`,
    });
  }

  return parsed;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  throw new AppError({
    statusCode: 500,
    code: "config_error",
    type: "server_error",
    message: `Invalid boolean value \"${value}\".`,
  });
}

function parseCsvList(value) {
  const raw = optionalString(value);
  if (!raw) {
    return null;
  }

  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length > 0 ? items : null;
}

function parseLogLevel(value, name) {
  const validLevels = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
  if (validLevels.has(value)) {
    return value;
  }

  throw new AppError({
    statusCode: 500,
    code: "config_error",
    type: "server_error",
    message: `${name} must be one of: fatal, error, warn, info, debug, trace, silent.`,
  });
}

function parseJsonArray(value, name) {
  const raw = optionalString(value);
  if (!raw) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError({
      statusCode: 500,
      code: "config_error",
      type: "server_error",
      message: `${name} must be valid JSON.`,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new AppError({
      statusCode: 500,
      code: "config_error",
      type: "server_error",
      message: `${name} must be a JSON array.`,
    });
  }

  return parsed;
}

function parseEnum(value, allowedValues, name) {
  if (allowedValues.includes(value)) {
    return value;
  }

  throw new AppError({
    statusCode: 500,
    code: "config_error",
    type: "server_error",
    message: `${name} must be one of: ${allowedValues.join(", ")}.`,
  });
}

function parseCountryCode(value, name) {
  if (/^[A-Za-z]{2}$/.test(value)) {
    return value.toUpperCase();
  }

  throw new AppError({
    statusCode: 500,
    code: "config_error",
    type: "server_error",
    message: `${name} must be a 2-letter country code.`,
  });
}

function parseSearchLanguage(value, name) {
  if (/^[A-Za-z-]{2,10}$/.test(value)) {
    return value.toLowerCase();
  }

  throw new AppError({
    statusCode: 500,
    code: "config_error",
    type: "server_error",
    message: `${name} must be a valid language code.`,
  });
}

export { createConfig };
