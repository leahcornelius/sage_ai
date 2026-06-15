# GATE_FAILURE.md

Run r2026061322160_2513_dry HALTED before launch — a gate did not pass. Nothing was launched.

- failed gate: **Gate 1**
- reason: partial retrievals (warmup)

## evidence
```json
{
  "partials1": 26,
  "partials2": 26
}
```

## diagnosis / next step
Review the evidence above and the loop log under logs/. The harness made no
code/config changes to force a pass. Fix the root cause, then re-run the gates
phase: `node overnight/harness/loop.js --phase gates --run r2026061322160_2513_dry`.