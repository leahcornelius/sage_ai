# §2 Prerequisites — Experiment 5 (run r2026061508531_230d)

Checked 2026-06-15T07:53Z at execution start. All green.

| Prereq | Result |
|---|---|
| Branch `experiment/5-autonomous-cleanfact` off `experiment/4-memory-substrate` | ✅ created (tree clean) |
| Qdrant dev `:6333` / bench `:6344` | ✅ up |
| Ollama `:11434` + models `qwen3:14b`, `nomic-embed-text` | ✅ up + pulled |
| `OPENAI_API_KEY` set (len 164) | ✅ |
| Upstream base-url override (`OPENAI_BASE_URL` / `SAGE_LLM_*_BASE_URL`) | none → default OpenAI |
| `claude` CLI present | ✅ (`claude -p` fallback viable) |
| `npm run test:contracts` | ✅ **30/30 pass** |
| Run dir + `adjudicator-state.json` startTimeIso (24h origin) | ✅ stamped 2026-06-15T07:53:10Z |
| **G4 answerer preflight** | ✅ `gpt-5.4-mini` → 200 (`gpt-5.4-mini-2026-03-17`); `gpt-4.1-mini` → 200 |

**Consequence:** G4 (LoCoMo) transfer check can run → **no forced in-sample-only caveat**. Proceed
to Phase 0.
