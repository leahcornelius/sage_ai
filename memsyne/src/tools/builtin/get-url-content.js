import { AppError } from "../../errors/app-error.js";
import { excerptText, textLength } from "../../logging/safe-debug.js";
import {
  buildPreviewForTokens,
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
      "Fetch a URL, cache the full parsed document server-side, and return a document handle for chunked reads.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to retrieve content from.",
        },
        result_id: {
          type: "string",
          description: "A web_search result_id previously returned by web_search.",
        },
        mode: {
          type: "string",
          description: "Brave retrieval mode override.",
          enum: ["llm_context", "web_search"],
        },
        max_tokens: {
          type: "integer",
          description: "Token profile for preview sizing.",
          enum: [2048, 8192, 16384],
        },
      },
      additionalProperties: false,
    },
  },
};

function createGetUrlContentHandler({ config, documentCache }) {
  return async function handleGetUrlContent({ args, logger }) {
    if (!config.tools.web.enabled) {
      throw new AppError({
        statusCode: 400,
        code: "web_search_disabled",
        type: "invalid_request_error",
        message: "The get_url_content tool is disabled by server configuration.",
      });
    }

    const url = resolveUrlFromArgs({ args, documentCache });
    const mode = resolveBraveMode(args.mode, config.tools.web.mode);
    const maxTokens = resolveMaxTokens(args.max_tokens);

    logger.debug(
      {
        url: excerptText(url, 200),
        mode,
        maxTokens,
      },
      "Fetching URL content for document cache"
    );

    let source = "brave";
    let content = "";
    let title = "";
    let metadata = {};

    try {
      const braveResult = await fetchUrlContentFromBrave({
        url,
        mode,
        maxTokens,
        config,
        logger,
      });

      if (braveResult) {
        content = braveResult.content;
        title = braveResult.title;
        metadata = braveResult.metadata;
      } else {
        source = "direct_fallback";
      }
    } catch (error) {
      source = "direct_fallback";
      logger.warn(
        {
          err: error,
          url: excerptText(url, 200),
        },
        "Brave URL retrieval failed; falling back to direct fetch"
      );
    }

    if (source === "direct_fallback") {
      const fallback = await fetchUrlContentDirect({
        url,
        timeoutMs: config.tools.web.timeoutMs,
      });
      content = fallback.content;
      title = fallback.title;
      metadata = fallback.metadata;
    }

    if (!content || !content.trim()) {
      throw new AppError({
        statusCode: 502,
        code: "upstream_error",
        type: "server_error",
        message: "No readable content was retrieved for the provided URL.",
      });
    }

    const cached = documentCache.putDocument({
      url,
      title,
      text: content,
      metadata,
      source,
      logger,
    });
    const preview = buildPreviewForTokens(content, maxTokens);

    logger.debug(
      {
        url: excerptText(url, 200),
        source,
        documentId: cached.documentId,
        contentLength: textLength(content),
        storedBytes: cached.storedBytes,
        truncated: cached.truncated,
      },
      "Cached URL content and returned document handle"
    );

    return {
      document_id: cached.documentId,
      url,
      source,
      title: title || null,
      text_length: cached.textLength,
      preview,
      metadata: {
        ...metadata,
        truncated_in_cache: cached.truncated,
      },
    };
  };
}

function resolveUrlFromArgs({ args, documentCache }) {
  const urlArg = typeof args.url === "string" ? args.url.trim() : "";
  const resultId = typeof args.result_id === "string" ? args.result_id.trim() : "";

  if (urlArg) {
    return validateUrl(urlArg);
  }

  if (resultId) {
    const resolved = documentCache.resolveResultUrl(resultId);
    if (!resolved) {
      throw new AppError({
        statusCode: 400,
        code: "invalid_tool_arguments",
        type: "invalid_request_error",
        message: "result_id is not found or has expired.",
      });
    }
    return resolved;
  }

  throw new AppError({
    statusCode: 400,
    code: "invalid_tool_arguments",
    type: "invalid_request_error",
    message: "Either url or result_id is required.",
  });
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

  const normalized = normalizeBraveSearchResults(payload, Math.min(config.tools.web.maxResults, 5));
  if (!normalized.results.length && !normalized.contextText) {
    return null;
  }

  const bestMatch = selectBestUrlMatch(normalized.results, url);
  const contentCandidate = bestMatch?.context || normalized.contextText || "";
  if (contentCandidate.length < 300) {
    return null;
  }

  return {
    content: contentCandidate,
    title: bestMatch?.title || "",
    metadata: {
      matched_url: bestMatch?.url || null,
      matched_title: bestMatch?.title || null,
      result_count: normalized.results.length,
      fetched_via: "brave",
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
