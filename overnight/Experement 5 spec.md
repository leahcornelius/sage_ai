# EXPERIMENT 5 — Autonomous self-improving loop over a local clean-fact substrate

**Branch:** `experiment/5-autonomous-cleanfact` off `experiment/4-memory-substrate`
**Mode:** fully autonomous, unsupervised, ≤24h. Human (Leah) is away; audits on return.
**Caps:** wall-clock **24h**, cloud spend **$80**, **3** distinct-hypothesis rounds per gate.
**Prime principle (unchanged from the whole arc):** self-improvement only counts where
success is **verifiable**. A true negative or a clean fallback beats a flattering
unverified positive. **Nothing auto-merges. Everything stays on the branch for human audit.**

This experiment does two things at once:
1. **The object-level experiment** — build a local clean-fact extraction substrate (the
   $0 local replacement for the dead cloud-mem0 path) and run the gated self-improving
   loop on it.
2. **The meta-experiment** — replace the human-in-the-loop adjudicator (the role Leah/Nyx
   has played across Exp1–4) with a **spawned Claude subagent** that makes the calls
   autonomously. This is itself a test of agentic self-improvement.

Both are protected by the same guarantee: **if anything fails, fall back to a known-good
path so a real result always comes back.**

---

## 0. Roles

- **Builder** = the main Claude Code agent (the fresh chat that runs this spec). Does all
  the work: builds the substrate, runs the loop, hits gates, writes plans, implements the
  Adjudicator's decisions, runs commands, installs models. Has full sandbox authority
  (granted by Leah). **Cannot proceed past a breached gate without Adjudicator sign-off.
  Cannot merge to `main`.**
- **Adjudicator** = a **spawned Claude Code subagent** (via Task; headless `claude -p`
  fallback). Plays Nyx's role: reviews the Builder's plans, adjudicates gate failures,
  decides next steps. Seeded with the static context pack + rolling carryover. **Binds the
  Builder for the gate under review. Cannot merge, cannot ship, cannot weaken a gate
  definition.** Its full prompt is §7.

Implementer proposes, adjudicator disposes, nothing ships. This separation is the safeguard
— **but it is imperfect** (same model family → shared blindspots; see Exp1 VERIFICATION's
honest-limitations note). Real safety comes from the objective gates + nothing-auto-merges
+ Leah's audit, not from the agent-review alone.

---

## 1. The guaranteed-fallback ladder (read this first)

Every failure has a defined floor. There is no path that comes back empty.

| Stage fails | After ≤3 adjudicator rounds, fall back to | Result you get |
|---|---|---|
| **Phase 0** (autonomous machinery) | **HALT + report** (no autonomous run on broken machinery) | a diagnosis of why the machinery doesn't work |
| **Phase 1** (clean-fact substrate build) | **disable clean-fact path**, run Phase 2 on the **current** substrate | the Exp3-style retrieval result on known-good substrate |
| **Phase 2** (gated loop) | **revert the failing change**, report the **honest negative finding** + best config found | a real verdict (improvement or honestly "no improvement") |

Adjudicator bias: **prefer fallback over total-halt** (fallback always yields a result).
**Total-halt only if even the fallback is compromised** (should not happen below Phase 0).

---

## 2. Prerequisites (Leah sets these BEFORE pressing run)

The Builder must check all of these at startup and **fail fast with a clear message** if any
are missing — do not limp forward.

1. **Sage stack up:** Qdrant, Redis, Ollama running. Models pulled: `qwen3:14b` (extraction
   + LoCoMo judge), `nomic-embed-text` (embeddings). ~10GB disk headroom if `qwen3:14b`
   isn't already local.
2. **`OPENAI_API_KEY` set** in the env — used only for the LoCoMo answerer (`gpt-5.4-mini`)
   and the optional final red-team. If absent: the LoCoMo checkpoint **skips with a loud
   logged note** and the result is flagged "in-sample only, transfer unverified" (it does
   **not** halt the experiment). Recommend setting an **OpenAI-side hard billing cap ≤ $80**
   as a backstop.
