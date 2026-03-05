import OpenAI from "openai";

/**
 * Builds the upstream OpenAI client used for both chat completions and model
 * discovery.
 */
function createOpenAIClient(configOrOptions) {
  const apiKey =
    configOrOptions?.openai?.apiKey
    || configOrOptions?.apiKey
    || null;
  const baseUrl =
    configOrOptions?.openai?.baseUrl
    || configOrOptions?.baseUrl
    || null;

  return new OpenAI({
    apiKey,
    baseURL: baseUrl || undefined,
  });
}

export { createOpenAIClient };
