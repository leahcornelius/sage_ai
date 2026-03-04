import { AppError } from "../../errors/app-error.js";
import { excerptText } from "../../logging/safe-debug.js";
import {
  callBraveWebApi,
  fetchUrlContentDirect,
  normalizeBraveSearchResults,
  resolveBraveMode,
  resolveMaxTokens,
  validateUrl,
} from "./brave-web.js";

const getUrlContentTool = {
  type: "function",
  function: {
    name: "get_url_content",
    description:
      "Retrieve the content of a specific URL using Brave-first retrieval with direct fallback.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to retrieve content from.",
        },
        mode: {
          type: "string",
          description: "Brave retrieval mode override.",
          enum: ["llm_context", "web_search"],
        },
        max_tokens: {
          type: "integer",
          description: "Token budget for returned content.",
          enum: [2048, 8192, 16384],
        },
      },
      required: ["url", "max_tokens"],
      additionalProperties: false,
    },
  },
};

function createGetUrlContentHandler({ config }) {
  return async function handleGetUrlContent({ args, logger }) {
    if (!config.tools.web.enabled) {
      throw new AppError({
        statusCode: 400,
        code: "web_search_disabled",
        type: "invalid_request_error",
        message:
          "The get_url_content tool is disabled by server configuration.",
      });
    }

    const url = validateUrl(args.url);
    const mode = resolveBraveMode(args.mode, config.tools.web.mode);
    const maxTokens = resolveMaxTokens(args.max_tokens);
    logger.debug(
      {
        url: excerptText(url, 200),
        mode,
        maxTokens,
      },
      "Fetching URL content"
    );
    let braveResult = null;
    try {
      braveResult = await fetchUrlContentFromBrave({
        url,
        mode,
        maxTokens,
        config,
        logger,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          url: excerptText(url, 200),
        },
        "Brave URL retrieval failed; falling back to direct fetch"
      );
    }

    if (braveResult) {
      logger.debug(
        {
          url: excerptText(url, 200),
          mode,
          source: "brave",
        },
        "get_url_content completed via Brave API"
      );
      return braveResult;
    }

    const fallback = await fetchUrlContentDirect({
      url,
      maxTokens,
      timeoutMs: config.tools.web.timeoutMs,
    });

    logger.debug(
      {
        url: excerptText(url, 200),
        mode,
        source: "direct_fallback",
      },
      "get_url_content completed via direct fallback"
    );

    return {
      url,
      mode,
      max_tokens: maxTokens,
      source: "direct_fallback",
      content: fallback.content,
      metadata: fallback.metadata,
    };
  };
}

async function fetchUrlContentFromBrave({
  url,
  mode,
  maxTokens,
  config,
  logger,
}) {
  const payload = await callBraveWebApi({
    query: url,
    mode,
    maxResults: Math.min(config.tools.web.maxResults, 5),
    maxTokens,
    braveConfig: config.tools.web,
    logger,
  });

  const normalized = normalizeBraveSearchResults(
    payload,
    Math.min(config.tools.web.maxResults, 5)
  );
  if (!normalized.results.length && !normalized.contextText) {
    return null;
  }

  const bestMatch = selectBestUrlMatch(normalized.results, url);
  const content = bestMatch?.context || normalized.contextText;
  if (!content) {
    return null;
  }

  return {
    url,
    mode,
    max_tokens: maxTokens,
    source: "brave",
    content,
    metadata: {
      matched_url: bestMatch?.url || null,
      matched_title: bestMatch?.title || null,
      result_count: normalized.results.length,
    },
  };
}

function selectBestUrlMatch(results, targetUrl) {
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  const target = normalizeUrl(targetUrl);
  const exact = results.find((result) => normalizeUrl(result.url) === target);
  if (exact) {
    return exact;
  }

  const targetHost = hostFromUrl(targetUrl);
  const hostMatch = results.find(
    (result) => hostFromUrl(result.url) === targetHost
  );
  return hostMatch || results[0];
}

function normalizeUrl(value) {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    return String(value || "");
  }
}

function hostFromUrl(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

export { getUrlContentTool, createGetUrlContentHandler };
