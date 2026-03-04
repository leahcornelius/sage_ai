
import fs from "fs";
import path from "path";

// ------------ CONFIGURATION --------------
const debug = true; // set to false to disable verbose console logging

function loadOpenAIKey() {
  // Try to load from environment variable first
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  // Try to load from config file
  try {
    const configPath = path.join(process.cwd(), ".env.local");
    if (fs.existsSync(configPath)) {
      const envContent = fs.readFileSync(configPath, "utf8");
      const match = envContent.match(/OPENAI_API_KEY=(.+)/);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  } catch (err) {
    console.error("Error reading .env.local file:", err.message);
  }

  console.error("No OPENAI_API_KEY found in environment or .env.local file");
  process.exit(1);
}

const OPENAI_API_KEY = loadOpenAIKey();

// Mnemosyne config — Qdrant & local embedding endpoint (ollama docker image) must be running
const MNEMOSYNE_CONFIG = {
  vectorDbUrl: "http://localhost:6333",
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  graphDbUrl: 'redis://localhost:6380',
  cacheUrl: 'redis://localhost:6379',
  agentId: "sage-cli",
  embeddingModel: "nomic-embed-text",
  collectionName: "testing_container",
};

const systemPromptPath = "./system_prompt.yaml";

export { MNEMOSYNE_CONFIG, OPENAI_API_KEY, systemPromptPath, debug};
