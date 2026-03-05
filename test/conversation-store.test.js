import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";

import { createConversationStore } from "../src/services/conversation-store.js";

const logger = pino({ level: "silent" });

test("conversation store mirrors client history and appends assistant replies", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sage-conv-store-"));
  const store = createConversationStore({
    config: {
      memory: {
        conversationDbPath: path.join(tmpDir, "conversations.sqlite"),
      },
    },
    logger,
  });

  store.replaceConversationMessagesFromClient({
    conversationId: "conv-1",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Remember tea" },
    ],
  });

  assert.equal(store.getUaMessageCount("conv-1"), 3);
  assert.equal(store.getUaMessageByIndex({ conversationId: "conv-1", uaIndex: 2 }).content, "Remember tea");

  store.appendAssistantMessage({
    conversationId: "conv-1",
    content: "Noted.",
  });

  assert.equal(store.getUaMessageCount("conv-1"), 4);
  assert.equal(store.getUaMessageByIndex({ conversationId: "conv-1", uaIndex: 3 }).content, "Noted.");

  store.replaceConversationMessagesFromClient({
    conversationId: "conv-1",
    messages: [{ role: "user", content: "Edited history" }],
  });

  assert.equal(store.getUaMessageCount("conv-1"), 1);
  assert.equal(store.getUaMessageByIndex({ conversationId: "conv-1", uaIndex: 0 }).content, "Edited history");

  store.close();
});
