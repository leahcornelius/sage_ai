import { AppError } from "../../errors/app-error.js";
import { excerptText } from "../../logging/safe-debug.js";

const webSearchTool = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for fresh information.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string.",
        },
        max_results: {
          type: "integer",
          description: "Max number of results to return.",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

function createWebSearchHandler({ config }) {
  return async function handleWebSearch({ args, logger }) {
    if (!config.tools.webSearch.enabled) {
      throw new AppError({
        statusCode: 400,
        code: "web_search_disabled",
        type: "invalid_request_error",
        message: "The web_search tool is disabled by server configuration.",
      });
    }

    if (!config.tools.webSearch.apiUrl || !config.tools.webSearch.apiKey) {
      throw new AppError({
        statusCode: 500,
        code: "config_error",
        type: "server_error",
        message:
          "web_search is enabled but SAGE_WEB_SEARCH_API_URL or SAGE_WEB_SEARCH_API_KEY is missing.",
      });
    }

    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query || query.length > 500) {
      throw new AppError({
        statusCode: 400,
        code: "invalid_tool_arguments",
        type: "invalid_request_error",
        message:
          "web_search requires query length between 1 and 500 characters.",
      });
    }

    const parsedMaxResults = Number.parseInt(args.max_results, 10);
    const maxResults =
      Number.isInteger(parsedMaxResults) &&
      parsedMaxResults >= 1 &&
      parsedMaxResults <= 10
        ? parsedMaxResults
        : config.tools.webSearch.maxResults;

    const signal = AbortSignal.timeout(config.tools.webSearch.timeoutMs);
    const response = await fetch(config.tools.webSearch.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.tools.webSearch.apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
      }),
      signal,
    });

    if (!response.ok) {
      logger.error(
        {
          apiUrl: config.tools.webSearch.apiUrl,
          requestBody: { query, max_results: maxResults },
          responseStatus: response.status,
          responseStatusText: response.statusText,
          responseBody: await response.clone().text(),
        },
        "web_search provider error"
      );
      throw new AppError({
        statusCode: 502,
        code: "upstream_error",
        type: "server_error",
        message: `web_search provider responded with status ${response.status}.`,
      });
    }

    const payload = await response.json();
    const normalizedResults = normalizeSearchResults(payload, maxResults);
    logger.debug(
      {
        queryExcerpt: excerptText(query),
        resultCount: normalizedResults.length,
      },
      "web_search completed"
    );

    return {
      query,
      result_count: normalizedResults.length,
      results: normalizedResults,
    };
  };
}

function normalizeSearchResults(payload, maxResults) {
  const source = Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
    ? payload
    : [];

  return source.slice(0, maxResults).map((item) => ({
    title: excerptText(String(item?.title || item?.name || ""), 200),
    url: String(item?.url || item?.link || ""),
    snippet: excerptText(
      String(item?.snippet || item?.description || item?.content || ""),
      500
    ),
  }));
}

export { webSearchTool, createWebSearchHandler };
