import { AppError } from "../../errors/app-error.js";
import { excerptText } from "../../logging/safe-debug.js";
import {
  callBraveWebApi,
  normalizeBraveSearchResults,
  resolveBraveMode,
  resolveMaxResults,
  resolveMaxTokens,
  validateQuery,
} from "./brave-web.js";

const webSearchTool = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the internet and return lightweight web result metadata with stable result IDs.",
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
          maximum: 20,
        },
        mode: {
          type: "string",
          description: "Search mode override.",
          enum: ["llm_context", "web_search"],
        },
        max_tokens: {
          type: "integer",
          description: "Token profile for Brave context extraction.",
          enum: [2048, 8192, 16384],
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

function createWebSearchHandler({ config, documentCache }) {
  return async function handleWebSearch({ args, logger }) {
    if (!config.tools.web.enabled) {
      throw new AppError({
        statusCode: 400,
        code: "web_search_disabled",
        type: "invalid_request_error",
        message: "The web_search tool is disabled by server configuration.",
      });
    }

    const query = validateQuery(args.query);
    const mode = resolveBraveMode(args.mode, config.tools.web.mode);
    const maxTokens = resolveMaxTokens(args.max_tokens);
    const maxResults = resolveMaxResults(args.max_results, config.tools.web.maxResults);

    const payload = await callBraveWebApi({
      query,
      mode,
      maxResults,
      maxTokens,
      braveConfig: config.tools.web,
      logger,
    });

    const normalized = normalizeBraveSearchResults(payload, maxResults);
    const resultsWithIds = documentCache.putSearchResults({
      query,
      results: normalized.results,
    });

    logger.debug(
      {
        mode,
        queryExcerpt: excerptText(query),
        resultCount: resultsWithIds.length,
      },
      "web_search completed and stored result handles"
    );

    return {
      query,
      mode,
      max_tokens: maxTokens,
      result_count: resultsWithIds.length,
      results: resultsWithIds.map((result) => ({
        result_id: result.result_id,
        title: result.title,
        url: result.url,
        snippet: excerptText(result.snippet, 280),
      })),
    };
  };
}

export { webSearchTool, createWebSearchHandler };
