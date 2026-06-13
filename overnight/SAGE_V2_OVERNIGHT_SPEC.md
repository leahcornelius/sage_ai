# SAGE V2 — Overnight Self-Improving Retrieval Loop Spec (V0.1)

**Run this in Claude Code, in plan mode, from the `sage_ai` repo folder.** Plan first, show me the
plan, and only build + launch after I approve. A working Sage is already running locally from an
earlier smoke test (see `SETUP_STATUS.md`, on port 8787, pointed at the **real** collection
`sage_mem_v2`). A read-only architecture report is in `SAGE_ANALYSIS.md`. **Read both before planning
and treat them as ground truth.**

> **Do not reuse the already-running Sage instance for the benchmark.** It points at real user memory.
> The benchmark runs a **separate, freshly-launched Sage process on a different port, pointed at a
> throwaway collection** (see §2 and Gate 0). This is a hard safety boundary.

---

## 0. Goal (and what success means)

Build a closed self-improvement loop that automatically tunes Sage's **read-side memory
configuration** to improve retrieval quality on a synthetic benchmark — keeping changes that help,
reverting ones that don't — then **launch it as a detached process so it runs unattended overnight**
and writes a morning report.

This is **V0.1**. Success means **the loop closes and runs itself, safely and unattended, against
Sage's real config surface** — generate benchmark → populate memory (no model calls) → mutate config →
score retrieval → keep/revert → archive → detach → run for hours → report. Success is **NOT** a large
accuracy gain; the action space is deliberately small (§1). **Prove the machinery cleanly. Do not
build the perfect optimiser in one pass, and do not expand V0.1 scope.**

---

## 1. Scope and non-goals

**In scope (the mutable surface for this run):** Sage's read-side memory knobs only —
`semanticTopK`, `episodicTopK`, `contextMaxTokens` (the dominant levers), `graphMaxResults` for
completeness (Zep is off, so it's inert). The retrieval time budget is set **generous and fixed** —
not optimised — to avoid truncation (§10).

**Explicitly out of scope (do not do these):**
- No changes to Sage's retrieval *code* (no new cross-bucket ranking, scope-filtering, query
  rewriting, dedup). Those are the night-two action space — list them in the report as future levers,
  do not implement them.
- No model retraining / fine-tuning of any kind.
- No re-enabling of mem0/Zep for the benchmark.
- No edits to `.env.local` or any secret; no new external accounts or paid services.

---

## 2. Hard constraints

1. **Sandbox + version control.** Work on a new git branch; commit frequently (but see §9 on what
   *not* to commit). The benchmark runs against a **dedicated throwaway Qdrant collection**
   `bench_<runid>` — never the real `sage_mem_v2`.
2. **Separate instance.** Launch a dedicated benchmark Sage process on a **non-default port** (e.g.
   8799), pointed at `bench_<runid>`, with **mem0 and Zep disabled**, **query cache disabled**,
   **retrieval budget generous**, and **admin routes enabled** (§3). Never populate or mutate config on
   any instance that may point at real memory.
3. **Secrets.** Do not read, print, copy, move, or edit any value in `.env.local`. The checkpoint
   step (§6) reaches the model through the running Sage; never handle a key directly.
4. **Cost discipline (all model calls counted, none hidden).**
   - The **inner loop makes zero model calls** (retrieval-only scoring via `/admin/retrieve`).
   - **Population makes zero model calls** when using the `/admin/ingest` hook (§3, §5). If — and only
     if — a generation-free ingest path cannot be wired and population must use `/v1/chat/completions`,
     those calls must be **counted, capped, and logged separately before the run begins**, and called
     out in the plan. They are never outside the cost discipline.
   - The **checkpoint** (§6) is the only intended model-calling step. Enforce a hard ceiling: stop all
     checkpoint model calls once a configurable budget is reached (default: 20 checkpoint runs), plus a
     `$`/token backstop. Provide a `--no-checkpoint-model-calls` flag for debugging.
5. **Run caps.** Stop on the first of: wall-clock cap (default 8h), iteration cap (default 1000), or
   convergence (no best-score improvement for N iterations, default 100).
