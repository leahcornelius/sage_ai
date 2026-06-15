// Synthetic, seeded benchmark generator — V0.2 "semantic-stress" edition (spec §3).
//
// What changed from V0.1 (machinery-proof): the V0.1 benchmark was semantically
// vacuous — every gold resolved from the 20-turn episodic ring buffer, so durable
// Qdrant semantic search was never tested. V0.2:
//   - BURY MECHANIC: each gold is planted early then buried under >=25 later turns
//     so it falls out of the 20-turn episodic window and can only come from
//     semantic recall. Hard invariant asserted before population.
//   - CROSS-SCOPE DISTRACTORS: each gold attribute gets near-lookalikes in OTHER
//     scopes so UNFILTERED semantic recall surfaces the wrong scope's answer
//     (this is what makes the P1 scope-filter A/B measurable).
//   - PARAPHRASE GAP: a local Qwen3-14B writes the naturalistic fact carrier and a
//     differently-worded question so lexical matching fails and embeddings must work.
// Code owns everything that affects scoring (markers, placement, exact-match);
// the model is a content source, never trusted raw — every generated string is
// validated (forbidden words, marker verbatim, paraphrase gap) with bounded
// regeneration and a deterministic-template fallback (fail-closed if too many fall back).

import { Rng } from "./lib/rng.js";
import { isForbidden, assertNoForbidden } from "./lib/forbidden.js";
import { OllamaClient, cosine } from "./lib/ollama.js";

const MARKER_LEN = 8;
const BURY_MARGIN = 25; // turns of burial past the 20-turn episodic window (with margin)
const TARGET_SCOPE_SIZE = 50; // ~50 facts/scope (>> the 20-turn ring buffer)
const CROSS_SCOPE_DISTRACTORS = 2; // lean low so baseline (unfiltered, top-5) can still surface gold
const JACCARD_MIN = 0.1; // question must stay on-topic
const JACCARD_MAX = 0.45; // ...but not lexically solvable (forces embedding retrieval)
const COSINE_FLOOR = 0.5; // advisory: question/gold embedding similarity (recorded, not blocking)
const REGEN_ATTEMPTS = 5;
const FALLBACK_HARD_FAIL_RATE = 0.2; // > this share of items falling back to templates => hard-fail

// Forbidden-word-safe vocabulary. (Validated again at the end anyway.)
const ADJECTIVES = [
  "Amber", "Cobalt", "Crimson", "Jade", "Onyx", "Saffron",
  "Teal", "Indigo", "Ember", "Slate", "Maroon", "Olive",
];
const NOUNS = [
  "Falcon", "Otter", "Bison", "Lynx", "Heron", "Marten",
  "Ibex", "Stork", "Walrus", "Badger", "Puffin", "Tapir",
];
const SUFFIXES = ["depot", "hub", "yard", "annex", "wharf"];
// None of these contain secret/password/token/api key/card/ssn.
const ATTRIBUTES = [
  "access code", "region code", "locker label", "route code",
  "shelf marker", "badge colour code", "dock number", "aisle marker",
  "bay label", "crate label", "pallet marker", "berth code",
];
// Filler topics deliberately AVOID the answer-attribute phrasing so within-scope
// filler buries by recency without out-competing the in-scope gold under scopeFilter.
const FILLER_TOPICS = [
  "the duty supervisor name", "the inspection weekday", "the coffee supplier",
  "the parking lot colour", "the fire-drill month", "the recycling pickup day",
  "the visitor lanyard colour", "the lunch rota lead", "the noticeboard location",
  "the staff entrance side", "the cleaning contractor", "the plant watering day",
];

// ---------------------------------------------------------------- text helpers

