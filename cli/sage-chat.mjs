#!/usr/bin/env node
// Sage Chat CLI — a fast, terminal-native REPL for the Sage OpenAI-compatible server.

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { health, listModels, chat, streamChat, SageError, PASSTHROUGH_FIELDS } from "./lib/client.mjs";
import { style, youPrompt, sagePrompt, meta, errorLine, infoLine, mdToAnsi, rerenderBlock } from "./lib/render.mjs";
import * as store from "./lib/store.mjs";

// Best-effort: load .env.local if dotenv is available. The CLI reads
// process.env regardless, so a missing dependency is non-fatal.
try {
  const { config: loadDotEnv } = await import("dotenv");
  loadDotEnv({ path: path.resolve(process.cwd(), ".env.local"), override: false, quiet: true });
} catch {
  // dotenv not installed — rely on the ambient environment.
}

// ---- Config resolution --------------------------------------------------

function parseFlags(argv) {
  const flags = { stream: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") flags.baseUrl = argv[++i];
    else if (arg === "--model") flags.model = argv[++i];
    else if (arg === "--no-stream") flags.stream = false;
    else if (arg === "--new") flags.new = true;
    else if (arg === "--load") flags.load = argv[++i];
    else if (arg === "--help" || arg === "-h") flags.help = true;
  }
  return flags;
}

function normalizeBaseUrl(raw) {
  let url = (raw || "http://localhost:8787").trim().replace(/\/+$/, "");
  url = url.replace("0.0.0.0", "localhost");
  return url;
}

function newChatId() {
  return `cli-${randomUUID()}`;
}

function buildSettings(flags) {
  const apiKey = process.env.SAGE_API_KEY;
  if (!apiKey) {
    console.error(errorLine("SAGE_API_KEY is not set. Add it to your environment or .env.local."));
    process.exit(1);
  }
  return {
    baseUrl: normalizeBaseUrl(flags.baseUrl || process.env.SAGE_CLI_BASE_URL),
    apiKey,
    model: flags.model || null,
    stream: flags.stream === false ? false : true,
    render: true,
    params: {},
    toolChoice: null,
    customTools: [],
    chatId: newChatId(),
    createdAt: new Date().toISOString(),
    messages: [],
  };
}

// ---- Persistence helpers ------------------------------------------------

function persist(settings) {
  try {
    store.autosave({
      chatId: settings.chatId,
      settings,
      messages: settings.messages,
      createdAt: settings.createdAt,
    });
  } catch (error) {
    console.error(errorLine(`Autosave failed: ${error.message}`));
  }
}

function applyLoaded(settings, loaded) {
  settings.chatId = loaded.chatId || newChatId();
  settings.createdAt = loaded.createdAt || new Date().toISOString();
  settings.messages = loaded.messages || [];
  const s = loaded.settings || {};
  if ("model" in s) settings.model = s.model;
  if ("stream" in s) settings.stream = s.stream;
  if ("render" in s) settings.render = s.render;
  if (s.params && typeof s.params === "object") settings.params = s.params;
  if ("toolChoice" in s) settings.toolChoice = s.toolChoice;
  if (Array.isArray(s.customTools)) settings.customTools = s.customTools;
}

// ---- System message handling --------------------------------------------

function setSystem(settings, text) {
  const hasSystem = settings.messages[0]?.role === "system";
  if (!text) {
    if (hasSystem) settings.messages.shift();
    return;
  }
  if (hasSystem) settings.messages[0].content = text;
  else settings.messages.unshift({ role: "system", content: text });
}

// ---- Completion turn ----------------------------------------------------

let currentAbort = null;

async function runCompletion(settings) {
  stdout.write(`\n${sagePrompt}\n`);
  const startedAt = Date.now();
  const abort = new AbortController();
  currentAbort = abort;
  let raw = "";
  try {
    let result;
    if (settings.stream) {
      result = await streamChat(settings, abort.signal, (delta) => {
        raw += delta;
        stdout.write(delta);
      });
      stdout.write("\n");
      if (settings.render && stdout.isTTY && raw.length > 0) {
        rerenderBlock(raw);
      }
    } else {
      result = await chat(settings, abort.signal);
      const text = settings.render ? mdToAnsi(result.content) : result.content;
      stdout.write(`${text}\n`);
    }

    settings.messages.push({ role: "assistant", content: result.content });
    printFooter(settings, result, Date.now() - startedAt);
    persist(settings);
  } catch (error) {
    if (error.name === "AbortError") {
      stdout.write(`\n${infoLine("(cancelled)")}\n`);
      // Drop the unanswered user turn so history stays paired.
      if (settings.messages.at(-1)?.role === "user") settings.messages.pop();
    } else if (error instanceof SageError) {
      console.error(errorLine(error.code ? `${error.code}: ${error.message}` : error.message));
      if (settings.messages.at(-1)?.role === "user") settings.messages.pop();
    } else {
      console.error(errorLine(error.message));
      if (settings.messages.at(-1)?.role === "user") settings.messages.pop();
    }
  } finally {
    currentAbort = null;
  }
}