3. **On the branch:** `git checkout -b experiment/5-autonomous-cleanfact experiment/4-memory-substrate`
   (Exp4's validated substrate + contract suite). Exp4 tree is clean/committed already.
4. **Claude Code config:** plan mode on; `/effort xhigh` for planning, `high` for
   execution; **subagents/Task available** (verify the Builder can spawn one — Phase 0
   tests this); **no agent teams, no ultracode**; default tools.
5. **Contract suite green at start:** `npm run test:contracts` must pass before anything
   else (the substrate is only trustworthy if it does). If red → HALT + report.

---

## 3. PHASE 0 — prove the autonomous machinery (do this first, every time)

Do **not** run the real experiment on unproven machinery. Build and validate the
spawn→adjudicate→act loop against synthetic inputs.

**Build:** the harness function that, on a gate breach, (a) packages the gate result +
Builder plan + relevant artifacts + current carryover, (b) spawns the Adjudicator subagent
with static-seed + carryover + package, (c) parses its structured decision + carryover,
(d) acts on the decision, (e) logs everything to `overnight/runs/<runid>/ADJUDICATION_LOG.md`.

**Tests (all must pass):**
- **T1 happy path:** inject a *synthetic* gate failure with an obvious fix. Expect:
  Adjudicator spawns, returns a valid structured decision (APPROVE/REDIRECT), Builder acts,
  synthetic gate clears, everything logged, **nothing merged**.
- **T2 fallback path:** inject a synthetic failure that is *unresolvable* in 3 rounds.
  Expect: 3 distinct rounds attempted, then **clean drop to the defined fallback**, logged.
- **T3 carryover:** confirm round N's `CARRYOVER` block is present and is actually appended
  to round N+1's prompt.
- **T4 caps:** confirm wall-clock, spend, and round counters are live and the harness
  **hard-stops** when tripped.
- **T5 isolation:** confirm the run touches only `experiment/5-*` and throwaway
  `sage_contract_*` / bench collections; dev `sage_mem_v2` untouched.

**Gate 0:** all of T1–T5 green → proceed to Phase 1. **Any red → HALT + write
`overnight/runs/<runid>/PHASE0_FAILURE.md`** (the autonomous test failed; there's nothing to
fall back *to* for the autonomy experiment, and Leah must fix the machinery). This is the
**one** place total-halt is correct.

---

## 4. PHASE 1 — build the local clean-fact substrate

**Goal:** a deterministic, $0, local extraction path that turns conversation turns into
**distinct atomic facts** stored as **clean** vectors — the thing that could make buried
gold retrievable where raw homogeneous turns can't.

**Design:**
- A post-ingest (or at-ingest) pass per scope calls **local `qwen3:14b`** (Ollama,
  temperature 0, fixed prompt, fixed seed where supported) with an extraction prompt:
  *"Extract distinct atomic facts from these turns as structured items
  `{fact_text, fact_key, scope}`; no duplication; one fact per item."*
- Store each fact as a clean point: **embed `fact_text` only** (D3.1 hygiene done right);
  put `scopeKey`, `fact_key`, source turn ids, version in Qdrant payload `metadata`.
- Clean-fact points live in their own logical space (or clearly tagged) so retrieval can
  draw on distinct fact vectors **in addition to** the raw episodic ring buffer, not
  instead of it.
- This **replaces cloud mem0**; mem0 stays OFF/inert. Resolves the mem0 + D3.1 flags.

**Pre-gates (substrate validity — Gate 1):**
- **1a — extracts:** >0 and a *sane* count of distinct facts on the frozen fixture (not 0
  like mem0, not absurd over-extraction). Define "sane" against the fixture's known fact
  count ±tolerance; the Adjudicator rules on borderline counts.
- **1b — hygiene:** a **new contract test** (extend `overnight/contracts/`) proves
  `fact_text`-only embeddings, `scopeKey` in payload, in-scope retrievability. Red→green.
- **1c — determinism:** same input → same fact set within a stated tolerance (extraction
  is LLM-driven; characterize and bound the nondeterminism, don't pretend it's zero). If
  variance is too high to benchmark on → that's a Gate-1c failure → adjudicate.
- **1d — contract suite still green:** full `npm run test:contracts` passes with the new
  path added.

**On Gate 1 failure:** spawn Adjudicator → ≤3 distinct-hypothesis rounds → if still failing,
**disable the clean-fact path and proceed to Phase 2 on the current substrate (fallback).**

---

## 5. PHASE 2 — gated self-improving loop

The EvolveMem-style loop from Exp1 (diagnosis → propose → apply → evaluate → keep/revert),
now over the clean-fact-enriched substrate (or the current substrate if Phase 1 fell back).

**Benchmark:** the **Exp2 buried-gold semantic-stress benchmark** (gold buried past the
20-turn episodic window; 12 scopes; dev + held-out split). This is the right benchmark
*because* the clean-fact layer's only reason to exist is surfacing buried gold the episodic
ring can't reach.

**Gates (from Exp1, plus the checkpoint):**
- **G0 infra** — backends reachable, benchmark loads, harness sane.
- **G1 benchmark validity** — completeness counts **live** points only (Exp4 lesson);
  offline preview is **not** treated as a live proxy (Exp4 lesson).
- **G1b semantic channel exercised** — the clean-fact/semantic channel actually carries
  retrieval (not silently episodic-only as in Exp1). Define the scoped-vs-episodic
  contribution split; the channel must be non-vacuous.
- **G2 no-crash** — runs detached without falling over; rate-limit backoff handled.
- **G3 convergence + honesty** — loop converges; **held-out** result reported; compared to
  grid baseline. **A win must be on held-out, not dev** (Exp1 dodged the cost-term overfit
  trap — preserve that discipline).
- **G4 LoCoMo transfer checkpoint** — best config re-checked on LoCoMo (`locomo10.json`,
  CC-BY-NC): answerer **`gpt-5.4-mini`** held constant, **local `qwen3:14b` judge**
  (answerer ≠ judge). Skips-with-note if no `OPENAI_API_KEY`.

**The real question G3 answers:** does retrieval over the **clean-fact layer** beat the
raw-episodic baseline on buried gold? **"No improvement" is a valid, valuable finding** —
it gets reported honestly, the change is reverted, and the result is "clean-fact layer does
not help buried-gold retrieval on this benchmark," which is a real answer.

**On any Phase-2 gate failure:** spawn Adjudicator → ≤3 distinct-hypothesis rounds → if
still failing, **revert the failing change and report the honest negative + best config.**

---

## 6. The adjudication cycle (spawn → adjudicate → act)

Triggered on **any** breached gate in Phases 1–2.

1. **Builder packages:** the gate id + its numbers, the Builder's proposed plan (or "no
   plan — need direction"), relevant artifacts (run report, diffs, contract output), and the
   current rolling `CARRYOVER`.
2. **Builder spawns Adjudicator** (Task) with: **static context pack** (§8) + **rolling
   carryover** + this package.
3. **Adjudicator reviews and returns a structured decision** (§7 output format):
   `APPROVE` · `REQUEST_CHANGES` (back-and-forth, **max 3 exchanges**, then it must decide)
   · `REDIRECT[new hypothesis]` · `ACCEPT_HALT→FALLBACK` · `HALT_ENTIRELY` — plus
   `RATIONALE` (logged) and `CARRYOVER` (appended to the next spawn).
4. **Builder implements** the approved/redirected decision, re-runs the gate.
5. Still failing → **new round** (a *distinct* hypothesis). **Max 3 rounds per gate.** Then
   fall back per §1.

**Round discipline (hard):** each round is a **genuinely new principled hypothesis** with a
stated rationale — **not** the same change tuned toward the threshold. If the Adjudicator
cannot articulate a new hypothesis, it returns `ACCEPT_HALT→FALLBACK` rather than burning a
round on a tweak. This is the anti-"iterate-until-green" rule, enforced by the Adjudicator.

**Global caps across the whole experiment:** ≤ ~20 total adjudicator spawns (quota
protection), 24h wall-clock, $80 cloud spend. Harness hard-stops on any.

---

## 7. THE ADJUDICATOR PROMPT (paste into the spawn)

> You are the **Adjudicator** for an autonomous self-improvement experiment on "Sage", a
> hobby memory-retrieval server. You are standing in for a human reviewer (Nyx) who has
> overseen four prior experiments. **Your job is to protect the integrity of the result —
> not to make progress.** A true negative or a clean fallback is a SUCCESS. A flattering but
> unverified positive is a FAILURE.
>
> **What you are reviewing:** the Builder agent has hit a benchmark gate. You will receive
> (a) a static context pack summarizing the project arc and its hard-won lessons, (b) a
> rolling carryover from prior adjudications this run, and (c) this gate's failure: the
> numbers, the Builder's proposed plan, and the relevant diffs/artifacts. You may read the
> repository and run read-only commands to verify claims.
>
> **Non-negotiable discipline (from the arc):**
> 1. **Verifiable success only.** If success can't be measured cleanly, it doesn't count.
> 2. **Never game a gate.** Do not weaken a threshold, do not reframe a miss as a win, do
>    not recruit a confound to explain away a miss. Changing the *measurement* to be more
>    honest is allowed; changing it to pass is forbidden. The test: *does this change the
>    system, or just the scoreboard?*
> 3. **One principled change per round; each round a DISTINCT hypothesis.** No tuning toward
>    the threshold. If you cannot state a genuinely new hypothesis, choose
>    `ACCEPT_HALT→FALLBACK`.
> 4. **Accept findings.** "It doesn't help" is a real result. Report it; don't bury it.
> 5. **Scope discipline.** Stay on the memory-retrieval substrate + harness. Don't sprawl.
> 6. **Bias to fallback on interpretive calls.** When a judgement is genuinely ambiguous,
>    choose the safe fallback over a creative forward reframe. Prefer fallback over
>    total-halt — the fallback always yields a result.
>
> **Lessons you must apply (the arc earned these):**
> - Recall can come entirely from the episodic ring buffer while semantic contributes
>   nothing (meanMRR=0). Demand evidence the semantic/clean-fact channel is actually
>   exercised before crediting it.
> - Offline within-scope cosine rank is **not** a proxy for live retrieval. Trust live
>   numbers.
> - A silent ingest-time merge once soft-deleted the gold and invalidated a diagnosis;
>   always check the substrate is doing what it claims (the contract suite is your friend).
> - Scope-filtering turned out **incremental**, not dramatic — don't assume a lever is big
>   because it's plausible. Let the benchmark decide.
> - A confident diagnosis was once flat wrong (Exp2). Hold your own conclusions loosely;
>   prefer the boring verified explanation.
>
> **Your authority and limits:** your decision **binds the Builder for this gate**. You
> **cannot** merge to main, ship, or alter a gate's definition. Everything stays on the
> branch. You **must** log your rationale.
>
> **Escape hatches (use narrowly):**
> - `ACCEPT_HALT→FALLBACK`: choose this when ≤3 rounds are exhausted, when no new principled
>   hypothesis exists, or when proceeding would require a **genuine human-only action** you
>   cannot perform (e.g. an external secret/API key/account the sandbox can't provision —
>   note that the Builder *can* run commands and install models, so this set is small).
> - `HALT_ENTIRELY`: only if even the defined fallback is pointless or compromised. This
>   should essentially never fire below Phase 0.
>
> **Output EXACTLY this structure:**
> ```
> DECISION: <APPROVE | REQUEST_CHANGES | REDIRECT | ACCEPT_HALT_FALLBACK | HALT_ENTIRELY>
> HYPOTHESIS: <if REDIRECT: the distinct, principled hypothesis for this round; else "n/a">
> RATIONALE: <why — cite the specific numbers/diffs/lessons; name any gaming smell you
>   rejected; if you're biasing to fallback, say so and why>
> CARRYOVER: <what the NEXT adjudicator must know: current state, hypotheses tried and
>   rejected this run and WHY, open concerns, anything that smells off, round count used>
> ```
>
> Be terse and technical. No flattery. Decide.

---

## 8. Static context pack (assembled once, fed to every spawn)

The Builder assembles this at startup into a single text block and prepends it to every
Adjudicator spawn (ahead of the rolling carryover):

- `overnight/journal.txt` arc summary (one paragraph per experiment).
- The **lessons digest** (the bullets in §7 "Lessons" — keep verbatim).
- `overnight/MEMORY_CONTRACTS.md` and `overnight/DEFECT_INVENTORY.md` (the validated
  substrate's contracts + known landmines).
- Exp1–4 outcome one-liners: machinery-proof + meanMRR=0; semantic-stress halt; scope-filter
  **incremental** verdict (gap 0.125, pure-scoping +0.25, pipeline −0.125); substrate
  characterized + merge fix (130→620).
- This spec's §1 fallback ladder and §6 round discipline.

Keep it tight — it's a seed, not a dump. If it's too long for the subagent budget, prefer the
lessons digest + contracts + fallback ladder over raw run logs.

---

## 9. Safety, logging, audit (the load-bearing part)

- **Nothing auto-merges.** All work on `experiment/5-autonomous-cleanfact`. No pushes to
  `main`. No `git push` at all unless the Builder is explicitly told to open a PR (it isn't).
- **`overnight/runs/<runid>/ADJUDICATION_LOG.md`** — every spawn appended: gate, package
  summary, the Adjudicator's full structured output, what the Builder did, the gate re-result.
  This is what Leah audits to judge the *reasoning*, not just the outcome.
- **`overnight/runs/<runid>/EXPERIMENT_5_OUTCOME.md`** — the honest report: what was built,
  every gate result, every adjudicator decision + why, where it fell back, and a plain
  readiness/verdict. Must state clearly whether the clean-fact layer **helped, didn't help,
  or wasn't reached**, and whether the autonomous adjudicator behaved sanely.
- **Optional cross-model red-team:** if `OPENAI_API_KEY` is set, after the outcome doc is
  written, make **one** OpenAI call asking an independent model to review the outcome doc for
  overclaiming / gaming / unsupported conclusions. Log its reply verbatim in the outcome doc
  under "Independent cross-model review." Non-blocking; counts against the $80.
- **Caps are hard.** On any cap trip (24h / $80 / round / spawn count), the Builder stops the
  current phase, falls back per §1, writes the outcome doc, and exits cleanly.

---

## 10. Exit criteria

The experiment is **done** (success) when any of these holds and the outcome doc + adjudication
log are written:
- Phase 2 produces a held-out verdict (improvement **or** honest no-improvement), LoCoMo
  checked or skip-noted; or
- A fallback fired cleanly and produced a real result on the current substrate; or
- A cap tripped and the floor result was written.

The experiment **failed** only if Phase 0 halted (broken machinery) — in which case the
PHASE0_FAILURE.md diagnosis is the deliverable.

Either way: **a real artifact comes back, and nothing reached `main` without Leah's eyes.**