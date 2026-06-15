// Local clean-fact extraction adapter (Experiment 5).
//
// A $0, local replacement for the dead cloud-mem0 extraction path. Per turn, it
// asks a LOCAL model (qwen3:14b via Ollama, temperature 0, fixed seed) to extract
// distinct atomic facts, PRESERVING any codes/identifiers/values VERBATIM, and
// returns them in the shape `upsertSemanticFacts` consumes. mem0 stays OFF; this
// adapter is gated by its own flag (SAGE_CLEANFACT_ENABLED) so the bench can turn
// it on without re-enabling cloud mem0. Same interface as the mem0 adapter:
// { enabled, extractFacts, ping }.
//
// Stored downstream as CLEAN, scope-tagged, raw (un-merged) Qdrant points by the
// rewritten upsertSemanticFacts (clean-fact hygiene; D3.1 resolved). The clean
// fact's distinct vector is the mechanism that *might* surface buried gold the raw
// homogeneous episodic turns cannot — or honestly might not (that is the experiment).

import crypto from "node:crypto";

import { createOllamaChat } from "./ollama-chat.js";

// Fixed extraction prompt. Verbatim-preservation is load-bearing: the buried-gold
// benchmark scores on opaque marker strings, so a paraphrased/dropped code = a miss.
const EXTRACTION_SYSTEM = [
  "You extract distinct atomic facts from a SINGLE conversation turn for a memory system.",
  "Output ONLY JSON of the form: {\"facts\": [{\"fact_text\": \"...\"}]}",
  "Rules:",
  "- One fact per item; no duplication; each fact is a single self-contained statement.",
  "- PRESERVE every code, identifier, name, number, date and value EXACTLY (verbatim, character-for-character) as it appears in the turn. NEVER paraphrase, normalize, or alter a code/ID/value.",
  "- Make each fact stand alone: include the entity/subject it is about (e.g. \"The route code for the Crimson Falcon yard is Z8VAG0RP\").",
  "- If the turn has no durable fact (greeting, filler, a question with no asserted fact), output {\"facts\": []}.",
  "- Do not invent facts that are not present in the turn.",
  "/no_think",
].join("\n");

function hashFact(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createLocalExtractorAdapter({ config, logger }) {
  const adapterLogger = logger.child({ component: "local-extractor-adapter" });
  const cf = (config.memory && config.memory.cleanFact) || {};
  const enabled =
    Boolean(config.memory && config.memory.cleanFactEnabled) &&
    config.memory.mode !== "off";

  const chat = enabled
    ? createOllamaChat({
        baseUrl: cf.ollamaUrl,
        model: cf.model,
        temperature: cf.temperature ?? 0,
        seed: cf.seed ?? 7,
        timeoutMs: cf.timeoutMs ?? 30000,
      })
    : null;

  async function extractFacts({
    scopeKey,
    conversationId,
    role,
    messageText,
    messageId,
    timestamp,
  }) {
    if (!enabled || !chat || !messageText || !messageText.trim()) {
      return [];
    }

    let parsed;
    try {
      const r = await chat.chatJson({
        system: EXTRACTION_SYSTEM,
        user: `Turn:\n${messageText}`,
      });
      parsed = r.parsed;
    } catch (error) {
      adapterLogger.warn({ err: error, scopeKey }, "local clean-fact extraction failed");
      return [];
    }

    const rawFacts = Array.isArray(parsed?.facts)
      ? parsed.facts
      : Array.isArray(parsed)
        ? parsed
        : [];

    const out = [];
    const seen = new Set();
    const now = new Date().toISOString();
    for (const f of rawFacts) {
      const text =
        typeof f?.fact_text === "string"
          ? f.fact_text.trim()
          : typeof f === "string"
            ? f.trim()
            : "";
      if (!text) continue;
      const dedupKey = text.toLowerCase();
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const factKey = hashFact(`${scopeKey}|${dedupKey}`);
      out.push({
        factId: factKey,
        factKey,
        version: 1,
        status: "active",
        subject: scopeKey,
        predicate: "FACT",
        object: text,
        text,
        confidence: null,
        category: "fact",
        eventTime: timestamp || null,
        scopeKey,
        role,
        conversationId,
        messageText,
        messageId,
        sourceMessageId: messageId,
        sourceTurnIds: messageId ? [messageId] : [],
        ingestedAt: now,
        metadata: { source: "local-cleanfact" },
      });
    }
    return out;
  }

  async function ping() {
    if (!enabled || !chat) {
      return "DISABLED";
    }
    try {
      return await chat.ping();
    } catch {
      return "ERROR";
    }
  }

  return { enabled, extractFacts, ping };
}

export { createLocalExtractorAdapter, EXTRACTION_SYSTEM };