function printFooter(settings, result, ms) {
  const model = result.model || settings.model || "default";
  const tokens = result.usage?.total_tokens;
  const tokenLabel = typeof tokens === "number" ? `${tokens} tok` : `~${result.content.length} chars`;
  console.log(meta(`${model} · ${tokenLabel} · ${ms}ms`));
}

// ---- Slash commands -----------------------------------------------------

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function setParam(settings, key, value) {
  const n = num(value);
  if (n === null) {
    console.log(errorLine(`Expected a number for ${key}.`));
    return;
  }
  settings.params[key] = n;
  console.log(infoLine(`${key} = ${n}`));
  persist(settings);
}

function showParams(settings) {
  const lines = [
    `model: ${settings.model || "(server default)"}`,
    `stream: ${settings.stream}   render: ${settings.render}`,
    `tool_choice: ${settings.toolChoice ? JSON.stringify(settings.toolChoice) : "(unset)"}`,
    `custom tools: ${settings.customTools.length}`,
    `params: ${Object.keys(settings.params).length ? JSON.stringify(settings.params) : "(none)"}`,
    `chatId: ${settings.chatId}`,
    `messages: ${settings.messages.length}`,
  ];
  console.log(lines.map((l) => infoLine(l)).join("\n"));
}

const HELP = `Commands:
  Inference: /model [name|clear]  /models  /temp <v>  /top_p <v>
             /max_tokens <v>  /max_completion_tokens <v>  /seed <v>
             /presence <v>  /frequency <v>  /stop <a> <b>…|clear
             /reasoning <none|low|medium|high>  /user <id|clear>
             /system <text>|clear  /set <key> <json>  /unset <key>
             /stream <on|off>  /render <on|off>  /params
  Convo:     /new [id]  /save [name]  /load <name>  /list  /delete <name>
             /history  /clear  /retry  /undo
  Tools:     /tools <auto|none|required>  /tools list
             /tool add <json>  /tool clear
  Misc:      /health  /help  /exit`;