function tokenize(s) {
  return String(s || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// Marker must appear exactly once, not embedded inside a larger alphanumeric token.
function markerOnceWithBoundary(text, marker) {
  const re = new RegExp(`(^|[^0-9A-Za-z])${marker}([^0-9A-Za-z]|$)`, "g");
  const matches = String(text).match(re);
  return Boolean(matches) && matches.length === 1;
}

function containsVerbatim(text, needle) {
  return String(text || "").includes(needle);
}

// ---------------------------------------------------------------- pools

function buildEntityPool(rng) {
  const pool = [];
  for (const a of ADJECTIVES) {
    for (const n of NOUNS) {
      for (const s of SUFFIXES) {
        pool.push(`${a} ${n} ${s}`);
      }
    }
  }
  return rng.shuffle(pool);
}

function makeDrawer(items) {
  let i = 0;
  return () => {
    if (i >= items.length) {
      throw new Error("entity/attribute pool exhausted; reduce set sizes");
    }
    return items[i++];
  };
}

function uniqueMarker(rng, markerSet) {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const m = rng.marker(MARKER_LEN, isForbidden);
    if (!markerSet.has(m)) {
      markerSet.add(m);
      return m;
    }
  }
  throw new Error("uniqueMarker(): exhausted attempts");
}

// ---------------------------------------------------------------- templates (fallback + abstention)

const tplFact = (attr, entity, marker) => `The ${attr} for the ${entity} is ${marker}.`;
const tplStale = (attr, entity, marker) => `Until recently, the ${attr} for the ${entity} was ${marker}.`;
const tplNew = (attr, entity, marker) => `Update: the current ${attr} for the ${entity} is now ${marker}.`;
const tplQuestion = (attr, entity) => `What is the ${attr} for the ${entity}?`;
const tplTemporalQuestion = (attr, entity) => `What is the current ${attr} for the ${entity}?`;
const tplFiller = (topic, entity, marker) => `For the ${entity}, ${topic} is recorded as ${marker}.`;

// ---------------------------------------------------------------- Qwen content (validated)

// Generate a single fact carrier + a paraphrased question for (entity, attr, marker).
// `frame` selects fact phrasing: "plain" | "stale" | "new". Returns validated
// { fact, question, paraphrased } with deterministic-template fallback on failure.
async function genFactQuestion(ollama, {
  entity, attr, marker, frame = "plain", temporalQuestion = false, seed,
}) {
  const factTpl =
    frame === "stale" ? tplStale : frame === "new" ? tplNew : tplFact;
  const qTpl = temporalQuestion ? tplTemporalQuestion : tplQuestion;
  const fallback = {
    fact: factTpl(attr, entity, marker),
    question: qTpl(attr, entity),
    paraphrased: false,
  };
  if (!ollama) return fallback;

  const frameHint =
    frame === "stale"
      ? `Phrase the fact as a PAST/superseded value (e.g. "used to be", "previously").`
      : frame === "new"
        ? `Phrase the fact as the CURRENT/updated value (e.g. "now", "as of the latest update").`
        : `Phrase the fact as a plain current statement.`;

  for (let attempt = 0; attempt < REGEN_ATTEMPTS; attempt += 1) {
    let parsed;
    try {
      const res = await ollama.chatJson({
        temperature: 0.4,
        seed: seed !== undefined ? seed + attempt : undefined,
        messages: [{
          role: "user",
          content:
            `/no_think You write one item for a synthetic memory benchmark. Return ONLY a JSON object.\n` +
            `ENTITY (use verbatim, exactly as written): "${entity}"\n` +
            `ATTRIBUTE (the thing being recorded): "${attr}"\n` +
            `CODE (an opaque identifier): "${marker}"\n\n` +
            `JSON shape: {"fact": string, "question": string}\n` +
            `Rules:\n` +
            `- "fact": one natural sentence stating that the ${attr} of the ${entity} is ${marker}. ` +
            `${frameHint} Include the ENTITY name verbatim. Include the CODE "${marker}" EXACTLY once, verbatim.\n` +
            `- "question": a natural question asking for that same ${attr} of the same ${entity}. ` +
            `Include the ENTITY name verbatim. DO NOT include the CODE. ` +
            `Word it DIFFERENTLY from the fact — paraphrase the attribute and sentence frame so they share few words besides the entity name.\n` +
            `- No words: secret, password, token, api key, card, ssn.\n` +
            `Output ONLY the JSON object, no preamble.`,
        }],
      });
      parsed = res.parsed;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed.fact !== "string" || typeof parsed.question !== "string") {
      continue;
    }
    const fact = parsed.fact.trim();
    const question = parsed.question.trim();
    const ok =
      markerOnceWithBoundary(fact, marker) &&
      !containsVerbatim(question, marker) &&
      containsVerbatim(fact, entity) &&
      containsVerbatim(question, entity) &&
      !isForbidden(fact) &&
      !isForbidden(question);
    if (!ok) continue;
    const j = jaccard(question, fact);
    if (j < JACCARD_MIN || j > JACCARD_MAX) continue;
    return { fact, question, paraphrased: true, jaccard: j };
  }
  return fallback;
}

// Batched naturalistic filler (non-gold turns; provide burial + semantic noise).
// Each filler carries a unique code so it resembles a real fact in the store.
async function genFillerBatch(ollama, { entity, items, seed }) {
  // items: [{ topic, marker }]
  const fallback = items.map((it) => ({
    text: tplFiller(it.topic, entity, it.marker),
    marker: it.marker,
    paraphrased: false,
  }));
  if (!ollama || items.length === 0) return fallback;
  let parsed;
  try {
    const res = await ollama.chatJson({
      temperature: 0.5,
      seed,
      messages: [{
        role: "user",
        content:
          `/no_think Write short natural log lines for the site "${entity}". ` +
          `Return ONLY a JSON object of the form {"items": [{"i": <int>, "text": <string>}, ...]}.\n` +
          `Each input item has fields {i, topic, code}. For each, produce one output with the same "i" and ` +
          `"text" = one natural sentence stating that the item's "topic" for the site is the item's "code".\n` +
          `Include the site name "${entity}" verbatim and the code verbatim, exactly once each. Vary phrasing.\n` +
          `No words: secret, password, token, api key, card, ssn.\n` +
          `Items: ` +
          JSON.stringify(items.map((it, i) => ({ i, topic: it.topic, code: it.marker }))) +
          `\nOutput ONLY the JSON object.`,
      }],
    });
    parsed = res.parsed;
  } catch {
    parsed = null;
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(rows)) return fallback;
  const byIndex = new Map();
  for (const row of rows) {
    if (row && Number.isInteger(row.i) && typeof row.text === "string") {
      byIndex.set(row.i, row.text.trim());
    }
  }
  return items.map((it, i) => {
    const text = byIndex.get(i);
    if (
      text &&
      markerOnceWithBoundary(text, it.marker) &&
      containsVerbatim(text, entity) &&
      !isForbidden(text)
    ) {
      return { text, marker: it.marker, paraphrased: true };
    }
    return { text: tplFiller(it.topic, entity, it.marker), marker: it.marker, paraphrased: false };
  });
}

// Batched cross-scope distractors (same attribute, different entity => near-lookalike).
async function genDistractorBatch(ollama, { items, seed }) {
  // items: [{ attr, entity, marker }]
  const fallback = items.map((it) => ({
    text: tplFact(it.attr, it.entity, it.marker),
    marker: it.marker,
    paraphrased: false,
  }));
  if (!ollama || items.length === 0) return fallback;
  let parsed;
  try {
    const res = await ollama.chatJson({
      temperature: 0.5,
      seed,
      messages: [{
        role: "user",
        content:
          `/no_think Write natural statements. ` +
          `Return ONLY a JSON object of the form {"items": [{"i": <int>, "text": <string>}, ...]}.\n` +
          `Each input item has fields {i, attr, entity, code}. For each, produce one output with the same "i" and ` +
          `"text" = one natural sentence stating that the item's "attr" of the item's "entity" is the item's "code".\n` +
          `Include the entity name verbatim and the code verbatim exactly once each. Vary phrasing.\n` +
          `No words: secret, password, token, api key, card, ssn.\n` +
          `Items: ` +
          JSON.stringify(items.map((it, i) => ({ i, attr: it.attr, entity: it.entity, code: it.marker }))) +
          `\nOutput ONLY the JSON object.`,
      }],
    });
    parsed = res.parsed;
  } catch {
    parsed = null;
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(rows)) return fallback;
  const byIndex = new Map();
  for (const row of rows) {
    if (row && Number.isInteger(row.i) && typeof row.text === "string") {
      byIndex.set(row.i, row.text.trim());
    }
  }
  return items.map((it, i) => {
    const text = byIndex.get(i);
    if (
      text &&
      markerOnceWithBoundary(text, it.marker) &&
      containsVerbatim(text, it.entity) &&
      !isForbidden(text)
    ) {
      return { text, marker: it.marker, paraphrased: true };
    }
    return { text: tplFact(it.attr, it.entity, it.marker), marker: it.marker, paraphrased: false };
  });
}

// ---------------------------------------------------------------- set builder

function pickTwoAttrs(rng) {
  const a = rng.choice(ATTRIBUTES);
  let b = rng.choice(ATTRIBUTES);
  let guard = 0;
  while (b === a && guard++ < 16) b = rng.choice(ATTRIBUTES);
  return [a, b];
}

/**
 * Build one labelled set (dev or held-out): scopeCount scopes, each with a mix of
 * questions whose gold is buried under filler + cross-scope distractors.
 */
async function buildSet({
  rng, label, scopePrefix, scopeCount, mix, markerSet, entityDraw, ollama, stats, seedBase,
}) {
  const scopes = Array.from({ length: scopeCount }, (_, i) => `${scopePrefix}_${i}`);
  const questions = [];
  const earlyByScope = new Map(scopes.map((s) => [s, []])); // gold/stale facts (planted early)
  const lateByScope = new Map(scopes.map((s) => [s, []])); // filler + received distractors
  const goldDescriptors = []; // for cross-scope distractor planting
  let seed = seedBase;

  const pushEarly = (scope, fact) => earlyByScope.get(scope).push(fact);
  // The paraphrase-gap hard-fail is measured on GOLD items (fact+question pairs);
  // filler/distractor noise is fine as templates and only tracked for reporting.
  const countGold = (paraphrased) => {
    stats.gold.items += 1;
    if (!paraphrased) stats.gold.fallbacks += 1;
  };
  const countNoise = (paraphrased) => {
    stats.noise.items += 1;
    if (!paraphrased) stats.noise.fallbacks += 1;
  };

  // ---- questions + gold facts (early band) ----
  for (let s = 0; s < scopeCount; s += 1) {
    const scope = scopes[s];
    for (let i = 0; i < mix.single; i += 1) {
      const entity = entityDraw();
      const attr = rng.choice(ATTRIBUTES);
      const marker = uniqueMarker(rng, markerSet);
      const g = await genFactQuestion(ollama, { entity, attr, marker, seed: (seed += 7) });
      countGold(g.paraphrased);
      pushEarly(scope, { text: g.fact, marker, kind: "gold" });
      goldDescriptors.push({ scope, attr, entity, marker });
      questions.push({
        id: `${label}-single-${s}-${i}`, type: "single", scope,
        query: g.question, requiredMarkers: [marker], forbiddenMarkers: [], paraphrased: g.paraphrased,
      });
    }
    for (let i = 0; i < mix.multi; i += 1) {
      const entity = entityDraw();
      const [attr1, attr2] = pickTwoAttrs(rng);
      const m1 = uniqueMarker(rng, markerSet);
      const m2 = uniqueMarker(rng, markerSet);
      const g1 = await genFactQuestion(ollama, { entity, attr: attr1, marker: m1, seed: (seed += 7) });
      const g2 = await genFactQuestion(ollama, { entity, attr: attr2, marker: m2, seed: (seed += 7) });
      countGold(g1.paraphrased); countGold(g2.paraphrased);
      pushEarly(scope, { text: g1.fact, marker: m1, kind: "gold" });
      pushEarly(scope, { text: g2.fact, marker: m2, kind: "gold" });
      goldDescriptors.push({ scope, attr: attr1, entity, marker: m1 });
      goldDescriptors.push({ scope, attr: attr2, entity, marker: m2 });
      // Question combines both attributes; keep entity verbatim (paraphrase the frame).
      questions.push({
        id: `${label}-multi-${s}-${i}`, type: "multi", scope,
        query: `For the ${entity}, what are the ${attr1} and the ${attr2}?`,
        requiredMarkers: [m1, m2], forbiddenMarkers: [], paraphrased: g1.paraphrased && g2.paraphrased,
      });
    }
    for (let i = 0; i < mix.temporal; i += 1) {
      const entity = entityDraw();
      const attr = rng.choice(ATTRIBUTES);
      const mOld = uniqueMarker(rng, markerSet);
      const mNew = uniqueMarker(rng, markerSet);
      const gOld = await genFactQuestion(ollama, { entity, attr, marker: mOld, frame: "stale", seed: (seed += 7) });
      const gNew = await genFactQuestion(ollama, { entity, attr, marker: mNew, frame: "new", temporalQuestion: true, seed: (seed += 7) });
      countGold(gOld.paraphrased); countGold(gNew.paraphrased);
      pushEarly(scope, { text: gOld.fact, marker: mOld, kind: "stale" });
      pushEarly(scope, { text: gNew.fact, marker: mNew, kind: "gold" });
      // both old (forbidden) and new (required) must be buried — they are in early band
      goldDescriptors.push({ scope, attr, entity, marker: mNew });
      questions.push({
        id: `${label}-temporal-${s}-${i}`, type: "temporal", scope,
        query: gNew.question, requiredMarkers: [mNew], forbiddenMarkers: [mOld], paraphrased: gNew.paraphrased,
      });
    }
    for (let i = 0; i < mix.abstention; i += 1) {
      const entity = entityDraw();
      const attr = rng.choice(ATTRIBUTES);
      questions.push({
        id: `${label}-abstain-${s}-${i}`, type: "abstention", scope,
        query: tplQuestion(attr, entity), requiredMarkers: [], forbiddenMarkers: [], paraphrased: false,
      });
    }
  }

  // ---- cross-scope distractors (near-lookalikes in OTHER scopes of the same set) ----
  const distractorsByScope = new Map(scopes.map((s) => [s, []]));
  for (const gd of goldDescriptors) {
    const others = scopes.filter((s) => s !== gd.scope);
    const targets = rng.shuffle(others).slice(0, Math.min(CROSS_SCOPE_DISTRACTORS, others.length));
    for (const t of targets) {
      const e = entityDraw();
      const m = uniqueMarker(rng, markerSet);
      distractorsByScope.get(t).push({ attr: gd.attr, entity: e, marker: m });
    }
  }
  for (const scope of scopes) {
    const items = distractorsByScope.get(scope);
    const produced = await genDistractorBatch(ollama, { items, seed: (seed += 11) });
    for (const p of produced) {
      countNoise(p.paraphrased);
      lateByScope.get(scope).push({ text: p.text, marker: p.marker, kind: "distractor" });
    }
  }

  // ---- filler to reach target size AND guarantee burial depth ----
  for (let s = 0; s < scopeCount; s += 1) {
    const scope = scopes[s];
    const goldCount = earlyByScope.get(scope).length;
    const received = lateByScope.get(scope).length;
    // late band must be >= BURY_MARGIN (so maxGoldTurn <= lastTurn - BURY_MARGIN),
    // and we aim for ~TARGET_SCOPE_SIZE total turns.
    const lateNeeded = Math.max(BURY_MARGIN + 3, TARGET_SCOPE_SIZE - goldCount);
    const fillerCount = Math.max(0, lateNeeded - received);
    const entity = entityDraw();
    const items = [];
    for (let k = 0; k < fillerCount; k += 1) {
      items.push({ topic: rng.choice(FILLER_TOPICS), marker: uniqueMarker(rng, markerSet) });
    }
    const produced = await genFillerBatch(ollama, { entity, items, seed: (seed += 11) });
    for (const p of produced) {
      countNoise(p.paraphrased);
      lateByScope.get(scope).push({ text: p.text, marker: p.marker, kind: "filler" });
    }
  }

  // ---- assign turns (gold early, noise late) + build ingests ----
  const ingests = [];
  const SESSION_TURNS = 10;
  for (const scope of scopes) {
    const early = earlyByScope.get(scope);
    const late = rng.shuffle(lateByScope.get(scope));
    const ordered = [...early, ...late];
    ordered.forEach((fact, turnIndex) => {
      const session = Math.floor(turnIndex / SESSION_TURNS) + 1;
      ingests.push({
        scope,
        conversationId: `${scope}__s${session}`,
        turnIndex,
        text: fact.text,
        marker: fact.marker,
        kind: fact.kind,
      });
    });
  }

  return { scopes, questions, ingests };
}

// ---------------------------------------------------------------- gate fixtures

// Gate 2 (semanticTopK): gold competes with many same-attribute distractors so it
// is unlikely to be rank-1 — K=1 vs K=30 differ. (Templated; deterministic.)
function buildGate2Fixture({ rng, scopePrefix, markerSet, entityDraw, distractors = 12 }) {
  const scope = `${scopePrefix}_gate2`;
  const attr = "access code";
  const entity = entityDraw();
  const gold = uniqueMarker(rng, markerSet);
  const ingests = [];
  let turn = 0;
  const add = (text, marker, kind) =>
    ingests.push({ scope, conversationId: `${scope}__s1`, turnIndex: turn++, text, marker, kind });
  add(tplFact(attr, entity, gold), gold, "gold");
  for (let i = 0; i < distractors; i += 1) {
    const e = entityDraw();
    const m = uniqueMarker(rng, markerSet);
    add(tplFact(attr, e, m), m, "distractor");
  }
  return {
    scope,
    question: {
      id: "gate2-fixture", type: "single", scope,
      query: tplQuestion(attr, entity), requiredMarkers: [gold], forbiddenMarkers: [],
    },
    ingests,
  };
}

// Gate 2 (scopeFilter): an in-scope gold plus same-attribute lookalikes in a SECOND
// scope, so toggling scopeFilter changes the returned semantic ids. (Templated.)
function buildScopeFilterFixture({ rng, scopePrefix, markerSet, entityDraw, lookalikes = 6 }) {
  const scopeA = `${scopePrefix}_sfa`; // requesting scope (holds the gold)
  const scopeB = `${scopePrefix}_sfb`; // other scope (holds same-attribute lookalikes)
  const attr = "berth code";
  const entity = entityDraw();
  const gold = uniqueMarker(rng, markerSet);
  const ingests = [];
  const addTo = (scope, idx, text, marker, kind) =>
    ingests.push({ scope, conversationId: `${scope}__s1`, turnIndex: idx, text, marker, kind });
  addTo(scopeA, 0, tplFact(attr, entity, gold), gold, "gold");
  for (let i = 0; i < lookalikes; i += 1) {
    const e = entityDraw();
    const m = uniqueMarker(rng, markerSet);
    addTo(scopeB, i, tplFact(attr, e, m), m, "distractor");
  }
  return {
    scopes: [scopeA, scopeB],
    question: {
      id: "scopefilter-fixture", type: "single", scope: scopeA,
      query: tplQuestion(attr, entity), requiredMarkers: [gold], forbiddenMarkers: [],
    },
    ingests,
  };
}

// ---------------------------------------------------------------- offline preview

// Approximate the baseline (unfiltered, vector) retrieval offline so Gate 1b
// outcomes can be diagnosed without launching: for each scored question, rank its
// gold fact among ALL facts (unscoped) and among in-scope facts (scoped preview).
async function offlinePreview(ollama, dataset) {
  if (!ollama) return { skipped: "no ollama" };
  const facts = dataset.ingests;
  const factTexts = facts.map((f) => f.text);
  const scored = [...dataset.dev, ...dataset.heldout].filter(
    (q) => q.type !== "abstention" && q.requiredMarkers.length > 0
  );
  // batch-embed facts then questions
  const factVecs = [];
  const B = 64;
  for (let i = 0; i < factTexts.length; i += B) {
    const v = await ollama.embed({ input: factTexts.slice(i, i + B) });
    factVecs.push(...v);
  }
  const qVecs = [];
  for (let i = 0; i < scored.length; i += B) {
    const v = await ollama.embed({ input: scored.slice(i, i + B).map((q) => q.query) });
    qVecs.push(...v);
  }
  const factOfMarker = new Map();
  facts.forEach((f, idx) => { if (f.marker) factOfMarker.set(f.marker, idx); });

  let within5Unscoped = 0;
  let within5Scoped = 0;
  let n = 0;
  const sims = [];
  scored.forEach((q, qi) => {
    const goldIdx = factOfMarker.get(q.requiredMarkers[0]);
    if (goldIdx === undefined) return;
    const qv = qVecs[qi];
    const goldSim = cosine(qv, factVecs[goldIdx]);
    let rankUnscoped = 1;
    let rankScoped = 1;
    for (let fi = 0; fi < facts.length; fi += 1) {
      if (fi === goldIdx) continue;
      const sim = cosine(qv, factVecs[fi]);
      if (sim > goldSim) {
        rankUnscoped += 1;
        if (facts[fi].scope === q.scope) rankScoped += 1;
      }
    }
    if (rankUnscoped <= 5) within5Unscoped += 1;
    if (rankScoped <= 5) within5Scoped += 1;
    sims.push(goldSim);
    n += 1;
  });
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    scoredQuestions: n,
    within5UnscopedRate: n ? within5Unscoped / n : 0,
    within5ScopedRate: n ? within5Scoped / n : 0,
    meanGoldCosine: mean(sims),
    cosineFloor: COSINE_FLOOR,
    note:
      "Approximate vector-only ranks (no BM25/hybrid). Scoped preview hints at the " +
      "scopeFilter A/B; Gate 1b is the authoritative check.",
  };
}

