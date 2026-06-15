# GATE_FAILURE.md

Run r2026061322202_20a0_dry HALTED before launch — a gate did not pass. Nothing was launched.

- failed gate: **Gate 2**
- reason: semanticTopK=1 vs 30 changed nothing (knob ignored or cache masking)

## evidence
```json
{
  "lowK": {
    "len": 5,
    "tokens": 870,
    "goldPresent": false
  },
  "highK": {
    "len": 5,
    "tokens": 870,
    "goldPresent": false
  },
  "lenChanged": false,
  "tokChanged": false,
  "recallChanged": false
}
```

## diagnosis / next step
Review the evidence above and the loop log under logs/. The harness made no
code/config changes to force a pass. Fix the root cause, then re-run the gates
phase: `node overnight/harness/loop.js --phase gates --run r2026061322202_20a0_dry`.