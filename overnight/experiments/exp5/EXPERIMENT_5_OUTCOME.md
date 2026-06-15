# Experiment 5 — Outcome: autonomous self-improving loop over a local clean-fact substrate

**Branch:** `experiment/5-autonomous-cleanfact` (off `experiment/4-memory-substrate`)
**Run:** `r2026061508531_230d` · **Date:** 2026-06-15 · **Mode:** fully autonomous, unsupervised
**Caps used:** wall-clock ~1.7h / 24h · cloud spend **$0** / $80 · adjudicator spawns **2 / 20**
**Result class (spec §10):** a fallback fired cleanly and produced a real result on the current
substrate (positive object-level finding, but synthetic-bench only / transfer-unverified).
**Nothing merged; nothing pushed; all on the branch for audit.**

---

## 1. TL;DR

- **The run's success criterion is met (spec §10): a real, honest result came back and nothing
  shipped.** The object-level result is positive **but synthetic-bench only and transfer-unverified**;
  the meta-level adjudicator behaved with discipline *on the available evidence* — though that is in
  part a self-assessment (implementer and adjudicator share a model family, an imperfect safeguard
  per spec §0), and the §8 independent red-team graded the first draft **OVERCLAIMS**, which this
  version tempers.
- **Object-level finding (the headline):** the new **local clean-fact layer substantially improves
  buried-gold _marker_ retrieval _on the synthetic bench_** — episodic-only recall **0.000 →
  scoped-semantic recall 0.656**, baseline utility **~0.11 → 0.50**. Caveat: the bench scores on
  opaque 8-char markers, so part of this lift may be verbatim-string surfacing rather than semantic
  transfer (only LoCoMo/held-out would separate the two). It **does NOT satisfy Gate 1b's scoped-vs-
  unscoped gap criterion** (`scopedGap = 0.156 < 0.3`), *because the clean facts are retrievable
  unscoped too* (unscoped recall ≈ 0.50). Scoping remains an **incremental** lever, reconfirming
  the arc's V0.3 verdict on a substrate where the semantic channel is, for the first time,
  genuinely populated and exercised. **This gain is on the synthetic bench only and is
  transfer-UNVERIFIED** (G4/LoCoMo was never reached — the run halted at G1b before it).
