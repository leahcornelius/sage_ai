# Limitations and Known Issues

This document separates **confirmed behavior/constraints** from **code-level findings** that are likely defects or operational risks.

## Confirmed Feature-Level Limitations
1. Chat Completions API only (`/v1/chat/completions`).
2. Text-only message content support in V1 validation.
3. `n` is effectively limited to `1`.
4. Long-term memory is globally shared (not partitioned per tenant/user at HTTP layer).
5. Clients must still resend relevant conversation history in `messages` each request for upstream completion context; server-side conversation persistence is used for memory workflows only.

## Operational Caveats
1. Memory extraction runs in background best-effort and does not affect immediate API success.
2. Brave web tools can be enabled but still fail at runtime if Brave API key is missing/invalid, or remote retrieval fails and direct URL fallback is blocked by target site/network.
3. MCP server support is transport-dependent; startup behavior for each server is controlled by its `required` flag.
4. Document cache is process-local in-memory state only; `document_id` and `result_id` handles are not shared across Sage instances and are lost on restart.
5. Direct URL fallback currently allows public/private host targets over `http/https`; production deployments should place network egress controls around Sage.

## Code-Level Findings (Documented, Not Fixed)

## Finding 1: `streamRequested` logging can be unreliable at `onRequest`
- **Location:** `src/http/hooks/request-logging.js`
- **Current behavior:** Hook reads `request.body` inside `onRequest`.
- **Impact:** `request.body` may not be parsed at this stage, so `streamRequested` can be undefined even for streaming requests.
- **Trigger condition:** Any request where body parsing has not yet occurred at `onRequest` time.
- **Suggested fix direction:** Move stream flag extraction to a later hook stage (for example `preHandler`) or infer from validated payload in route-level logging.

## Finding 2: Prompt file includes visible mojibake artifacts
- **Location:** `system_prompt.yaml`
- **Current behavior:** Some characters appear as malformed encoding artifacts (for example in hyphenated words).
- **Impact:** Prompt readability and instruction fidelity can degrade, and phrasing passed upstream can differ from intended author text.
- **Trigger condition:** Always present when current prompt text is loaded.
- **Suggested fix direction:** Normalize file encoding to UTF-8 and clean affected text literals.

## Suggested TODO Backlog
1. Shift `streamRequested` logging signal to a parsed-body stage.
2. Clean and re-save `system_prompt.yaml` with consistent UTF-8 content.
3. Add explicit integration tests for:
   - max tool round overflow path
   - stream logging field reliability
   - prompt load text integrity checks

## Notes
These findings are derived from current source inspection and existing tests. They are documented here for transparency and prioritization, without changing runtime code in this documentation task.
