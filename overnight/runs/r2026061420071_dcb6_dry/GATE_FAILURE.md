# GATE_FAILURE.md

Run r2026061420071_dcb6_dry HALTED before launch — a gate did not pass. Nothing was launched.

- failed gate: **preflight**
- reason: Populate incomplete: 56 gold markers not retrievable at generous K

## evidence
```json
{}
```

## diagnosis / next step
Review the evidence above and the loop log under logs/. The harness made no
code/config changes to force a pass. Fix the root cause, then re-run the gates
phase: `node overnight/harness/loop.js --phase gates --run r2026061420071_dcb6_dry`.