// Synthetic, seeded, reproducible benchmark generator (spec §4).
// Produces disjoint dev + held-out sets plus a tiny adversarial Gate-2 fixture,
// an ordered generation-free ingest list, and runs fail-closed validations
// (forbidden words, marker uniqueness, scope isolation) BEFORE population.

import { Rng } from "./lib/rng.js";
import { isForbidden, assertNoForbidden } from "./lib/forbidden.js";

const MARKER_LEN = 8;

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
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const m = rng.marker(MARKER_LEN, isForbidden);
    if (!markerSet.has(m)) {
      markerSet.add(m);
      return m;
    }
  }
  throw new Error("uniqueMarker(): exhausted attempts");
}

/**
 * Build one labelled set (dev or held-out). Each scope is a synthetic "user"
 * with a multi-session history; questions are distributed across scopes.
 */
function buildSet({ rng, label, scopePrefix, counts, markerSet, entityDraw }) {
  const ingests = [];
  const questions = [];
  const turnByScope = new Map();

  // Attributes repeat across questions (only entities are drawn without
  // replacement). Distractors deliberately reuse a question's attribute.
  const pickAttr = () => rng.choice(ATTRIBUTES);
  const pickTwoAttrs = () => {
    const a = pickAttr();
    let b = pickAttr();
    let guard = 0;
    while (b === a && guard++ < 16) {
      b = pickAttr();
    }
    return [a, b];
  };

  function nextTurn(scope) {
    const t = turnByScope.get(scope) || 0;
    turnByScope.set(scope, t + 1);
    return t;
  }

  const totalQuestions =
    counts.single + counts.multi + counts.temporal + counts.abstention;
  const perScope = 4;
  const scopeCount = Math.max(1, Math.ceil(totalQuestions / perScope));
  const scopes = Array.from({ length: scopeCount }, (_, i) => `${scopePrefix}_${i}`);
  let qSeq = 0;
  const scopeFor = () => scopes[Math.floor(qSeq / perScope) % scopeCount];

  function ingest(scope, session, text, marker, kind) {
    const conversationId = `${scope}__s${session}`;
    ingests.push({ scope, conversationId, turnIndex: nextTurn(scope), text, marker, kind });
  }

  function plantDistractors(scope, attr, n) {
    for (let i = 0; i < n; i += 1) {
      const e = entityDraw();
      const m = uniqueMarker(rng, markerSet);
      ingest(scope, 1, `The ${attr} for the ${e} is ${m}.`, m, "distractor");
    }
  }

  // single-hop
  for (let i = 0; i < counts.single; i += 1) {
    const scope = scopeFor(); qSeq += 1;
    const entity = entityDraw();
    const attr = pickAttr();
    const marker = uniqueMarker(rng, markerSet);
    ingest(scope, 1, `The ${attr} for the ${entity} is ${marker}.`, marker, "gold");
    plantDistractors(scope, attr, 2);
    questions.push({
      id: `${label}-single-${i}`,
      type: "single",
      scope,
      query: `What is the ${attr} for the ${entity}?`,
      requiredMarkers: [marker],
      forbiddenMarkers: [],
    });
  }

  // multi-hop (two facts, two sessions, same entity)
  for (let i = 0; i < counts.multi; i += 1) {
    const scope = scopeFor(); qSeq += 1;
    const entity = entityDraw();
    const [attr1, attr2] = pickTwoAttrs();
    const m1 = uniqueMarker(rng, markerSet);
    const m2 = uniqueMarker(rng, markerSet);
    ingest(scope, 1, `The ${attr1} for the ${entity} is ${m1}.`, m1, "gold");
    ingest(scope, 2, `The ${attr2} for the ${entity} is ${m2}.`, m2, "gold");
    plantDistractors(scope, attr1, 1);
    plantDistractors(scope, attr2, 1);
    questions.push({
      id: `${label}-multi-${i}`,
      type: "multi",
      scope,
      query: `For the ${entity}, what are the ${attr1} and the ${attr2}?`,
      requiredMarkers: [m1, m2],
      forbiddenMarkers: [],
    });
  }

  // temporal update (old superseded by new)
  for (let i = 0; i < counts.temporal; i += 1) {
    const scope = scopeFor(); qSeq += 1;
    const entity = entityDraw();
    const attr = pickAttr();
    const mOld = uniqueMarker(rng, markerSet);
    const mNew = uniqueMarker(rng, markerSet);
    ingest(scope, 1, `Until recently, the ${attr} for the ${entity} was ${mOld}.`, mOld, "stale");
    ingest(scope, 2, `Update: the current ${attr} for the ${entity} is now ${mNew}.`, mNew, "gold");
    plantDistractors(scope, attr, 1);
    questions.push({
      id: `${label}-temporal-${i}`,
      type: "temporal",
      scope,
      query: `What is the current ${attr} for the ${entity}?`,
      requiredMarkers: [mNew],
      forbiddenMarkers: [mOld],
    });
  }

  // abstention (never planted) — scored only at the e2e checkpoint
  for (let i = 0; i < counts.abstention; i += 1) {
    const scope = scopeFor(); qSeq += 1;
    const entity = entityDraw();
    const attr = pickAttr();
    questions.push({
      id: `${label}-abstain-${i}`,
      type: "abstention",
      scope,
      query: `What is the ${attr} for the ${entity}?`,
      requiredMarkers: [],
      forbiddenMarkers: [],
    });
  }

  return { questions, ingests, scopes };
}