// ---------------------------------------------------------------- sizes / orchestration

function defaultSizes() {
  // 12 content scopes total: 8 dev + 4 held-out. 6 questions/scope.
  return {
    dev: { scopes: 8, mix: { single: 3, multi: 1, temporal: 1, abstention: 1 } },
    heldout: { scopes: 4, mix: { single: 3, multi: 1, temporal: 1, abstention: 1 } },
  };
}

/**
 * @param {object} opts
 * @param {string} opts.runid
 * @param {number|string} opts.seedDev
 * @param {number|string} opts.seedHeldout
 * @param {object} [opts.sizes]
 * @param {string[]} [opts.realScopeDenylist]
 * @param {boolean} [opts.noModel] template-only (skip Qwen) — for debugging
 * @param {object} [opts.ollama] OllamaClient instance (defaults to a fresh local one)
 * @param {boolean} [opts.preview] run the offline embedding preview (default true unless noModel)
 */
async function generateDataset({
  runid, seedDev, seedHeldout, sizes, realScopeDenylist = [], noModel = false, ollama, preview,
}) {
  const resolvedSizes = sizes || defaultSizes();
  const scopePrefix = `benchuser_${runid}`;
  const markerSet = new Set();
  const client = noModel ? null : (ollama || new OllamaClient({}));
  if (client) {
    await client.warmup();
  }

  const devRng = new Rng(`${runid}:dev:${seedDev}`);
  const heldRng = new Rng(`${runid}:heldout:${seedHeldout}`);
  const gateRng = new Rng(`${runid}:gate2:${seedDev}`);

  const devEntities = buildEntityPool(devRng);
  const heldEntities = buildEntityPool(heldRng);
  const gateEntities = buildEntityPool(gateRng);

  const stats = {
    gold: { items: 0, fallbacks: 0 },
    noise: { items: 0, fallbacks: 0 },
  };

  const dev = await buildSet({
    rng: devRng, label: "dev", scopePrefix: `${scopePrefix}_dev`,
    scopeCount: resolvedSizes.dev.scopes, mix: resolvedSizes.dev.mix,
    markerSet, entityDraw: makeDrawer(devEntities), ollama: client, stats, seedBase: 1000,
  });
  const heldout = await buildSet({
    rng: heldRng, label: "heldout", scopePrefix: `${scopePrefix}_held`,
    scopeCount: resolvedSizes.heldout.scopes, mix: resolvedSizes.heldout.mix,
    markerSet, entityDraw: makeDrawer(heldEntities), ollama: client, stats, seedBase: 5000,
  });

  const gate2 = buildGate2Fixture({ rng: gateRng, scopePrefix, markerSet, entityDraw: makeDrawer(gateEntities) });
  const scopeFilterGate = buildScopeFilterFixture({ rng: gateRng, scopePrefix, markerSet, entityDraw: makeDrawer(gateEntities) });

  const allIngests = [
    ...dev.ingests, ...heldout.ingests, ...gate2.ingests, ...scopeFilterGate.ingests,
  ];
  // Hard-fail rate is measured on GOLD paraphrase items (the part that must stress
  // semantic); filler/distractor noise is acceptable as templates.
  const goldFallbackRate = stats.gold.items ? stats.gold.fallbacks / stats.gold.items : 0;

  const dataset = {
    meta: {
      runid, seedDev, seedHeldout, markerLen: MARKER_LEN,
      sizes: resolvedSizes, scopePrefix,
      buryMargin: BURY_MARGIN, targetScopeSize: TARGET_SCOPE_SIZE,
      crossScopeDistractors: CROSS_SCOPE_DISTRACTORS,
      generation: {
        model: client ? client.genModel : "template-only",
        gold: stats.gold,
        noise: stats.noise,
        goldFallbackRate,
        fallbackHardFailRate: FALLBACK_HARD_FAIL_RATE,
        jaccardBand: [JACCARD_MIN, JACCARD_MAX],
      },
      counts: {
        devQuestions: dev.questions.length,
        heldoutQuestions: heldout.questions.length,
        ingests: allIngests.length,
        markers: markerSet.size,
      },
    },
    scopes: [...dev.scopes, ...heldout.scopes, gate2.scope, ...scopeFilterGate.scopes],
    dev: dev.questions,
    heldout: heldout.questions,
    gate2,
    scopeFilterGate,
    ingests: allIngests,
  };

  validateDataset(dataset, { scopePrefix, realScopeDenylist, fallbackRate: goldFallbackRate });

  if (preview !== false && client) {
    try {
      dataset.meta.offlinePreview = await offlinePreview(client, dataset);
    } catch (error) {
      dataset.meta.offlinePreview = { error: error.message };
    }
  }

  return dataset;
}