6. **Crash resilience.** Catch per-iteration exceptions, log, and continue with the next candidate — a
   single failure must not idle the night. Persist state (archive, best, run log, manifest) every
   iteration so a process restart resumes.
7. **Gate discipline (load-bearing).** Do **not** launch the unattended loop unless Gates 0–3 (§8)
   each pass. On any gate failure: **stop, write `GATE_FAILURE.md` (which gate, evidence, diagnosis,
   proposed fix), and do not launch.** Never run the loop over an unvalidated harness.

---

## 3. Sage harness additions (three small admin hooks)

`SAGE_ANALYSIS.md §3` confirms config is read once at startup, no hot-reload, no admin endpoint —
**but** the read-side knobs are read **per-request off the live `config` object**. Exploit that. Add
three guarded admin routes.

**Hardening (applies to all three):**
- Disabled by default; require `SAGE_ADMIN_ENABLED=true`.
- Local/benchmark mode only; bind to localhost; **must never be exposed on public/staging/production**
  deployments.
- Use the existing bearer auth (or a dedicated benchmark admin credential).
- Log every config mutation (keys + values), but **never log secrets**.

1. **`POST /admin/ingest`** — generation-free memory write. Body `{ scope, text, category?,
   importance?, timestamp? }`. Calls the controller's write path (`processMessage`, role `user`)
   directly, **with no upstream model call**. This is how the benchmark populates memory. Return a
   write ack with the resulting stored ids / counts so completeness can be verified.

2. **`POST /admin/memory-config`** — mutate the live `config.memory.*` read-side fields in place; the
   change takes effect on the next request (no restart). **Allowlist exactly** these keys and **reject
   unknown keys with an error (do not silently ignore):** `semanticTopK`, `episodicTopK`,
   `graphMaxResults`, `contextMaxTokens`, and the fixed retrieval-budget fields if they must be set.
   After mutating, **defensively flush the Redis query-context cache**. Return the effective config.

3. **`POST /admin/retrieve`** — run `retrieveContext` for `{ query, scope }` and return the retrieved
   buckets **and the assembled post-trim context block**, with **no upstream model call**. Return at
   least: `{ semanticMemories, episodicSummaries, graphMemories, identityMemories, contextBlock,
   contextTokenCount, partial, cacheHit }`. `cacheHit` is required (Gate 1 checks it is `false`).

These are additive, guarded, localhost-only, and do not change behaviour for normal traffic.

---

## 4. Benchmark generator (the fitness function's data)

Generate synthetic, seeded, reproducible data, isolated to `bench_<runid>`.

Each synthetic user gets a multi-session history of planted facts salted with **distractor facts**
(similar-looking, wrong) so retrieval must discriminate. Every planted answer is a **high-entropy
unique marker code** (e.g. a random base32 string like `K7QF2M`) the base model cannot guess — so a
correct retrieval is the only way the marker can appear. Four question types:

- **Single-hop** — plant a fact, ask directly. Gold = that marker retrieved.
- **Multi-hop** — two facts across different sessions that must combine. Gold = both retrieved.
- **Temporal update** — plant a fact, supersede it later. Gold = the **updated** marker present and the
  **stale** marker absent (or ranked below).
- **Abstention** — ask about a never-planted fact. Evaluated **only at the end-to-end checkpoint** (did
  the model abstain); excluded from the retrieval-only inner-loop score (there is no gold to retrieve).

