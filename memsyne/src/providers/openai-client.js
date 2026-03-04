import OpenAI from "openai";

/**
 * Builds the upstream OpenAI client used for both chat completions and model
 * discovery.
 */
function createOpenAIClient(config) {
  return new OpenAI({
    apiKey: config.openai.apiKey,
    baseURL: config.openai.baseUrl || undefined,
  });
}

export { createOpenAIClient };