// Tiny adversarial fixture: gold competes with many same-attribute distractors so
// the gold is unlikely to be rank-1 — guaranteeing K=1 vs K=30 differ (spec Gate 2).
function buildGate2Fixture({ rng, scopePrefix, markerSet, entityDraw, distractors = 10 }) {
  const scope = `${scopePrefix}_gate2`;
  const attr = "access code";
  const entity = entityDraw();
  const gold = uniqueMarker(rng, markerSet);
  const ingests = [];
  let turn = 0;
  ingests.push({
    scope,
    conversationId: `${scope}__s1`,
    turnIndex: turn++,
    text: `The ${attr} for the ${entity} is ${gold}.`,
    marker: gold,
    kind: "gold",
  });
  for (let i = 0; i < distractors; i += 1) {
    const e = entityDraw();
    const m = uniqueMarker(rng, markerSet);
    ingests.push({
      scope,
      conversationId: `${scope}__s1`,
      turnIndex: turn++,
      text: `The ${attr} for the ${e} is ${m}.`,
      marker: m,
      kind: "distractor",
    });
  }
  const question = {
    id: "gate2-fixture",
    type: "single",
    scope,
    query: `What is the ${attr} for the ${entity}?`,
    requiredMarkers: [gold],
    forbiddenMarkers: [],
  };
  return { scope, question, ingests };
}

function defaultSizes() {
  return {
    dev: { single: 12, multi: 8, temporal: 6, abstention: 6 },
    heldout: { single: 6, multi: 4, temporal: 3, abstention: 3 },
  };
}

/**
 * @param {object} opts
 * @param {string} opts.runid
 * @param {number|string} opts.seedDev
 * @param {number|string} opts.seedHeldout
 * @param {object} [opts.sizes]
 * @param {string[]} [opts.realScopeDenylist] scopes known to belong to the real instance
 */
function generateDataset({ runid, seedDev, seedHeldout, sizes, realScopeDenylist = [] }) {
  const resolvedSizes = sizes || defaultSizes();
  const scopePrefix = `benchuser_${runid}`;

  // A single global marker set guarantees uniqueness across dev + held-out + gate2.
  const markerSet = new Set();

  // Independent entity/attribute streams per set keep things disjoint but seeded.
  const devRng = new Rng(`${runid}:dev:${seedDev}`);
  const heldRng = new Rng(`${runid}:heldout:${seedHeldout}`);
  const gateRng = new Rng(`${runid}:gate2:${seedDev}`);

  const devEntities = buildEntityPool(devRng);
  const heldEntities = buildEntityPool(heldRng);
  const gateEntities = buildEntityPool(gateRng);

  const dev = buildSet({
    rng: devRng,
    label: "dev",
    scopePrefix: `${scopePrefix}_dev`,
    counts: resolvedSizes.dev,
    markerSet,
    entityDraw: makeDrawer(devEntities),
  });

  const heldout = buildSet({
    rng: heldRng,
    label: "heldout",
    scopePrefix: `${scopePrefix}_held`,
    counts: resolvedSizes.heldout,
    markerSet,
    entityDraw: makeDrawer(heldEntities),
  });

  const gate2 = buildGate2Fixture({
    rng: gateRng,
    scopePrefix,
    markerSet,
    entityDraw: makeDrawer(gateEntities),
  });

  // Population order: dev facts, held-out facts, then the gate2 fixture.
  const allIngests = [...dev.ingests, ...heldout.ingests, ...gate2.ingests];

  const dataset = {
    meta: {
      runid,
      seedDev,
      seedHeldout,
      markerLen: MARKER_LEN,
      sizes: resolvedSizes,
      scopePrefix,
      counts: {
        devQuestions: dev.questions.length,
        heldoutQuestions: heldout.questions.length,
        ingests: allIngests.length,
        markers: markerSet.size,
      },
    },
    scopes: [...dev.scopes, ...heldout.scopes, gate2.scope],
    dev: dev.questions,
    heldout: heldout.questions,
    gate2,
    ingests: allIngests,
  };

  validateDataset(dataset, { scopePrefix, realScopeDenylist });
  return dataset;
}

function validateDataset(dataset, { scopePrefix, realScopeDenylist }) {
  // 1) Forbidden words anywhere (facts, distractors, questions, markers).
  assertNoForbidden(
    {
      ingests: dataset.ingests,
      dev: dataset.dev,
      heldout: dataset.heldout,
      gate2: dataset.gate2,
    },
    "benchmark dataset"
  );

  // 2) Marker uniqueness across the whole dataset.
  const markers = dataset.ingests.filter((i) => i.marker).map((i) => i.marker);
  const markerSet = new Set(markers);
  if (markerSet.size !== markers.length) {
    throw new Error(
      `Marker uniqueness FAILED: ${markers.length} markers, ${markerSet.size} unique`
    );
  }
  // every required/forbidden gold marker must actually be planted
  const planted = new Set(markers);
  for (const q of [...dataset.dev, ...dataset.heldout, dataset.gate2.question]) {
    for (const m of [...q.requiredMarkers, ...q.forbiddenMarkers]) {
      if (!planted.has(m)) {
        throw new Error(`Question ${q.id} references unplanted marker ${m}`);
      }
    }
  }

  // 3) Scope isolation: every scope is run-prefixed; none collides with a real scope.
  const deny = new Set([
    "sage_mem_v2",
    "memory_private",
    ...realScopeDenylist,
  ]);
  for (const scope of dataset.scopes) {
    if (!scope.startsWith(scopePrefix)) {
      throw new Error(`Scope ${scope} is not run-prefixed (${scopePrefix})`);
    }
    if (deny.has(scope)) {
      throw new Error(`Scope ${scope} collides with a real/denied scope`);
    }
  }
  for (const ing of dataset.ingests) {
    if (!ing.scope.startsWith(scopePrefix)) {
      throw new Error(`Ingest scope ${ing.scope} is not run-prefixed`);
    }
  }
}

export { generateDataset, defaultSizes, MARKER_LEN };
