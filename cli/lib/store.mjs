// Conversation persistence for the Sage chat CLI.
// Files live under conversations/<name>.json (git-ignored).

import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.cwd(), "conversations");
const VERSION = 1;

function ensureDir() {
  if (!fs.existsSync(DIR)) {
    fs.mkdirSync(DIR, { recursive: true });
  }
}

function slug(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "untitled";
}

function fileFor(name) {
  return path.join(DIR, `${slug(name)}.json`);
}

function settingsSnapshot(settings) {
  return {
    model: settings.model,
    stream: settings.stream,
    render: settings.render,
    params: settings.params,
    toolChoice: settings.toolChoice,
    customTools: settings.customTools,
  };
}

// Write a conversation to <name>.json. Returns the slug used.
function save(name, { chatId, settings, messages, createdAt }) {
  ensureDir();
  const target = fileFor(name);
  let created = createdAt;
  if (!created && fs.existsSync(target)) {
    try {
      created = JSON.parse(fs.readFileSync(target, "utf8")).createdAt;
    } catch {
      created = undefined;
    }
  }
  const now = new Date().toISOString();
  const payload = {
    version: VERSION,
    chatId,
    createdAt: created || now,
    updatedAt: now,
    settings: settingsSnapshot(settings),
    messages,
  };
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
  return slug(name);
}

// Autosave keyed by chatId so each conversation has a stable file.
function autosave({ chatId, settings, messages, createdAt }) {
  if (!chatId) {
    return null;
  }
  return save(chatId, { chatId, settings, messages, createdAt });
}

function load(name) {
  const target = fileFor(name);
  if (!fs.existsSync(target)) {
    throw new Error(`No saved conversation named "${slug(name)}".`);
  }
  const data = JSON.parse(fs.readFileSync(target, "utf8"));
  return {
    chatId: data.chatId,
    createdAt: data.createdAt,
    settings: data.settings || {},
    messages: Array.isArray(data.messages) ? data.messages : [],
  };
}

function remove(name) {
  const target = fileFor(name);
  if (!fs.existsSync(target)) {
    throw new Error(`No saved conversation named "${slug(name)}".`);
  }
  fs.unlinkSync(target);
  return slug(name);
}

function list() {
  ensureDir();
  const entries = [];
  for (const file of fs.readdirSync(DIR)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8"));
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const turns = messages.filter((m) => m.role === "user").length;
      entries.push({
        name: file.replace(/\.json$/, ""),
        turns,
        updatedAt: data.updatedAt || data.createdAt || null,
      });
    } catch {
      // Skip unreadable files.
    }
  }
  entries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return entries;
}

export { save, autosave, load, remove, list, slug, DIR };
