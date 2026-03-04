function serializeChatCompletion(completion) {
  const plain = normalizeChatCompletion(completion);
  if (!plain.id) {
    plain.id = createSyntheticId("chatcmpl");
  }
  return plain;
}

function serializeChatCompletionChunk(chunk) {
  const plain = normalizeChatCompletionChunk(chunk);
  if (!plain.id) {
    plain.id = createSyntheticId("chatcmplchunk");
  }
  return plain;
}

function normalizeChatCompletion(completion) {
  if (!completion || typeof completion !== "object") {
    return {};
  }

  return {
    id: completion.id,
    object: completion.object || "chat.completion",
    created: completion.created,
    model: completion.model,
    system_fingerprint: completion.system_fingerprint,
    choices: Array.isArray(completion.choices)
      ? completion.choices.map((choice) => ({
          index: choice?.index ?? 0,
          message: normalizeMessage(choice?.message),
          logprobs: choice?.logprobs ?? null,
          finish_reason: choice?.finish_reason ?? null,
        }))
      : [],
    usage: completion.usage,
    service_tier: completion.service_tier,
  };
}

function normalizeChatCompletionChunk(chunk) {
  if (!chunk || typeof chunk !== "object") {
    return {};
  }

  return {
    id: chunk.id,
    object: chunk.object || "chat.completion.chunk",
    created: chunk.created,
    model: chunk.model,
    system_fingerprint: chunk.system_fingerprint,
    choices: Array.isArray(chunk.choices)
      ? chunk.choices.map((choice) => ({
          index: choice?.index ?? 0,
          delta: normalizeDelta(choice?.delta),
          logprobs: choice?.logprobs ?? null,
          finish_reason: choice?.finish_reason ?? null,
        }))
      : [],
    usage: chunk.usage,
  };
}

function normalizeMessage(message) {
  if (!message || typeof message !== "object") {
    return { role: "assistant", content: "" };
  }

  return {
    role: message.role || "assistant",
    content: message.content ?? "",
    refusal: message.refusal,
    tool_calls: message.tool_calls,
    tool_call_id: message.tool_call_id,
  };
}

function normalizeDelta(delta) {
  if (!delta || typeof delta !== "object") {
    return {};
  }

  return {
    role: delta.role,
    content: delta.content,
    refusal: delta.refusal,
    tool_calls: delta.tool_calls,
  };
}

function extractAssistantTextFromCompletion(completion) {
  return extractTextContent(completion?.choices?.[0]?.message?.content);
}

function extractAssistantTextFromChunk(chunk) {
  return (chunk?.choices || [])
    .map((choice) => extractTextContent(choice?.delta?.content))
    .join("");
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }

  return "";
}

import { createSyntheticId } from "../../utils/ids.js";

export {
  extractAssistantTextFromChunk,
  extractAssistantTextFromCompletion,
  extractTextContent,
  serializeChatCompletion,
  serializeChatCompletionChunk,
};
