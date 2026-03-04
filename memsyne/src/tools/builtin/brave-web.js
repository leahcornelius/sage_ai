import { AppError } from "../../errors/app-error.js";
import { excerptText } from "../../logging/safe-debug.js";

const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const ALLOWED_MAX_TOKENS = new Set([2048, 8192, 16384, 32768]);
const DEFAULT_MAX_TOKENS = 16384;

function resolveBraveMode(modeArg, defaultMode) {
  const mode = typeof modeArg === "string" ? modeArg.trim().toLowerCase() : defaultMode;
  if (!["llm_context", "web_search"].includes(mode)) {
    throw invalidToolArguments("mode must be one of: llm_context, web_search.");
  }
  return mode;
}

function resolveMaxTokens(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_MAX_TOKENS;
  }

  const parsed = Number.parseInt(value, 10);
  if (!ALLOWED_MAX_TOKENS.has(parsed)) {
    throw invalidToolArguments("max_tokens must be one of: 2048, 8192, 16384, 32768.");
  }
  return parsed;
}

function resolveMaxResults(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw invalidToolArguments("max_results must be an integer between 1 and 20.");
  }
  return parsed;
}

function validateQuery(value) {
  const query = typeof value === "string" ? value.trim() : "";
  if (!query || query.length > 500) {
    throw invalidToolArguments("query must be a non-empty string with max length 500.");
  }
  return query;
}

function validateUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw invalidToolArguments("url is required.");
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidToolArguments("url must be a valid URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw invalidToolArguments("url must use http or https.");
  }
  return parsed.toString();
}

async function callBraveWebApi({
  query,
  mode,
  maxResults,
  maxTokens,
  braveConfig,
  logger,
}) {
  const url = new URL(BRAVE_WEB_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("country", braveConfig.country);
  url.searchParams.set("search_lang", braveConfig.searchLang);
  url.searchParams.set("safesearch", braveConfig.safeSearch);
  url.searchParams.set("count", String(maxResults));

  if (mode === "llm_context") {
    url.searchParams.set("summary", "true");
    url.searchParams.set("result_filter", "web");
    url.searchParams.set("maximum_number_of_urls", String(maxResults));
    url.searchParams.set("maximum_number_of_tokens_per_url", String(maxTokens));
  }

  const signal = AbortSignal.timeout(braveConfig.timeoutMs);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": braveConfig.braveApiKey,
    },
    signal,
  });

  if (!response.ok) {
    const responseBody = await response.text();
    logger.error(
      {
        braveUrl: url.toString(),
        mode,
        responseStatus: response.status,
        responseBody: excerptText(responseBody, 800),
      },
      "Brave web API returned an error"
    );
    throw new AppError({
      statusCode: 502,
      code: "upstream_error",
      type: "server_error",
      message: `Brave API responded with status ${response.status}.`,
    });
  }

  return response.json();
}

function normalizeBraveSearchResults(payload, maxResults) {
  const rawResults = Array.isArray(payload?.web?.results)
    ? payload.web.results
    : Array.isArray(payload?.results)
      ? payload.results
      : [];
  const normalizedResults = rawResults.slice(0, maxResults).map((item) => normalizeResult(item));
  const contextText =
    extractContextText(payload) ||
    normalizedResults.map((result) => result.context || result.snippet).filter(Boolean).join("\n\n");

  return {
    results: normalizedResults,
    contextText: excerptText(contextText, 12000),
  };
}

function normalizeResult(item) {
  const snippets = Array.isArray(item?.extra_snippets)
    ? item.extra_snippets.map((snippet) => excerptText(String(snippet || ""), 500)).filter(Boolean)
    : [];

  const description = excerptText(String(item?.description || item?.snippet || ""), 500);
  const context = [description, ...snippets].filter(Boolean).join(" ");

  return {
    title: excerptText(String(item?.title || ""), 200),
    url: String(item?.url || item?.link || ""),
    snippet: description,
    context: excerptText(context, 2000),
  };
}

function extractContextText(payload) {
  const candidates = [
    payload?.summary,
    payload?.llm_context,
    payload?.context,
    payload?.web?.context,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (candidate && typeof candidate === "object") {
      if (typeof candidate.text === "string" && candidate.text.trim()) {
        return candidate.text.trim();
      }
      if (typeof candidate.summary === "string" && candidate.summary.trim()) {
        return candidate.summary.trim();
      }
    }
  }

  return "";
}

async function fetchUrlContentDirect({ url, maxTokens, timeoutMs }) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
    },
    redirect: "follow",
    signal,
  });

  if (!response.ok) {
    throw new AppError({
      statusCode: 502,
      code: "upstream_error",
      type: "server_error",
      message: `Failed to fetch URL content (status ${response.status}).`,
    });
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    throw new AppError({
      statusCode: 400,
      code: "unsupported_content_type",
      type: "invalid_request_error",
      message: `URL content type is unsupported: ${contentType || "unknown"}.`,
    });
  }

  const raw = await response.text();
  const text = contentType.includes("text/html") ? extractTextFromHtml(raw) : raw;
  const bounded = truncateToTokenBudget(text, maxTokens);

  return {
    content: bounded,
    metadata: {
      final_url: response.url || url,
      content_type: contentType || null,
      fetched_via: "direct_fallback",
    },
  };
}

function extractTextFromHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateToTokenBudget(value, maxTokens) {
  const text = String(value || "").trim();
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)} ...[truncated]`;
}

function invalidToolArguments(message) {
  return new AppError({
    statusCode: 400,
    code: "invalid_tool_arguments",
    type: "invalid_request_error",
    message,
  });
}

export {
  DEFAULT_MAX_TOKENS,
  resolveBraveMode,
  resolveMaxResults,
  resolveMaxTokens,
  validateQuery,
  validateUrl,
  callBraveWebApi,
  normalizeBraveSearchResults,
  fetchUrlContentDirect,
};
