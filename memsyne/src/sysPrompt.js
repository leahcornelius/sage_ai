// Responsible for loading and updating the active system prompt from system_prompt.yaml
import fs from "fs";
import yaml from "js-yaml";
import { debug, systemPromptPath } from "./config.js";

// load
let doc;
try {
  const promptsFile = fs.readFileSync(systemPromptPath, "utf8");
  if (!promptsFile) {
    console.error(
      `No system prompt found at ${systemPromptPath}. Please create the file with your system prompt(s) before running.`
    );
    process.exit(1);
  }
  doc = yaml.load(promptsFile);

  // normalize prompts field: yaml may produce a map/object or an array
  if (doc && doc.prompts && !Array.isArray(doc.prompts)) {
    doc.prompts = Object.entries(doc.prompts).map(([id, data]) => ({ id, ...data }));
  }
} catch (err) {
  console.error(
    `Error reading system prompt file at ${systemPromptPath}:`,
    err.message
  );
  process.exit(1);
}

function getActiveID() {
  return doc.active;
}

function getActiveSystemPrompt() {
  if (!doc || !doc.prompts) return null;
  const active = doc.prompts.find((p) => p.id === doc.active);
  return active ? active.text : null;
}

function setActiveID(id) {
  if (!doc.prompts.some((p) => p.id === id)) {
    console.error(`No prompt with id ${id} found. Cannot set active prompt.`);
    return;
  }
  try {
    doc.active = id;
    fs.writeFileSync(systemPromptPath, yaml.dump(doc), "utf8");
  } catch (err) {
    console.error(`Error writing system prompt file:`, err.message);
  }
}

function addSystemPrompt(newID, text, makeActive = false, note = "") {
  // check if id already exists
  if (doc.prompts.some((p) => p.id === newID)) {
    console.error(
      `Prompt with id ${newID} already exists. Choose a different id.`
    );
    return;
  }
  try {
    const next = {
      id: newID,
      created: new Date().toISOString(),
      note,
      text,
    };
    doc.prompts.push(next);
    fs.writeFileSync(systemPromptPath, yaml.dump(doc), "utf8");
    if (makeActive) {
      setActiveID(newID);
    }
  } catch (err) {
    console.error(`Error adding system prompt:`, err.message);
  }
}

export { getActiveSystemPrompt, setActiveID, getActiveID, addSystemPrompt };
