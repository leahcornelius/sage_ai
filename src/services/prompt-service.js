import fs from "node:fs";
import yaml from "js-yaml";

import { AppError } from "../errors/app-error.js";

/**
 * Loads the active system prompt at startup and exposes a small read-only API.
 */
function createPromptService({ config, logger }) {
  let doc;
  try {
    const promptsFile = fs.readFileSync(config.prompt.systemPromptPath, "utf8");
    doc = yaml.load(promptsFile);
  } catch (error) {
    throw new AppError({
      statusCode: 500,
      code: "prompt_load_failed",
      type: "server_error",
      message: `Failed to read system prompt file at ${config.prompt.systemPromptPath}.`,
      cause: error,
    });
  }

  if (doc && doc.prompts && !Array.isArray(doc.prompts)) {
    doc.prompts = Object.entries(doc.prompts).map(([id, prompt]) => ({ id, ...prompt }));
  }

  const activePrompt = doc?.prompts?.find((prompt) => prompt.id === doc?.active);
  if (!activePrompt?.text) {
    throw new AppError({
      statusCode: 500,
      code: "prompt_load_failed",
      type: "server_error",
      message: `No active system prompt could be found in ${config.prompt.systemPromptPath}.`,
    });
  }

  logger.info(
    {
      activePromptId: activePrompt.id,
      systemPromptPath: config.prompt.systemPromptPath,
    },
    "Loaded active system prompt"
  );

  return {
    getActivePromptId() {
      return activePrompt.id;
    },
    getActiveSystemPrompt() {
      return activePrompt.text;
    },
  };
}

export { createPromptService };
