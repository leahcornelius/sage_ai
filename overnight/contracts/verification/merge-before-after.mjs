// Headline verification (one-shot, not a committed test — 620 ingests x2 is slow).
//
// Reproduces the Experiment-3 merge-corruption magnitude at full scale on the frozen
// 620-fact homogeneous dataset, comparing:
//   OLD merge path  = mnemosyneClient.store({...}) -> fullStorePipeline (dedup/merge)
//                     (what storeEpisodic did before the Exp4 fix)
//   NEW raw path    = adapter.storeEpisodic(...) -> raw db.store (the Exp4 fix)
//
// Expected: OLD collapses to far fewer live points and strips scopeKey from most
// survivors (Exp3 production run measured 134 live / 476 deleted on this dataset); NEW
// keeps all 620 live with scopeKey preserved.
//
// Note: the OLD path's exact live count depends on write-visibility timing (mnemosy-ai's
// db.store doesn't actually wait), so a small inter-store delay lets each store's internal
// dedup search see prior writes — reproducing the production condition where merges fire.
// Run: node overnight/contracts/verification/merge-before-after.mjs

import fs from "node:fs";
import path from "node:path";

import pino from "pino";

import { createMnemosyneAdapter } from "../../../src/services/memory/mnemosyne-adapter.js";
import {
  buildIsolatedClient,
  countLive,
  countDeleted,
  scrollPoints,
  settle,
  dropCollections,
} from "../harness.mjs";

const DATASET = path.resolve(
  process.cwd(),
  "overnight/runs/r2026061420071_dcb6_dry/dataset.json"
);
const logger = pino({ level: "silent" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadIngests() {
  const data = JSON.parse(fs.readFileSync(DATASET, "utf8"));
  return data.ingests || [];
}

async function liveStats(collection, markers) {
  const points = await scrollPoints(collection, { liveOnly: true });
  const live = points.length;
  const withScopeKey = points.filter((p) => p?.payload?.metadata?.scopeKey).length;
  const liveText = points.map((p) => p?.payload?.text || "").join("\n");
  const markersInLive = markers.filter((m) => m && liveText.includes(m)).length;
  return { live, withScopeKey, markersInLive };
}

async function runOldMergePath(ingests, markers) {
  const { client, collections } = await buildIsolatedClient();
  for (let i = 0; i < ingests.length; i++) {
    const ing = ingests[i];
    await client.store({
      text: ing.text,
      category: "episodic",
      eventTime: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      metadata: {
        memoryClass: "episodic",
        scopeKey: ing.scope,
        conversationId: ing.conversationId,
        turnIndex: ing.turnIndex,
        messageId: `${ing.scope}-${ing.turnIndex}`,
      },
    });
    await sleep(25); // let the async write propagate so the next dedup search sees it
  }
  // Wait for the dust to settle (live count stable across two reads).
  let prev = -1;
  for (let t = 0; t < 40; t++) {
    const live = await countLive(collections.shared);
    if (live === prev) break;
    prev = live;
    await sleep(300);
  }
  const stats = await liveStats(collections.shared, markers);
  const deleted = await countDeleted(collections.shared);
  await dropCollections(collections);
  return { ...stats, deleted, ingested: ingests.length };
}

async function runNewRawPath(ingests, markers) {
  const { client, collections } = await buildIsolatedClient();
  const adapter = createMnemosyneAdapter({
    mnemosyneClient: client,
    config: { memory: { mode: "soft" } },
    logger,
  });
  for (let i = 0; i < ingests.length; i++) {
    const ing = ingests[i];
    await adapter.storeEpisodic({
      scopeKey: ing.scope,
      conversationId: ing.conversationId,
      role: "user",
      messageText: ing.text,
      messageId: `${ing.scope}-${ing.turnIndex}`,
      turnIndex: ing.turnIndex,
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    });
  }
  await settle(collections.shared, ingests.length, { timeoutMs: 30_000 });
  const stats = await liveStats(collections.shared, markers);
  const deleted = await countDeleted(collections.shared);
  await dropCollections(collections);
  return { ...stats, deleted, ingested: ingests.length };
}

const ingests = loadIngests();
const markers = [...new Set(ingests.map((i) => i.marker).filter(Boolean))];
console.log(`Dataset: ${ingests.length} ingests, ${markers.length} unique markers\n`);

console.log("Running OLD merge path (mnemosyneClient.store -> fullStorePipeline) ...");
const oldStats = await runOldMergePath(ingests, markers);
console.log("Running NEW raw path (storeEpisodic -> db.store) ...");
const newStats = await runNewRawPath(ingests, markers);

const row = (label, s) =>
  `${label.padEnd(16)} live=${String(s.live).padStart(4)}  deleted=${String(s.deleted).padStart(4)}  ` +
  `liveWithScopeKey=${String(s.withScopeKey).padStart(4)}  markersInLive=${String(s.markersInLive).padStart(4)}/${markers.length}`;

console.log("\n================ MERGE BEFORE / AFTER (620-fact homogeneous fixture) ================");
console.log(row("OLD (merge)", oldStats));
console.log(row("NEW (raw fix)", newStats));
console.log("====================================================================================");
console.log(
  `\nHeadline: ${oldStats.live} -> ${newStats.live} live points; ` +
    `scopeKey on live ${oldStats.withScopeKey} -> ${newStats.withScopeKey}; ` +
    `gold markers retrievable ${oldStats.markersInLive} -> ${newStats.markersInLive} of ${markers.length}.`
);

const ok = newStats.live === ingests.length && newStats.withScopeKey === ingests.length && newStats.live > oldStats.live;
console.log(ok ? "\nRESULT: PASS — raw path preserves all points + scopeKey; merge path collapses." : "\nRESULT: unexpected — inspect numbers above.");