// Returns true if the REPL should exit.
async function dispatch(settings, line) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const argStr = line.slice(1 + cmd.length).trim();

  switch (cmd) {
    case "exit":
    case "quit":
      return true;

    case "help":
      console.log(infoLine(HELP));
      return false;

    case "model":
      if (!argStr) console.log(infoLine(`model: ${settings.model || "(server default)"}`));
      else if (argStr === "clear") { settings.model = null; console.log(infoLine("model cleared")); persist(settings); }
      else { settings.model = argStr; console.log(infoLine(`model = ${argStr}`)); persist(settings); }
      return false;

    case "models":
      try {
        const models = await listModels(settings);
        console.log(infoLine(models.map((m) => `  ${m.id}`).join("\n") || "  (none)"));
      } catch (error) {
        console.error(errorLine(error.message));
      }
      return false;

    case "temp": setParam(settings, "temperature", rest[0]); return false;
    case "top_p": setParam(settings, "top_p", rest[0]); return false;
    case "max_tokens": setParam(settings, "max_tokens", rest[0]); return false;
    case "max_completion_tokens": setParam(settings, "max_completion_tokens", rest[0]); return false;
    case "seed": setParam(settings, "seed", rest[0]); return false;
    case "presence": setParam(settings, "presence_penalty", rest[0]); return false;
    case "frequency": setParam(settings, "frequency_penalty", rest[0]); return false;

    case "stop":
      if (!argStr || argStr === "clear") { delete settings.params.stop; console.log(infoLine("stop cleared")); }
      else { settings.params.stop = rest; console.log(infoLine(`stop = ${JSON.stringify(rest)}`)); }
      persist(settings);
      return false;

    case "reasoning":
      if (!["none", "low", "medium", "high"].includes(argStr)) {
        console.log(errorLine("Usage: /reasoning <none|low|medium|high>"));
      } else {
        settings.params.reasoning_effort = argStr;
        console.log(infoLine(`reasoning_effort = ${argStr}`));
        persist(settings);
      }
      return false;

    case "user":
      if (!argStr || argStr === "clear") { delete settings.params.user; console.log(infoLine("user cleared")); }
      else { settings.params.user = argStr; console.log(infoLine(`user = ${argStr}`)); }
      persist(settings);
      return false;

    case "system":
      if (!argStr || argStr === "clear") { setSystem(settings, null); console.log(infoLine("system prompt cleared")); }
      else { setSystem(settings, argStr); console.log(infoLine("system prompt set")); }
      persist(settings);
      return false;

    case "set": {
      const key = rest[0];
      const rawVal = argStr.slice(key ? key.length : 0).trim();
      if (!key || !PASSTHROUGH_FIELDS.includes(key)) {
        console.log(errorLine(`Unknown field. One of: ${PASSTHROUGH_FIELDS.join(", ")}`));
        return false;
      }
      try {
        settings.params[key] = JSON.parse(rawVal);
        console.log(infoLine(`${key} = ${JSON.stringify(settings.params[key])}`));
        persist(settings);
      } catch {
        console.log(errorLine(`Invalid JSON value for ${key}.`));
      }
      return false;
    }

    case "unset":
      if (rest[0] && rest[0] in settings.params) { delete settings.params[rest[0]]; console.log(infoLine(`${rest[0]} unset`)); persist(settings); }
      else console.log(infoLine(`${rest[0] || "(key)"} was not set`));
      return false;

    case "stream":
      settings.stream = argStr !== "off";
      console.log(infoLine(`stream ${settings.stream ? "on" : "off"}`));
      persist(settings);
      return false;

    case "render":
      settings.render = argStr !== "off";
      console.log(infoLine(`render ${settings.render ? "on" : "off"}`));
      persist(settings);
      return false;

    case "params":
      showParams(settings);
      return false;

    case "new":
      settings.chatId = argStr ? `cli-${store.slug(argStr)}` : newChatId();
      settings.createdAt = new Date().toISOString();
      settings.messages = [];
      console.log(infoLine(`new conversation: ${settings.chatId}`));
      persist(settings);
      return false;

    case "save":
      try {
        const name = store.save(argStr || settings.chatId, {
          chatId: settings.chatId, settings, messages: settings.messages, createdAt: settings.createdAt,
        });
        console.log(infoLine(`saved as ${name}`));
      } catch (error) {
        console.error(errorLine(error.message));
      }
      return false;

    case "load":
      try {
        applyLoaded(settings, store.load(argStr));
        console.log(infoLine(`loaded ${argStr} (${settings.messages.length} messages, chatId ${settings.chatId})`));
      } catch (error) {
        console.error(errorLine(error.message));
      }
      return false;

    case "list": {
      const items = store.list();
      if (!items.length) console.log(infoLine("(no saved conversations)"));
      else console.log(items.map((i) => infoLine(`  ${i.name}  ·  ${i.turns} turns  ·  ${i.updatedAt || "?"}`)).join("\n"));
      return false;
    }

    case "delete":
      try { console.log(infoLine(`deleted ${store.remove(argStr)}`)); }
      catch (error) { console.error(errorLine(error.message)); }
      return false;

    case "history":
      if (!settings.messages.length) console.log(infoLine("(empty)"));
      else console.log(settings.messages.map((m) => `${style.dim(`${m.role}:`)} ${m.content}`).join("\n"));
      return false;

    case "clear":
      settings.messages = [];
      console.log(infoLine("history cleared (chatId kept)"));
      persist(settings);
      return false;

    case "retry": {
      const lastUser = [...settings.messages].reverse().find((m) => m.role === "user");
      if (!lastUser) { console.log(infoLine("nothing to retry")); return false; }
      if (settings.messages.at(-1)?.role === "assistant") settings.messages.pop();
      await runCompletion(settings);
      return false;
    }

    case "undo":
      if (settings.messages.at(-1)?.role === "assistant") settings.messages.pop();
      if (settings.messages.at(-1)?.role === "user") settings.messages.pop();
      console.log(infoLine("undone"));
      persist(settings);
      return false;

    case "tools":
      if (rest[0] === "list") {
        console.log(infoLine(`tool_choice: ${settings.toolChoice ? JSON.stringify(settings.toolChoice) : "(unset)"}`));
        console.log(infoLine(`custom tools: ${settings.customTools.map((t) => t.function?.name).join(", ") || "(none)"}`));
      } else if (["auto", "none", "required"].includes(argStr)) {
        settings.toolChoice = argStr;
        console.log(infoLine(`tool_choice = ${argStr}`));
        persist(settings);
      } else {
        console.log(errorLine("Usage: /tools <auto|none|required> | /tools list"));
      }
      return false;

    case "tool": {
      if (rest[0] === "clear") { settings.customTools = []; console.log(infoLine("custom tools cleared")); persist(settings); return false; }
      if (rest[0] === "add") {
        const json = argStr.slice(3).trim();
        try {
          const tool = JSON.parse(json);
          if (tool?.type !== "function" || typeof tool.function?.name !== "string") {
            throw new Error('Tool must be {"type":"function","function":{"name":...}}');
          }
          settings.customTools.push(tool);
          console.log(infoLine(`added tool ${tool.function.name}`));
          persist(settings);
        } catch (error) {
          console.error(errorLine(`Invalid tool: ${error.message}`));
        }
        return false;
      }
      console.log(errorLine("Usage: /tool add <json> | /tool clear"));
      return false;
    }

    case "health":
      try {
        const h = await health(settings);
        console.log(infoLine(JSON.stringify(h, null, 2)));
      } catch (error) {
        console.error(errorLine(error.message));
      }
      return false;

    default:
      console.log(infoLine(`Unknown command /${cmd}. Try /help.`));
      return false;
  }
}

