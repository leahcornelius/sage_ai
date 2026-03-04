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
    description: "Search the internet with Brave and return LLM-friendly context with metadata.",
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
          description: "Per-result token budget for context extraction.",
          enum: [2048, 8192, 16384],
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

function createWebSearchHandler({ config }) {
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
    logger.debug(
      {
        mode,
        queryExcerpt: excerptText(query),
        resultCount: normalized.results.length,
        contextLength: normalized.contextText.length,
      },
      "web_search completed via Brave API"
    );

    return {
      query,
      mode,
      max_tokens: maxTokens,
      result_count: normalized.results.length,
      context: normalized.contextText,
      results: normalized.results,
    };
  };
}

export { webSearchTool, createWebSearchHandler };