// ---------------------------------------------------------------- validations (fail-closed)

function validateDataset(dataset, { scopePrefix, realScopeDenylist, fallbackRate }) {
  // 1) Forbidden words anywhere.
  assertNoForbidden(
    {
      ingests: dataset.ingests, dev: dataset.dev, heldout: dataset.heldout,
      gate2: dataset.gate2, scopeFilterGate: dataset.scopeFilterGate,
    },
    "benchmark dataset"
  );

  // 2) Marker uniqueness across the whole dataset.
  const markers = dataset.ingests.filter((i) => i.marker).map((i) => i.marker);
  const markerSet = new Set(markers);
  if (markerSet.size !== markers.length) {
    throw new Error(`Marker uniqueness FAILED: ${markers.length} markers, ${markerSet.size} unique`);
  }

  // 3) Every required/forbidden marker is actually planted, and never leaks into a question.
  const planted = new Set(markers);
  const allQuestions = [
    ...dataset.dev, ...dataset.heldout, dataset.gate2.question, dataset.scopeFilterGate.question,
  ];
  for (const q of allQuestions) {
    for (const m of [...q.requiredMarkers, ...q.forbiddenMarkers]) {
      if (!planted.has(m)) throw new Error(`Question ${q.id} references unplanted marker ${m}`);
      if (q.query.includes(m)) throw new Error(`Question ${q.id} leaks marker ${m} into its query text`);
    }
  }

  // 4) BURY INVARIANT (the linchpin): every required+forbidden marker is buried
  // >= BURY_MARGIN turns deep within its scope, so it falls out of the 20-turn
  // episodic window and can only be recovered via semantic recall (spec §3/§5).
  const lastTurnByScope = new Map();
  const turnOfMarker = new Map();
  for (const ing of dataset.ingests) {
    const cur = lastTurnByScope.get(ing.scope) ?? -1;
    if (ing.turnIndex > cur) lastTurnByScope.set(ing.scope, ing.turnIndex);
    if (ing.marker) turnOfMarker.set(ing.marker, { scope: ing.scope, turnIndex: ing.turnIndex });
  }
  const buryViolations = [];
  for (const q of [...dataset.dev, ...dataset.heldout]) {
    for (const m of [...q.requiredMarkers, ...q.forbiddenMarkers]) {
      const loc = turnOfMarker.get(m);
      if (!loc) continue;
      const lastTurn = lastTurnByScope.get(loc.scope) ?? loc.turnIndex;
      const depth = lastTurn - loc.turnIndex;
      if (depth < BURY_MARGIN) {
        buryViolations.push({ question: q.id, marker: m, depth, required: BURY_MARGIN });
      }
    }
  }
  if (buryViolations.length > 0) {
    const sample = buryViolations.slice(0, 6).map((v) => `${v.question}:${v.marker} depth=${v.depth}`).join("; ");
    throw new Error(
      `BURY INVARIANT FAILED for ${buryViolations.length} marker(s) (need depth >= ${BURY_MARGIN}): ${sample}`
    );
  }

  // 5) Generation reliability: too many template fallbacks => paraphrase gap is
  // not real, so the benchmark would not stress semantic as intended (spec §3).
  if (fallbackRate > FALLBACK_HARD_FAIL_RATE) {
    throw new Error(
      `Paraphrase generation unreliable: fallback rate ${(fallbackRate * 100).toFixed(1)}% ` +
        `> ${(FALLBACK_HARD_FAIL_RATE * 100).toFixed(0)}% — Qwen content could not satisfy the ` +
        `marker/paraphrase validations often enough. Strengthen the prompt or relax the band before population.`
    );
  }

  // 6) Scope isolation: every scope is run-prefixed; none collides with a real scope.
  const deny = new Set(["sage_mem_v2", "memory_private", ...realScopeDenylist]);
  for (const scope of dataset.scopes) {
    if (!scope.startsWith(scopePrefix)) throw new Error(`Scope ${scope} is not run-prefixed (${scopePrefix})`);
    if (deny.has(scope)) throw new Error(`Scope ${scope} collides with a real/denied scope`);
  }
  for (const ing of dataset.ingests) {
    if (!ing.scope.startsWith(scopePrefix)) throw new Error(`Ingest scope ${ing.scope} is not run-prefixed`);
  }
}

export { generateDataset, defaultSizes, MARKER_LEN };
