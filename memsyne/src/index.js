import fs from "fs";
import path from "path";
import readlineSync from "readline-sync";
import {
  setupMemory,
  generateReply,
  getRelevantMemories,
  storeInMemory,
  extractMemories,
} from "./core.js";
import { debug } from "./config.js";

// Magic string constants
const SEED_MODE_PROMPT = "Enter memory seed mode? (y/n): ";
const SEED_MODE_INPUT_PROMPT =
  "Enter some initial information about you to seed Sage's memory (or type 'skip' to skip): ";
const SEED_COMMAND = "skip";
const EXIT_COMMAND = "exit";
const SAVE_ON_EXIT_PROMPT = "Save conversation as (Leave empty to skip): ";
const OVERWRITE_PROMPT = "Conversation exists. Overwrite? (y/n): ";
const LOAD_STARTUP_PROMPT = "Load a saved conversation? (y/n): ";
const CONVERSATIONS_DIR = "conversations";
const CONVERSATION_EXT = ".json";
const CONVERSATION_VERSION = 1;
const VALID_ROLES = new Set(["user", "assistant"]);

let memoryInstance;
let _conversationHistory = []; // to store recent conversation history for context: [{ role: "user", content: "..." }, { role: "assistant", content: "..." }]

function loadConversationHistory(history) {
  _conversationHistory = Array.isArray(history) ? history : [];
}

function addToConversationHistory(role, content) {
  _conversationHistory.push({ role, content });
}

function clearConversationHistory() {
  _conversationHistory = [];
}

function getFullConversationHistory() {
  return _conversationHistory;
}

function getConversationHistory(slice_size = -8) {
  return _conversationHistory.slice(slice_size);
}

function ensureConversationsDir() {
  const conversationsPath = path.join(process.cwd(), CONVERSATIONS_DIR);
  if (!fs.existsSync(conversationsPath)) {
    fs.mkdirSync(conversationsPath, { recursive: true });
  }
  return conversationsPath;
}

function sanitizeConversationName(name) {
  return String(name ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ");
}

function getConversationFilePath(name) {
  return path.join(ensureConversationsDir(), `${name}${CONVERSATION_EXT}`);
}

function serializeConversation(name, history, existingMetadata = null) {
  const now = new Date().toISOString();
  return {
    version: CONVERSATION_VERSION,
    name,
    createdAt: existingMetadata?.createdAt || now,
    updatedAt: now,
    messages: history,
  };
}

function deserializeConversation(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Saved conversation file is not a valid JSON object.");
  }

  if (!Array.isArray(payload.messages)) {
    throw new Error("Saved conversation file is missing a messages array.");
  }

  const messages = payload.messages.filter(
    (message) =>
      message &&
      VALID_ROLES.has(message.role) &&
      typeof message.content === "string"
  );

  if (messages.length === 0) {
    throw new Error("Saved conversation file does not contain any valid messages.");
  }

  return {
    metadata: {
      version: payload.version ?? CONVERSATION_VERSION,
      name: typeof payload.name === "string" ? payload.name : "",
      createdAt:
        typeof payload.createdAt === "string" ? payload.createdAt : null,
      updatedAt:
        typeof payload.updatedAt === "string" ? payload.updatedAt : null,
    },
    messages,
  };
}

