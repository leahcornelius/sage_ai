# Limitations and Known Issues

This document separates **confirmed behavior/constraints** from **code-level findings** that are likely defects or operational risks.

## Confirmed Feature-Level Limitations
1. Chat Completions API only (`/v1/chat/completions`).
2. Text-only message content support in V1 validation.
3. `n` is effectively limited to `1`.
4. Long-term memory is globally shared (not partitioned per tenant/user at HTTP layer).
5. HTTP layer is stateless; clients must resend relevant conversation history in `messages` each request.

## Operational Caveats
1. Memory extraction runs in background best-effort and does not affect immediate API success.
2. `web_search` can be enabled but still fail at runtime if API URL/key are missing.
3. MCP server support currently normalizes to HTTP transport only.

## Code-Level Findings (Documented, Not Fixed)

## Finding 1: Missing `AppError` import in tool loop overflow path
- **Location:** `src/services/chat-service.js` (`runToolLoop` throws `new AppError(...)`)
- **Current behavior:** `AppError` is referenced but not imported in this module.
- **Impact:** If tool rounds exceed `SAGE_TOOL_MAX_ROUNDS`, this branch can throw a `ReferenceError` instead of the intended structured `AppError`.
- **Trigger condition:** Assistant repeatedly returns tool calls and loop reaches max rounds.
- **Suggested fix direction:** Import `AppError` in `chat-service.js` from `src/errors/app-error.js` and keep the structured throw path.

## Finding 2: `streamRequested` logging can be unreliable at `onRequest`
- **Location:** `src/http/hooks/request-logging.js`
- **Current behavior:** Hook reads `request.body` inside `onRequest`.
- **Impact:** `request.body` may not be parsed at this stage, so `streamRequested` can be undefined even for streaming requests.
- **Trigger condition:** Any request where body parsing has not yet occurred at `onRequest` time.
- **Suggested fix direction:** Move stream flag extraction to a later hook stage (for example `preHandler`) or infer from validated payload in route-level logging.

## Finding 3: Prompt file includes visible mojibake artifacts
- **Location:** `system_prompt.yaml`
- **Current behavior:** Some characters appear as malformed encoding artifacts (for example in hyphenated words).
- **Impact:** Prompt readability and instruction fidelity can degrade, and phrasing passed upstream can differ from intended author text.
- **Trigger condition:** Always present when current prompt text is loaded.
- **Suggested fix direction:** Normalize file encoding to UTF-8 and clean affected text literals.

## Suggested TODO Backlog
1. Import and use `AppError` correctly in tool-round overflow branch.
2. Shift `streamRequested` logging signal to a parsed-body stage.
3. Clean and re-save `system_prompt.yaml` with consistent UTF-8 content.
4. Add explicit integration tests for:
   - max tool round overflow path
   - stream logging field reliability
   - prompt load text integrity checks

## Notes
These findings are derived from current source inspection and existing tests. They are documented here for transparency and prioritization, without changing runtime code in this documentation task.