**Forbidden-word rule (silent-failure landmine — strict).** The `mnemosy-ai` layer silently refuses to
store any text matching `/secret|password|token|api ?key|card|ssn/i` and swallows the error
(`SETUP_STATUS.md` #2). Therefore: **no generated text may contain `secret`, `password`, `token`,
`api key`, `card`, or `ssn` anywhere** — including labels, templates, distractors, planted facts, and
the question text sent into Sage. Do **not** call the answer values "tokens"; call them **marker
codes** / **answer codes** / **raw codes**. **Validate every generated string against the regex before
population, and fail before population if any match.**

**Generator validations (fail before population if any fail):**
- All marker codes are **unique across both the dev and held-out sets**.
- No generated text matches the forbidden regex.
- **No real user scope appears** in the synthetic data (scopes are run-prefixed, e.g. `benchuser_*`);
  confirm none collide with anything that could be a real scope.

Produce two disjoint seeded sets: a **dev** set the loop optimises against, and a **held-out** set
(different seed) used only at checkpoints. Keep them small enough that the full dev set scores in
seconds.

---

## 5. Harness flow

1. **Preflight (Gate 0, §8).** Verify isolation and instance hygiene *before touching memory*.
2. **Bring up the benchmark Sage** (separate process, §2): `MNEMOSYNE_COLLECTION_NAME=bench_<runid>`,
   `SAGE_MEM0_ENABLED=false`, `SAGE_ZEP_ENABLED=false`, `SAGE_MEMORY_QUERY_CACHE_TTL_SEC=0`, retrieval
   budget/timeouts ≥ 3000 ms, `SAGE_ADMIN_ENABLED=true`, on a non-default port.
3. **Snapshot baseline config** before any mutation (record it in the manifest; restore on clean exit).
4. **Populate once, generation-free**, via `POST /admin/ingest` per planted fact. Writes are async —
   confirm completion deterministically: poll the collection point count, **and** verify
   **every gold marker is retrievable** at a generous K via `/admin/retrieve`. If any gold marker is
   not retrievable after a populate timeout, **stop and write `GATE_FAILURE.md`** (do not run a loop
   over a half-populated store).
5. **Inner loop (§6/§7), generation-free.** For each candidate config: `POST /admin/memory-config`,
   then for each dev question `POST /admin/retrieve` and score from the response. No model calls.
6. **Checkpoint (periodic, §6).**

Because config is mutated in-process with no restart, the populated Qdrant data **and** the in-process
episodic ring buffer persist across all iterations — populate once, evaluate many.

---

## 6. Scoring and utility

**Score against what the model would actually see.** A marker can be *retrieved* yet *trimmed out* of
the final block when `contextMaxTokens` is small. So the **primary signal is computed on the post-trim
`contextBlock`** returned by `/admin/retrieve`, not only the pre-trim buckets (record both; the
pre-trim buckets are for diagnosis). This is what makes `contextMaxTokens` a real lever rather than an
invisible one.

**Per-question scoring (deterministic):**
- **recall@ctx** = (required gold markers present in the post-trim `contextBlock`) / (required count).
  Multi-hop scores 1.0 only if both markers are present.
- **Temporal update**: pass = updated marker present in `contextBlock` **and** stale marker absent
  (binary, for determinism).
- **MRR** (reported, secondary): rank of the first required gold marker within the returned
  `semanticMemories` ordering (the bucket `semanticTopK` controls); `1/rank`, or 0 if absent.
- **Abstention**: not scored here — deferred to the end-to-end checkpoint.

**Utility per config** = `mean(recall@ctx) − λ · mean(contextTokenCount)` (MRR reported as a
tiebreaker). The cost term is **mandatory** — without it the optimiser wins by maxing
`contextMaxTokens` and dumping everything into context, the exact failure memory exists to prevent.
`λ` starts conservative and is a config value. Note `contextMaxTokens` both bounds and is penalised by
the cost term; that interaction is intended.

**Determinism check (folded into Gate 1):** score the baseline twice; utility must be **identical**.
If not, retrieval scoring is noisy — investigate (embedding/search determinism), and if it cannot be
made deterministic, **widen the keep threshold to exceed the measured noise band** so keep/revert
decisions aren't driven by noise. Log the noise band in the manifest.

**Two-tier overfitting control:**
- **Free held-out retrieval check** (no model calls): periodically score the current best config on the
  held-out set via `/admin/retrieve`. If dev climbs but held-out is flat → generator-quirk overfitting;
  log it.
- **Capped end-to-end checkpoint** (model calls, under the §2 budget): for the current best config, run
  a held-out slice end-to-end through `/v1/chat/completions` (including abstention items) to confirm
  retrieval gains translate to answer gains. **External benchmarks (LoCoMo/LongMemEval) are optional**
  — use them only if already present locally or trivially fetchable without new accounts/services; the
  synthetic held-out checkpoint is the required one. If external benchmarks are skipped, **say so in
  `RUN_REPORT.md`.**

---

## 7. The optimisation loop (EvolveMem-style, file-based archive)

Skim EvolveMem (`github.com/aiming-lab/SimpleMem`, the `EvolveMem/` package) **for the loop/archive
design only** — diagnosis → propose → apply → evaluate → keep-or-revert → archive, with
revert-on-regression and explore-on-stagnation. **Do not fork its retriever** (we drive Sage over
HTTP). **If network/dependency setup fails, do not block** — implement the loop from the design in this
spec and note the skipped external read in the report.

Implement a small harness (Python suggested) that:
1. Maintains a resumable on-disk **archive** of evaluated configs + scores.
2. Each iteration: select a parent (exploit best vs explore), propose a read-side knob mutation, apply
   via `/admin/memory-config`, evaluate on the dev set (§6).
3. **Keep** if utility improves beyond the keep threshold; **revert** if it regresses. On stagnation,
   widen exploration / random-restart within knob bounds.
4. Persist archive + best + run log + manifest every iteration.
5. **On clean exit**, restore the benchmark instance to the snapshotted baseline config (best-effort;
   the instance and collection are throwaway regardless).

Knob bounds: `semanticTopK` 1–30, `episodicTopK` 0–20, `contextMaxTokens` 200–4000, `graphMaxResults`
fixed (Zep off). Respect §2 caps.

**Dry run:** support `--dry-run --iterations 3` that exercises generate → populate → gates → a few
loop iterations end-to-end on the throwaway collection without launching the detached overnight run, so
the plan can be validated cheaply.

### 7.1 Reference grid search (comparison mode — required)

The action space is small by design, so the loop's job on night one is to behave correctly in a
known-small space, not to discover magic. To make that verifiable, run a **coarse reference grid
search** as an independent baseline, then compare it against the loop. This adds no new capability and
no code-level change — it reuses the exact same generation-free scoring over the same knobs.

- Before (or in parallel with) the loop, evaluate a coarse grid over the knob space against the **same
  populated store and the same dev set** — e.g. `semanticTopK ∈ {1,3,5,10,20,30}`,
  `episodicTopK ∈ {0,3,10}`, `contextMaxTokens ∈ {400,800,1200,2000,4000}` (~90 configs). Each scores
  generation-free in seconds, so the whole grid is minutes. Record **grid-best** by the same utility.
- Run the archive/mutation loop overnight as specified.
- Validate **grid-best** and **loop-best** on the **same** held-out retrieval set and the **same**
  capped end-to-end checkpoint, so all comparisons are apples-to-apples.

**Interpretation (state this in the report):** if the loop merely rediscovers grid-best, that is a
**pass** — it proves the loop behaves correctly in a known-small search space. If the loop
underperforms grid-best, that is a **loop bug signal**, not a config insight. If it beats grid-best
(possible via the cost/MRR tradeoff), note it but don't over-read it. The question being answered is
"did the loop behave correctly versus an exhaustive reference?", not "did it find something
exhaustive search couldn't."

Expose this via a `--grid` flag (and include the grid in `--dry-run`).

---

## 8. Gates (run before launch; do not launch unless all pass)

- **Gate 0 — isolation preflight (run first, before any write).**
  - Confirm the benchmark instance's effective collection is `bench_<runid>` and **is not**
    `sage_mem_v2`. If it cannot be verified, **stop + `GATE_FAILURE.md`**.
  - Confirm the benchmark instance is a **separate process/port** from the real running Sage.
  - Confirm **mem0 and Zep are disabled** and the **query cache is disabled** on the benchmark instance.
  - Confirm no real user scope appears in the generated data.
- **Gate 1 — non-degenerate, deterministic, complete, uncached.** After populate, score the dev set at
  baseline via `/admin/retrieve`. Check: a real number is produced; it is **non-degenerate** (not
  all-zero, not all-identical across questions); **every gold marker is retrievable** (populate
  completeness, §5); scoring is **deterministic** (run twice, identical); and `cacheHit=false` on every
  retrieve. Any cache hit during scoring ⇒ **stop + `GATE_FAILURE.md`**.
- **Gate 2 — knobs change retrieval behaviour (not just aggregate score).** Set `semanticTopK=1` and
  `semanticTopK=30` and re-run. Confirm **at least one** of these changes: `semanticMemories.length`,
  returned memory ids, `contextTokenCount`, per-question MRR, or aggregate utility. **Prefer a tiny
  adversarial gate fixture** where the gold marker is only retrievable at higher K, so the difference is
  guaranteed to surface. If nothing changes ⇒ knob ignored or cache masking ⇒ fix before proceeding.
- **Gate 3 — both loop branches fire (deterministic).** Using **forced candidates**, not random
  mutation: feed one **known-bad/regressive** config (e.g. `semanticTopK=0, episodicTopK=0,
  contextMaxTokens=200`) and one config likely to score **differently/better** (e.g. `semanticTopK=20`
  with a generous budget). Confirm **both the keep and the revert code paths are exercised** and the
  archive records both decisions before unattended launch.

---

## 9. Outputs, run manifest, and version control

**Run manifest** (`manifest.json`, written at start, in git): repo commit SHA, branch name, run id,
Sage port, benchmark collection name, benchmark seeds, dev/held-out set sizes, knob bounds, checkpoint
call budget, baseline config snapshot, measured determinism noise band.

**Morning report** (`RUN_REPORT.md`, committed) must include a **comparison table** of, all scored on
the same dev set / held-out set / checkpoint:
- **baseline config** (the snapshotted default) — utility,
- **grid-best config** (§7.1) — config + utility,
- **loop-best config** — config + utility,
- **held-out retrieval result** for grid-best and loop-best,
- **capped end-to-end checkpoint result** for grid-best and loop-best (or a clear note if external
  benchmarks were skipped).

Plus: a one-line verdict on whether the loop **matched / beat / underperformed** grid-best (per §7.1
interpretation), iterations run, wall-clock elapsed, estimated checkpoint spend, any overfitting flags,
and a **"night-two levers"** section listing the code-level retrieval targets (scope-filter fix,
cross-bucket ranking, dedup/reranking, query rewriting) with why each should help.

**Version-control discipline:**
- **Commit:** source/harness scripts, config templates, the three admin hooks, `manifest.json`, a
  **compact archive summary**, and `RUN_REPORT.md` / `GATE_FAILURE.md`.
- **Do not commit:** secrets, `.env.local`, or large per-iteration logs. Store large logs under a run
  directory and add them to `.gitignore` unless intentionally compact.

---

## 10. Landmines to respect (from the reports — don't relearn these the hard way)

- **SECRET-word silent store-block** — see §4; forbidden words must not appear in any generated text;
  validate before population (`SETUP_STATUS.md` #2).
- **Semantic recall isn't scope-filtered** — isolate via `bench_<runid>` + unique marker codes; assume
  cross-scope bleed within the collection and make markers unique (`SAGE_ANALYSIS.md §7.4`).
- **Default 200 ms retrieval window truncates recall** — set budget/timeouts generous and **fixed**;
  the loop must not tune them down (`SETUP_STATUS.md`, `SAGE_ANALYSIS.md §2.4`).
- **`topK` ≠ chat retrieval depth** — tune `semanticTopK`/`episodicTopK` (`SAGE_ANALYSIS.md §2.2`).
- **mem0 extracts 0 facts; structured channel is effectively empty** — run on the semantic (Qdrant)
  channel with mem0/Zep off (`SETUP_STATUS.md` #3, `SAGE_ANALYSIS.md §5`).
- **Identity & episodic reads are in-process/ephemeral** — durable recall is semantic search over
  Qdrant; populate-once + in-process config mutation keeps ephemeral buckets alive across iterations
  (`SAGE_ANALYSIS.md §1.2 caveat, §5`).
- **`get_memories` uses a fixed `tool-memory` scope and omits episodic** — do not use it for scoring;
  use `/admin/retrieve` (`SAGE_ANALYSIS.md §4.6`).
- **Parsed-but-unused extraction knobs** do nothing — don't tune them (`SAGE_ANALYSIS.md §2.10`).
- **`SAGE_DEFAULT_MODEL` 404** — the checkpoint calls the real model; ensure a valid default
  (`gpt-5.2` / `gpt-4.1-mini`) or pass `model` explicitly (`SETUP_STATUS.md` #1).

---

## 11. Implementation verification (Gate 4 — read-only, runs before launch)

Because no human is reviewing this run live, add one automated conformance check after Gates 0–3 pass
and **before** the detached launch. Spawn a **read-only subagent** (its own context window, read/grep
tools only — **no write/edit/exec tools**, no code changes). This is a single sequential audit, **not**
agent teams and **not** a remediation loop. It classifies and either halts or proceeds; **it never
fixes anything, and the builder must not enter a fix-and-recheck loop.**

The subagent audits the built implementation against the spec and writes **`VERIFICATION.md`**. Two
tiers:

**Hard-blocking checklist — if ANY fails: do not launch.** Write `VERIFICATION.md` (findings) and
`GATE_FAILURE.md`, leave everything un-launched for morning review, and stop.
- **Isolation:** effective collection is `bench_<runid>`, not `sage_mem_v2`; the benchmark Sage is a
  separate process/port from the real instance; no real user scope appears in synthetic data.
- **No model-call leakage:** population uses `/admin/ingest` (not `/v1/chat/completions`); the inner
  loop and `/admin/retrieve` make zero upstream model calls; the only model calls are the capped
  checkpoint.
- **Backends off:** mem0 and Zep disabled and query cache disabled on the benchmark instance.
- **Forbidden words:** the generator validates all generated text (memory text, distractors, questions,
  marker codes) against `/secret|password|token|api ?key|card|ssn/i` and fails before population; none
  are present.
- **Admin routes guarded:** disabled by default, require `SAGE_ADMIN_ENABLED`, localhost-bound,
  bearer-authed; `/admin/memory-config` allowlists only the intended read-side keys and rejects unknown
  keys.
- **Scope held:** no code-level retrieval changes (no new cross-bucket ranking, scope-filtering, query
  rewriting, dedup) — only read-side config knobs are mutated.
- **Caps + audit trail present:** checkpoint budget and run caps enforced; detached launch writes
  `RUN_STATUS.md` with all required fields; loop persists state for crash-resume.

**Advisory checklist — log in `VERIFICATION.md`, may proceed:** post-trim `contextBlock` scoring (not
pre-trim); determinism check + noise-aware keep threshold; populate-completeness check; two-tier
overfitting control; grid comparison mode + report table; complete manifest; clean git discipline.

**Decision rule:** all hard items pass → proceed to launch (§12), with advisory findings logged and
committed. Any hard item fails → **halt, do not launch**, write the two reports, wait for morning.

> Honest limitation: this verifier shares the builder's model and so shares its blind spots — it is
> strong at catching *implementation-vs-spec drift* (the thing the human review loop mostly caught) and
> weak at catching shared reasoning errors. It is a safety gate, not a substitute for the morning
> cross-model review of `VERIFICATION.md` + `RUN_REPORT.md`.

---

## 12. Unattended launch mechanics

After Gates 0–4 pass, launch the loop as a **detached process** (`tmux`, `nohup`, or `screen`) so it
survives the Claude Code session disconnecting. Write **`RUN_STATUS.md`** containing: run id, PID,
exact command used, run directory, stdout/stderr log paths, benchmark collection name, Sage port,
**resume command**, and **stop command**. Verify the process is still running after detaching before
considering the launch done.

---

## 13. Plan-mode instruction

Before building: read `SETUP_STATUS.md`, `SAGE_ANALYSIS.md`, and skim EvolveMem (non-blocking). Then
present a plan covering the three hooks, the generator + validations, the harness, Gates 0–4, the caps,
and the detached-launch mechanics. **Wait for my approval.** On approval: implement, pass the gates,
then launch the detached run and write the report. If you hit a blocker you can't safely resolve, stop
and write it up rather than guessing. **Stay within V0.1 scope.**
