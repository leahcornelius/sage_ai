import { createMnemosyne } from "mnemosy-ai";
import OpenAI from "openai";
import { MNEMOSYNE_CONFIG, OPENAI_API_KEY, debug } from "./config.js";
import { printMemories } from "./helpers.js";
import { getActiveSystemPrompt } from "./sysPrompt.js";

let openai;
let m;

try {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
} catch (err) {
  console.error("Failed to initialize OpenAI client:", err.message);
  process.exit(1);
}

async function setupMemory() {
  try {
    m = await createMnemosyne(MNEMOSYNE_CONFIG);
    return m;
  } catch (err) {
    console.error("Failed to initialize Mnemosyne memory system:", err.message);
    throw err;
  }
}


async function getLLMCompletion(parameters, allowEmptyResponse = false) {
  try {
    const completion = await openai.chat.completions.create(parameters);
    if (debug) {
      console.log("Raw OpenAI response:", completion);
    }

    // safely extract content
    let reply = "";
    if (
      completion &&
      Array.isArray(completion.choices) &&
      completion.choices.length > 0
    ) {
      const choice = completion.choices[0];
      if (
        choice &&
        choice.message &&
        typeof choice.message.content === "string"
      ) {
        reply = choice.message.content;
      } else if (choice && typeof choice.text === "string") {
        // fallback for models returning `.text`
        reply = choice.text;
      }
    }

    if (!reply && !allowEmptyResponse) {
      console.warn(
        "OpenAI produced no content in response, returning empty string. Full object:",
        completion
      );
    }
    return reply;
  } catch (err) {
    console.error("Error generating OpenAI reply:", err.message);
    throw err;
  }
}

// Generate Sage reply using OpenAI + retrieved memory
// userInput: (string), the latest user message
// memories: (array of memory objects), the relevant memories retrieved based on the user input
// conversationHistory: (array of message objects), the recent conversation history to provide additional context
async function generateReply(userInput, memories, conversationHistory = []) {
  // Build memory context text
  const memoryContext = memories
    .map(
      (m, i) =>
        `Recalled memory #${i + 1} - (${new Date(
          m.entry.ingestedAt
        ).toLocaleString()}, ${new Date(m.entry.updatedAt).toLocaleString()}, ${
          m.entry.confidenceTag
        }, ${m.entry.memoryType}, ${m.entry.decayStatus}): ${m.entry.text}`
    )
    .join("\n");

  const systemPromptBase = getActiveSystemPrompt();

  let messages = [
    { role: "system", content: systemPromptBase },
    { role: "system", content: "Current Date: " + new Date().toISOString() },
    { role: "system", content: "Active Tools: none" }, // placeholder for now, eventually will pull from config or agent state
    {
      role: "system",
      content:
        "Memory context:\n Recalled memory # - (createdAt, updatedAt, confidenceTag, memoryType, decayStatus): memoryContent\n" +
        memoryContext,
    },
    ...conversationHistory,
    { role: "user", content: userInput },
  ];

  let response = await getLLMCompletion({
    model: "gpt-5.2",
    messages,
  });
  return response;
}

async function getRelevantMemories(query, printResults = false) {
  try {
    const recalled = await m.recall({ query, topK: 5 });
    if (printResults) {
      printMemories(recalled, query);
    }
    return recalled;
  } catch (err) {
    console.error("Error retrieving memories:", err.message);
    throw err;
  }
}

async function storeInMemory(
  text,
  importance = null,
  category = null,
  eventTime = null
) {
  if (!text) return;
  // Argument is an object containing:
  // text (string, required): the text content of the memory
  // importance (number, optional): a score indicating the importance of the memory (higher means more important)
  // category (string, optional): a category label for the memory (e.g. "personal", "work", "hobby")
  // eventTime (Date or timestamp, optional): when the event described by the memory occurred
  try {
    const memoryObject = {
      text,
      ...(importance !== null && { importance }),
      ...(category !== null && { category }),
      ...(eventTime !== null && { eventTime }),
    };
    if (debug) console.log("Storing in memory:", memoryObject);
    await m.store(memoryObject);
  } catch (err) {
    console.error("Error storing memory:", err.message);
    throw err;
  }
}

async function extractMemories(userMsg, assistantMsg) {
  const prompt = `
Evaluate whether the following conversation contains information worth storing in long-term memory.
The assistant may be refered to as "Sage". 
Only store information that is:
- persistent
- about the user
- about the assistant/sage itself
- useful in future conversations
- useful for improving the assistant's understanding of the user's or its own preferences, personality, or context

Score importance from 1 to 10. Importance should be higher for information that is more likely to be useful in future conversations, and lower for information that is less likely to be useful. 
Return JSON containing the extracted memories. You should rewrite the memories in a more concise and useful format where possible.
Each individual memory should be no more than 1-2 sentences and reflect a single piece of information.
If a piece of information is repeated across multiple messages, only return it once. If the conversation contains no information worth remembering, return an empty array.
JSON format:
[
  {
    "text": "the content of the memory, rewritten in a concise and useful format where possible",
    "importance": importance_score_from_1_to_10,
    "category": "a category label for the memory (e.g. personal, work, hobby, etc.)",
    "eventTime": "an ISO timestamp for when the event described by the memory occurred, if applicable"
    },
    ...
]
    The current time is ${new Date().toLocaleString()}
`;
 const conversation = `Conversation:
User: ${userMsg}
Sage: ${assistantMsg}
`;
  let messages = [
    { role: "system", content: prompt },
    { role: "system", content: conversation },
    
  ]
  const res = await getLLMCompletion({
    model: "gpt-5.2",
    messages
  }, true);

  if (debug) {
    console.log("LLM response for memory extraction:", res);
  }
  if (!res) {
    console.warn("LLM returned empty response for memory extraction, returning empty array");
    return [];
  }

  let extractedMemories = [];
  try {
    extractedMemories = JSON.parse(res);
  } catch (err) {
    console.error("Error parsing extracted memories JSON:", err.message);
    console.error("LLM response that failed to parse:", res);
  }
  return extractedMemories;
}

export { setupMemory, generateReply, getRelevantMemories, storeInMemory , extractMemories };