- **Meta-level finding:** the **spawned-Claude Adjudicator behaved with checkable discipline**
  (normative "sanity" is deferred to Leah's audit — §5). The checkable facts: it verified the numbers
  against the artifacts itself, **rejected three gaming/tuning hypotheses by name** (enumerated in §5,
  including the one the Builder flagged), accepted the structural halt, spent **0 of 3 tuning rounds**,
  respected its authority limit (would not alter a gate), and **escalated the gate-redefinition
  question to the human rather than self-resolving it.** Caps bound structurally in code (persisted
  counters, hard-refuse), proven in Phase 0.
- **Two questions are surfaced to Nyx, not self-resolved** (§6).

---

## 2. What was built

### Phase 0 — autonomous adjudicator machinery (Gate 0 PASS)
- `overnight/harness/adjudicator.mjs` — capped spawn→adjudicate→act→log harness. **Caps bound in
  code** (Leah's revision 1): persisted counters in `adjudicator-state.json` hard-refuse past
  spawn-count 20 / 3-rounds-per-gate / 24h. **`claude -p` is the sole real-spawn path**; the Agent
  tool was demoted to a one-time Phase-0 proof.
- `overnight/harness/adjudicator.test.mjs` — T1–T5 **5/5 green**, incl. **T4 counter-refusal**
  (refuses at each cap edge without ever shelling `claude -p`).
- Live proof: one real `claude -p` capped spawn (valid decision, counters persisted, logged) + one
  Agent-tool proof. **Gate 0 PASS.**

### Phase 1 — local clean-fact substrate (Gate 1 PASS)
- `src/services/memory/ollama-chat.js` + `local-extractor-adapter.js` — a **$0 local** (qwen3:14b
  /Ollama, temp 0 + seed) per-turn extractor replacing dead cloud-mem0; preserves codes verbatim;
  gated by `SAGE_CLEANFACT_ENABLED` (default OFF). **mem0 stays OFF/inert.**
- Rewrote `mnemosyne-adapter.js upsertSemanticFacts`: **embed fact-text only** (resolves D3.1) +
  **raw `db.store`** (Exp4 merge-bug fix applied to the semantic path) + scope-tagged metadata
  (`memoryClass:"semantic_fact"`, `scopeKey`, `factKey`, …). Removed mem0-era conflict helpers.
- Wired into controller/service/env/benchEnv; new `clean-fact-hygiene.contract.test.mjs`; the
  `cleanfact-validate.mjs` harness.
- **Gate 1:** 1a markers preserved **12/12 (1.0)**, sane count; 1c determinism **1.0** (verified
  3× identical output); 1b/1d `test:contracts` **33/33**; full repo `npm test` **135/135**. No
  regressions. Docs updated (`MEMORY_CONTRACTS` #2/#8, `DEFECT_INVENTORY` #2b FIXED / #8 RESOLVED).

---

## 3. Every gate result

| Gate | Result | Key numbers |
|---|---|---|
| **Gate 0** isolation (loop) | ✅ PASS | bench Sage isolated; mem0/zep disabled; cleanfact addition didn't disturb it |
| **Gate 1** validity | ✅ PASS | baselineUtility **0.5029**, deterministic=true (vs ~0.11 episodic-only prior) |
| populate completeness | ✅ true / missing 0 | 620 turns → **1241 live points** (~620 episodic + ~621 clean-fact); all gold retrievable scoped at generous K |
| **Gate 1b** scoped channel | ❌ **FAILED (scopedGap)** | mrrA **0.731** ✓, recallB′(scoped semantic) **0.656** ✓, recallC(episodic-only) **0.000** ✓, attribution **1.00** ✓, **scopedGap 0.156 < 0.3** ✗ |
| **G2 / G3 / loop / G4 LoCoMo** | ⛔ **NOT REACHED** | halted at G1b (structural; "accept the halt, do not retry") |

**G1b decomposition (control probe):** recallB′ 0.656; B_unscoped 0.500; control B_dbsearch_unscoped
0.438; **pureScoping +0.219**, **pipeline −0.063**, net scopedGap **0.156**. Benchmark validity:
620 markers, goldFallbackRate 0.060 (94% had a proper paraphrase gap).

---

## 4. The honest interpretation (no overclaim, no buried miss)

- **The clean-fact channel is genuinely exercised and carries the gold** — the inverse of the
  Exp1 "recall is episodic-only, meanMRR=0" pathology. recallC (episodic-only) = 0.000 proves the
  gold is buried out of the ring; recallB′ (scoped semantic) = 0.656 with mrrA 0.731, attribution
  1.00 proves the clean-fact layer surfaces it. **4 of 5 G1b criteria pass.**
- **The clean-fact layer is a large improvement on the object-level question** ("does retrieval
  over the clean-fact layer beat the raw-episodic baseline on buried gold?"): episodic 0.000 →
  0.656; utility ~0.11 → 0.50.
- **The single failing criterion, scopedGap (0.156 < 0.3), is a real and informative negative:**
  it is small *because the clean facts work unscoped too* (B_unscoped ≈ 0.50). Scoping's marginal
  value is incremental, not dramatic — reconfirming V0.3. The clean-fact win is **NOT** a scoping
  win.
- **This gain is SYNTHETIC-bench only and transfer-UNVERIFIED.** The benchmark uses opaque 8-char
  markers; a clean-fact "win" there may partly be the layer surfacing a verbatim marker string
  rather than genuine semantic transfer. **G4/LoCoMo (the natural-language transfer check) was
  never reached** because the run halted at G1b. Per the arc's transfer-discipline (and Leah's
  revision 2), the gain is reported as **in-sample only** until LoCoMo/held-out verifies it.
- **We did NOT game the gate.** The tempting moves (make clean facts only-scoped to widen the gap;
  restore BM25 on the unscoped path; reframe scopedGap as "orthogonal" and forward-declare a pass)
  were each raised and **rejected** — by the Builder in the package and independently by the
  Adjudicator. Suppressing the unscoped baseline to inflate the gap would make the system worse to
  move the scoreboard.

---

## 5. Every adjudicator decision + why (the meta-experiment audit)

Full transcripts in `ADJUDICATION_LOG.md`. Caps state in `adjudicator-state.json`.

1. **Phase-0 live proof (synthetic, spawn #1):** `claude -p` capped helper, gate `SYNTH_PHASE0` →
   **APPROVE** of an obvious harness off-by-one fix, with a rigorous "system vs scoreboard"
   rationale citing the merge/dedup lessons. Proved the real path end-to-end (parse + counter +
   log). An Agent-tool spawn produced an equally valid parse (the demoted one-time proof).
2. **G1b adjudication (real, spawn #2):** `claude -p` capped helper, gate `G1b` →
   **ACCEPT_HALT_FALLBACK**. The Adjudicator independently **verified** the numbers against
   `loop-state.json` / the evidence log / `gates.js` line refs; confirmed the semantic channel is
   exercised (not the Exp1 pathology); identified the miss as honest (4/5 pass, scopedGap small
   because clean facts are good); chose fallback over a tuning round (0/3 used) and over total-halt
   (a real result exists); directed: keep clean-fact ON as best config, do NOT revert the layer,
   caveat the gain as synthetic-only, and **surface the transfer + gate-redefinition questions to the
   human.** The **three hypotheses it rejected** (so the reader can judge they were principled, not
   convenient):
   - **(a) make clean facts only-scoped** to widen the gap — rejected: suppresses the unscoped
     baseline to inflate the scoreboard (degrades the system to pass; classic gaming).
   - **(b) restore BM25/hybrid on the unscoped path** — rejected: would *raise* unscoped recall and
     *shrink* the gap (counterproductive), and is a deferred harness item.
   - **(c) reframe scopedGap as "orthogonal" and forward-declare a pass** — rejected: it cannot alter
     a gate, the measurement is already honestly computed (no bug to fix), so forward-passing on it
     would be the exact reframe the discipline forbids. (Surfaced to the human instead.)

**Did the autonomous adjudicator behave sanely?** On the available evidence, **yes** — but treat this
as a *qualified* judgement, because it is partly a self-assessment by a system whose implementer and
adjudicator share a model family (spec §0 flags this as an imperfect safeguard, and the §8 red-team
flagged this very section as the least independently-credible part). The *checkable* facts: it
verified numbers against the artifacts, refused the gaming the Builder explicitly flagged, accepted
the structural halt, spent 0/3 tuning rounds, respected its authority limit (would not alter a gate),
and escalated the gate-definition question rather than self-resolving it (`ADJUDICATION_LOG.md` is the
transcript). The *normative* labels ("integrity", "sane") rest on those facts plus Leah's audit — not
on the system's own say-so. The separation held — implementer proposed, adjudicator disposed, nothing
shipped — which is the real safeguard, not the agent-review alone.

---

## 6. Surfaced to Nyx (human-only — NOT self-resolved)

1. **Transfer verification.** The clean-fact recall gain (0.000 → 0.656) is synthetic-bench only.
   Before crediting it as a real improvement, run the LoCoMo / held-out transfer check (the answerer
   `gpt-5.4-mini` preflighted 200 OK, so it is runnable). Until then: **in-sample only, transfer
   unverified.**
2. **Is `scopedGap` the right gate for a clean-fact substrate?** G1b's `scopedGap ≥ 0.3` criterion
   (a V0.3 addition) tests *scoping's marginal value*, which is arguably orthogonal to the
   clean-fact hypothesis (clean-fact vs episodic recall, which the LOOP/G3 measures). The semantic
   channel IS exercised (the other 4 criteria). **Changing a gate definition is a human call** —
   the Adjudicator correctly refused to do it. If you decide scopedGap should not gate a clean-fact
   substrate, a re-defined G1b (e.g. "clean-fact vs episodic recall lift on held-out") would let the
   loop run and produce a held-out verdict on the object question.

---

## 7. Readiness / verdict

- **Clean-fact layer: HELPED** buried-gold *marker* retrieval **on the synthetic bench only** (large
  recall lift), **transfer UNVERIFIED, and it did not pass G1b's scoping-gap gate.** It passed Gate 1
  and is **kept ON, not reverted** — but "better substrate" is a claim that awaits transfer evidence.
- **Autonomous adjudicator: behaved with discipline on the available evidence** (verified claims,
  refused gaming, accepted the halt, escalated the gate question) — a *qualified* judgement pending
  Leah's audit, not an independent certification (shared model family; §8 red-team noted the limit).
- **The experiment did NOT reach the self-improving loop or LoCoMo** — it halted at the G1b
  pre-gate. That is the honest stopping point, accepted per the gate's own rule, not tuned past.
- **Exit criterion met (spec §10):** a fallback fired cleanly and produced a real result on the
  current substrate; nothing reached `main` without Leah's eyes.

**Deliverables:** this doc · `ADJUDICATION_LOG.md` · `adjudicator-state.json` · `PREREQS.md` ·
`PHASE1.md` · `cleanfact-validate.json` · `g1b-package.md` · `dryrun-gates-evidence.log` ·
`static-context-pack.md`. Commits: Phase 0 `d673558`, Phase 1 `8a40162`, + this outcome.

---

## 8. Independent cross-model review

(Appended below after the outcome doc was written — one OpenAI call, per spec §9.)

---

**Reviewer model:** `gpt-5.4-mini-2026-03-17` · tokens in/out: 3190/1199 · est cost ~$0.0032

## Adversarial review

### 1) Overclaiming / synthetic → general claim upgrading
- **Section 1 / 4 / 7**: “**substantially improves buried-gold retrieval**” is only justified on the synthetic bench, but the phrasing is repeatedly upgraded into a broader system claim (“the better substrate,” “real, honest, verifiable result,” “clean-fact layer helped”). The doc does caveat **synthetic-only / transfer-UNVERIFIED** clearly in §§1, 4, 6, which is good.
- Still, the headline improvement numbers (**episodic 0.000 → scoped 0.656; utility ~0.11 → 0.50**) are being narrated like a substantive capability gain, not just a benchmark-specific marker-surfacing result. The doc itself admits the benchmark uses **opaque 8-char markers** and may be partly a **verbatim-string retrieval** artifact (§4). That caveat materially weakens any broader “improves buried-gold retrieval” interpretation.
- **Section 4** does the right thing by explicitly limiting credit to **in-sample only** until LoCoMo/held-out transfer. That part is honest.

### 2) Benchmark gaming / gate weakening
- **Section 4 / 6**: The doc surfaces a real concern: re-scoping facts to be only-scoped, restoring BM25 on unscoped path, or redefining the gate would all be ways to inflate the scoped gap. Good that it names these as rejected.
- But **Section 6** then asks whether **scopedGap is the right gate** and suggests redefining G1b so the loop can continue. That’s not necessarily wrong, but it **moves the gate discussion into the outcome doc after failing it**, which can read like a post-hoc attempt to weaken the gate. The doc is transparent that the adjudicator refused to change the gate; that helps.
- The suspicious part is **Section 3 / 4**: “**Gate 1 PASS**” and “**4 of 5 G1b criteria pass**” sit adjacent to a failed G1b, which is easy to misread as overall success. The miss is present, but the framing is optimistic.

### 3) Unsupported conclusions
- **Section 5 / 7**: “**did real verification**,” “**behaved sanely**,” “**with integrity**,” “**anti-gaming**” are asserted with no external evidence beyond self-described transcript review. This is a classic self-evaluation problem.
- “**spent 0 of 3 tuning rounds**” and “**escalated ... rather than self-resolving**” are factual if logs support them, but “sanely” and “integrity-preserving” are normative conclusions that are not independently established here.
- **Section 5**: “**rejected three hypotheses by name**” sounds good, but the actual hypotheses are not enumerated in the outcome doc, so the reader cannot judge whether those rejections were principled or just convenient.
- **Section 2 / 3**: “**benchmark validity: 620 markers, goldFallbackRate 0.060 (94% had a proper paraphrase gap)**” looks like a lot of validity work, but there’s no compact explanation of how those metrics validate the benchmark against leakage or marker artifacts. It reads more like reassurance than proof.

### 4) Synthetic-only / transfer-unverified caveat and Gate-1b miss visibility
- **Good**: The doc explicitly says synthetic-only / transfer-UNVERIFIED in **§1, §4, §6, §7**. That caveat is not buried.
- **Also good**: **Gate 1b FAILED (scopedGap 0.156 < 0.3)** is stated plainly in **§1 and §3**.
- **Concern**: despite the explicit failure, the narrative repeatedly emphasizes “helped,” “better substrate,” “real result,” and “verifiable result,” which softens the failure. It’s not buried, but it is **a bit rhetorically sanded down** by the surrounding success language.
- The strongest honest statement is in **§4**: the win is **synthetic-bench only** and **transfer-UNVERIFIED**. That part is credible.

### 5) Credibility of “autonomous adjudicator behaved sanely”
- **Section 5** is self-serving. The system is evaluating itself, then concluding it was sane, disciplined, integrity-preserving, anti-gaming, and correctly bounded. That is not credible without independent inspection of the transcript/logs.
- The claim is somewhat supported by behavior described in the doc: it **verified numbers**, **accepted the halt**, **did not spend tuning rounds**, and **escalated** a gate-definition question. Those are plausible sanity signals.
- But the doc also says the adjudicator **rejected three hypotheses by name** and “biased to fallback” — without showing the content or criteria. That makes the “behaved sanely” verdict feel like **self-endorsement**, not independent assessment.
- Net: this section is **the least credible** part of the outcome.

### Bottom line
The doc is **better than average on caveats**: it does not hide the synthetic-only nature, and it does state the **G1b miss** plainly. But it still **leans hard into success language**, and the autonomous-adjudicator self-assessment is **not independently credible**. The “clean-fact helps” result is real only **on the synthetic marker bench**, and the transfer claim is correctly withheld.

**Verdict: OVERCLAIMS**

---

## 8.1 Builder response to the red-team (accepted → tempered)

The independent reviewer graded the first draft **OVERCLAIMS**. The critique is fair; I revised
rather than rebutted (the integrity loop working as intended):

- **"Leans into success language / synthetic gain narrated as a capability gain"** → ACCEPTED.
  §1 and §7 now inline the *synthetic-bench-only, transfer-unverified, marker-surfacing* qualifier on
  every "improves/helped/better-substrate" claim, and explicitly note part of the lift may be
  verbatim-string surfacing, not semantic transfer.
- **"§5 'behaved sanely' is self-serving / not independently established"** → ACCEPTED. §5 and §7 now
  separate the *checkable facts* (verified numbers, refused gaming, 0/3 rounds, escalated) from the
  *normative labels*, flag the shared-model-family limitation (spec §0), and defer the certification
  to Leah's audit + this red-team rather than the system's own say-so.
- **"Three rejected hypotheses not enumerated"** → ACCEPTED. §5 now lists all three with the reason
  each was rejected, so the reader can judge they were principled.
- **"Gate-redefinition discussion after failing the gate reads post-hoc"** → PARTIALLY. It is kept in
  §6 because the Adjudicator explicitly *refused* to act on it and surfaced it to the human; it is a
  question for Nyx, **not** a Builder/Adjudicator justification for the miss. The G1b failure stands.
- **"Benchmark-validity metrics read as reassurance not proof"** → NOTED. goldFallbackRate is a
  generation-quality signal (paraphrase gap achieved), not an anti-leakage proof; the real
  anti-artifact check is LoCoMo transfer, which was not reached and is flagged unverified.

**Net:** the honest, tempered verdict is — *the local clean-fact layer produces a large buried-gold
**marker-retrieval** lift on the synthetic bench; whether that is real semantic improvement is
**unverified** (no transfer check reached); it does **not** pass G1b's scoping-gap gate; the
autonomous adjudicator behaved with **checkable** discipline, with normative judgement deferred to
human audit.* Nothing merged; everything on the branch.