// ---- Banner -------------------------------------------------------------

async function printBanner(settings) {
  console.log(style.bold(style.magenta("Sage Chat")) + style.dim(`  ·  ${settings.baseUrl}`));
  try {
    const h = await health(settings);
    const subsystems = Object.entries(h.memory || {})
      .map(([k, v]) => `${k}:${v?.status || "?"}`)
      .join(" ");
    console.log(infoLine(`health: ${h.status}${subsystems ? `  ·  ${subsystems}` : ""}`));
  } catch (error) {
    console.log(infoLine(`health: unavailable (${error.message})`));
  }
  console.log(infoLine(`model: ${settings.model || "(server default)"}  ·  /help for commands`));
}

// ---- REPL ---------------------------------------------------------------

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return;
  }
  const settings = buildSettings(flags);
  if (flags.load) {
    try { applyLoaded(settings, store.load(flags.load)); }
    catch (error) { console.error(errorLine(error.message)); }
  }
  if (flags.new) {
    settings.chatId = newChatId();
    settings.messages = [];
  }

  await printBanner(settings);

  const rl = readline.createInterface({ input: stdin, output: stdout });

  let questionAbort = null;
  let sigintArmed = false;
  let shouldExit = false;
  let closed = false;

  rl.on("close", () => {
    closed = true;
    if (questionAbort) questionAbort.abort();
  });

  rl.on("SIGINT", () => {
    if (currentAbort) {
      currentAbort.abort();
      return;
    }
    if (sigintArmed) {
      shouldExit = true;
      if (questionAbort) questionAbort.abort();
      return;
    }
    sigintArmed = true;
    stdout.write(`\n${infoLine("(press Ctrl+C again or /exit to quit)")}\n`);
    if (questionAbort) questionAbort.abort();
  });

  while (!shouldExit && !closed) {
    questionAbort = new AbortController();
    let line;
    try {
      line = await rl.question(youPrompt, { signal: questionAbort.signal });
    } catch (error) {
      if (error.code === "ERR_USE_AFTER_CLOSE" || closed) break; // EOF / Ctrl+D
      if (error.name === "AbortError") continue; // re-prompt after SIGINT
      throw error;
    } finally {
      questionAbort = null;
    }

    sigintArmed = false;
    line = line.trim();
    if (!line) continue;

    if (line.startsWith("/")) {
      shouldExit = await dispatch(settings, line);
      continue;
    }

    settings.messages.push({ role: "user", content: line });
    await runCompletion(settings);
  }

  rl.close();
  console.log(infoLine("bye."));
}

main().catch((error) => {
  console.error(errorLine(error.stack || error.message));
  process.exit(1);
});
