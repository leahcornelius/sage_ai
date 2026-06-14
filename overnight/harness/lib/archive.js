// Resumable, file-based persistence (spec §7/§9). Everything is written under
// the run directory so a process restart can resume.

import fs from "node:fs";
import path from "node:path";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

function readJsonl(filePath) {
  try {
    return fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// Canonical identity of a knob config (for dedupe / archive lookups). Includes
// scopeFilter (0/1) so scoped vs unscoped are distinct grid/archive identities.
function configKey(c) {
  return `s${c.semanticTopK}_e${c.episodicTopK}_g${c.graphMaxResults}_c${c.contextMaxTokens}_f${c.scopeFilter ? 1 : 0}`;
}

class RunStore {
  constructor(runDir) {
    this.runDir = runDir;
    this.archivePath = path.join(runDir, "archive.jsonl");
    this.bestPath = path.join(runDir, "best.json");
    this.manifestPath = path.join(runDir, "manifest.json");
    this.statePath = path.join(runDir, "loop-state.json");
    this.gridPath = path.join(runDir, "grid.jsonl");
    this.logsDir = path.join(runDir, "logs");
    ensureDir(runDir);
    ensureDir(this.logsDir);
  }

  appendArchive(record) {
    appendJsonl(this.archivePath, record);
  }

  readArchive() {
    return readJsonl(this.archivePath);
  }

  appendGrid(record) {
    appendJsonl(this.gridPath, record);
  }

  readGrid() {
    return readJsonl(this.gridPath);
  }

  writeBest(best) {
    writeJson(this.bestPath, best);
  }

  readBest() {
    return readJson(this.bestPath);
  }

  writeManifest(manifest) {
    writeJson(this.manifestPath, manifest);
  }

  readManifest() {
    return readJson(this.manifestPath);
  }

  writeState(state) {
    writeJson(this.statePath, state);
  }

  readState() {
    return readJson(this.statePath);
  }

  // Compact, git-committable summary of the archive (no bulky per-retrieve logs).
  writeArchiveSummary() {
    const archive = this.readArchive();
    const grid = this.readGrid();
    const byUtility = [...archive].sort((a, b) => (b.utility ?? -Infinity) - (a.utility ?? -Infinity));
    const summary = {
      iterations: archive.length,
      keeps: archive.filter((r) => r.decision === "keep").length,
      reverts: archive.filter((r) => r.decision === "revert").length,
      gridConfigs: grid.length,
      top: byUtility.slice(0, 10).map((r) => ({
        config: r.config,
        utility: r.utility,
        meanRecall: r.meanRecall,
        meanTokens: r.meanTokens,
        meanMrr: r.meanMrr,
        decision: r.decision,
        iteration: r.iteration,
      })),
    };
    writeJson(path.join(this.runDir, "archive-summary.json"), summary);
    return summary;
  }
}

export {
  RunStore,
  ensureDir,
  writeJson,
  readJson,
  appendJsonl,
  readJsonl,
  configKey,
};