function listSavedConversations() {
  const conversationsPath = path.join(process.cwd(), CONVERSATIONS_DIR);
  if (!fs.existsSync(conversationsPath)) {
    return [];
  }

  return fs
    .readdirSync(conversationsPath)
    .filter((fileName) => fileName.endsWith(CONVERSATION_EXT))
    .map((fileName) => {
      const filePath = path.join(conversationsPath, fileName);
      const stats = fs.statSync(filePath);
      return {
        name: path.basename(fileName, CONVERSATION_EXT),
        filePath,
        updatedAt: stats.mtimeMs,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function printSavedConversations(conversations) {
  if (conversations.length === 0) {
    console.log("No saved conversations found.");
    return;
  }

  console.log("Saved conversations:");
  conversations.forEach((conversation, index) => {
    console.log(`${index + 1}. ${conversation.name}`);
  });
}

function readConversationFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const payload = JSON.parse(raw);
  return deserializeConversation(payload);
}

function loadConversationFromName(conversationName) {
  const sanitizedName = sanitizeConversationName(conversationName);
  if (!sanitizedName) {
    return {
      success: false,
      message: "Conversation name is invalid after sanitization.",
    };
  }

  try {
    const filePath = getConversationFilePath(sanitizedName);
    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        message: `No saved conversation named \"${sanitizedName}\" was found.`,
      };
    }

    const { messages } = readConversationFile(filePath);
    loadConversationHistory(messages);
    return {
      success: true,
      message: `Loaded conversation \"${sanitizedName}\" with ${messages.length} messages.`,
      messageCount: messages.length,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to load conversation \"${sanitizedName}\": ${err.message}`,
    };
  }
}

function saveConversation(conversationName) {
  const sanitizedName = sanitizeConversationName(conversationName);
  if (!sanitizedName) {
    return {
      success: false,
      skipped: true,
      message: "Conversation name is invalid after sanitization.",
    };
  }

  try {
    const filePath = getConversationFilePath(sanitizedName);
    let existingMetadata = null;

    if (fs.existsSync(filePath)) {
      const overwrite = readlineSync.question(OVERWRITE_PROMPT);
      if (overwrite.trim().toLowerCase() !== "y") {
        return {
          success: false,
          skipped: true,
          message: `Skipped saving conversation \"${sanitizedName}\".`,
        };
      }

      try {
        const existingConversation = readConversationFile(filePath);
        existingMetadata = existingConversation.metadata;
      } catch (err) {
        if (debug) {
          console.warn(
            `Existing conversation metadata could not be read for \"${sanitizedName}\": ${err.message}`
          );
        }
      }
    }

    const payload = serializeConversation(
      sanitizedName,
      getFullConversationHistory(),
      existingMetadata
    );
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");

    return {
      success: true,
      skipped: false,
      message: `Saved conversation \"${sanitizedName}\" to ${filePath}.`,
    };
  } catch (err) {
    return {
      success: false,
      skipped: false,
      message: `Failed to save conversation \"${sanitizedName}\": ${err.message}`,
    };
  }
}

function promptForConversationSelection(conversations) {
  const selection = readlineSync
    .question("Enter conversation number or name (Leave empty to cancel): ")
    .trim();

  if (!selection) {
    return null;
  }

  if (/^\d+$/.test(selection)) {
    const index = Number.parseInt(selection, 10) - 1;
    if (index >= 0 && index < conversations.length) {
      return conversations[index].name;
    }
    return null;
  }

  return selection;
}

function promptLoadConversationAtStartup() {
  const conversations = listSavedConversations();
  if (conversations.length === 0) {
    return;
  }

  printSavedConversations(conversations);
  const shouldLoad = readlineSync.question(LOAD_STARTUP_PROMPT);
  if (shouldLoad.trim().toLowerCase() !== "y") {
    return;
  }

  const selection = promptForConversationSelection(conversations);
  if (!selection) {
    console.log("No conversation loaded.");
    return;
  }

  const result = loadConversationFromName(selection);
  console.log(result.message);
}

function printCommandHelp() {
  console.log("Available commands:");
  console.log("/help - Show available commands");
  console.log("/sessions - List saved conversations");
  console.log("/save <name> - Save the current conversation");
  console.log("/load <name> - Load a saved conversation and replace current history");
  console.log("/clear - Clear the current in-memory conversation history");
  console.log(`Type \"${EXIT_COMMAND}\" to quit.`);
}

async function handleSlashCommand(input) {
  const trimmedInput = input.trim();
  const [command, ...rest] = trimmedInput.split(/\s+/);
  const argument = rest.join(" ").trim();

  switch (command.toLowerCase()) {
    case "/help":
      printCommandHelp();
      return true;
    case "/sessions": {
      printSavedConversations(listSavedConversations());
      return true;
    }
    case "/save": {
      if (!argument) {
        console.log("Usage: /save <name>");
        return true;
      }
      const result = saveConversation(argument);
      console.log(result.message);
      return true;
    }
    case "/load": {
      if (!argument) {
        console.log("Usage: /load <name>");
        return true;
      }
      const result = loadConversationFromName(argument);
      console.log(result.message);
      return true;
    }
    case "/clear":
      clearConversationHistory();
      console.log("Cleared current conversation history.");
      return true;
    default:
      console.log("Unknown command. Type /help for available commands.");
      return true;
  }
}

async function conversationFlow(userInput) {
  const recalled = await getRelevantMemories(userInput, debug);
  const agentReply = await generateReply(
    userInput,
    recalled,
    getConversationHistory()
  );
  addToConversationHistory("user", userInput);
  addToConversationHistory("assistant", agentReply);
  await performMemoryExtraction(userInput, agentReply); // We dont want to await this, since we don't want to block the conversation flow while we extract and store memories
  return agentReply;
}

async function performMemoryExtraction(userInput, agentReply) {
  try {
    // Extract and store memories from the conversation history (both user input and agent reply)
    const newMemories = await extractMemories(userInput, agentReply);
    for (const memory of newMemories) {
      const weightedImportance = memory.importance / 10;
      if (debug)
        console.log(
          `Extracted memory: ${memory.text}, importance: weightedImportance, category: ${memory.category} estimated event time: ${memory.eventTime}`
        );
      await storeInMemory(memory.text, memory.importance, memory.category);
    }
  } catch (err) {
    console.error("Error during memory extraction:", err.message);
  }
}

async function main() {
  try {
    let userInput, seedMemory, agentReply;

    console.log("Initializing memory...");
    memoryInstance = await setupMemory();

    userInput = readlineSync.question(SEED_MODE_PROMPT);
    seedMemory = userInput.toLowerCase() === "y";

    if (seedMemory) {
      console.log(
        "Entering memory seeding mode. Type 'skip' to finish seeding and move on to chat."
      );
      let done = false;
      while (!done) {
        userInput = readlineSync.question(SEED_MODE_INPUT_PROMPT);
        if (userInput.toLowerCase() === SEED_COMMAND) {
          done = true;
        } else {
          await storeInMemory(userInput);
          if (debug) console.log("Added seed memory: " + userInput);
        }
      }
      console.log("Finished seeding memory. Moving on to chat...");
    }

    promptLoadConversationAtStartup();

    console.log("Sage chatbot CLI ready! Type 'exit' to quit.");
    console.log("Type /help for conversation commands.");
    while (true) {
      userInput = readlineSync.question("You: ");
      if (userInput.toLowerCase() === EXIT_COMMAND) break;

      if (userInput.trim().startsWith("/")) {
        await handleSlashCommand(userInput);
        continue;
      }

      try {
        agentReply = await conversationFlow(userInput);
        console.log("Sage: " + agentReply);
      } catch (err) {
        console.error("Error during conversation:", err.message);
      }
    }

    const conversationName = readlineSync.question(SAVE_ON_EXIT_PROMPT);
    if (conversationName.trim() !== "") {
      const result = saveConversation(conversationName);
      console.log(result.message);
    }
    console.log("Goodbye.");
  } catch (err) {
    console.error("Fatal error in main:", err.message);
    process.exit(1);
  }
}

main().catch(console.error);
