# ChatGPT Adapter Handoff

Status: architecture approved, **identity selector contract stale**, implementation not started.

## 1. Base

- Base commit: `8d9c2b86d00f5827d2b925c2dbfe30f12dc0bd0d`
- E3 evidence was collected in the isolated worktree `D:\project\dual-ai-review-e2` with no source modifications.
- Milestone 7B lives separately in the main working tree (branch `phase2-milestone4b`, uncommitted changes). **This branch must not touch it.**

## 2. Current adapter state (at base)

- `src/sites/chatgptSite.ts` uses the shared `domUtil` helpers (`captureTurnBaseline`, `readNewAssistantText`, `resolveNewAssistantMessage`). Those helpers fall back from `data-message-id` to `data-testid`, then `id`, then the node's position (`index:`).
- Generation start is accepted when the stop button is visible or the assistant count goes up.
- Completion is based on the stop button disappearing plus 700 ms of stable text, with no tie to a specific message identity.
- `src/cli/index.ts` `assertFresh` rejects a tab if any assistant or user unit is mounted.

## 3. E3 proven facts

- In three sends (two in an existing long conversation, one as the first send in a fresh conversation), each new assistant message had a real ID that was not in the baseline and stayed the same for the whole generation.
- A fresh conversation changes route from `/` to `/c/<id>` on the first send, on the same Page target.
- A real fresh `/` page (reached through New Chat) had 4 user units and 4 assistant units mounted. **Mounted counts are not a valid freshness signal.**
- Network: streaming `POST` fetch (`text/event-stream`). There were 1 or 2 candidate requests per send, and every one ended with `net::ERR_ABORTED` about 318–350 ms after the last content growth. One request per send with a clean finish was **not** established.
- **The production adapter must not use network lifecycle.**

## 4. POST-E3 architecture decision (summary)

Gate: **APPROVED**, provided the real-browser tests pass before merge. The identity selector must be corrected first (see §5).

- **Identity:** ChatGPT-specific and based on message IDs.
  - The baseline is the set of mounted assistant IDs plus the pathname.
  - The candidate is a non-baseline ID that is also the last assistant unit in document order.
  - The first candidate is latched for the turn.
  - More than one new ID → `AmbiguousNewMessageError`. The latched ID being replaced by another new ID → `identity_changed`. The latched node missing for more than 5 s → `identity_lost`. A duplicate ID among mounted nodes → `identity_duplicate`.
  - Positional, `index:`, `data-testid` and `id` fallbacks are **forbidden** for ChatGPT.
- **Generation start:** a candidate has been latched; this is both necessary and sufficient. A visible stop button alone does not count, an increased count does not count, and SSE is not used. Default start timeout: 15 s.
- **Generation completion:** DOM only. All of the following must hold continuously for 1500 ms:
  1. The latched node is mounted, unique, and the last assistant unit.
  2. The stop button is not visible; if it reappears, the timer resets.
  3. The latched node's text is non-empty and unchanged.
  4. No other non-baseline ID exists.
  5. No error banner is visible; if one is, return `error_banner`.
  6. The route is consistent: a baseline on `/` must end on `/c/<id>`, and a baseline on `/c/<id>` must end on the same path.
- **Network:** the adapter attaches no listeners: no `page.on` or `context.on` for request, response or websocket events, no `route`, and no CDP. Diagnostics may include only the last 6 characters of the latched ID, text length, timings, stop-button visibility, the masked pathname and failure codes. Message text and full IDs or URLs are not allowed.
- **State:** latch state lives in a module-private `WeakMap` keyed by the baseline object. `TurnBaseline` in `siteTypes.ts` stays unchanged.
- **Freshness (`assertChatGPTFresh`):** route-based.
  - Fresh only when the host is allowed, the pathname is exactly `/`, and there is no query string.
  - Reject `/c/<id>`, `/g/<gizmo>`, `/g/<gizmo>/c/<id>`, `?temporary-chat=true`, any query string, unknown routes, and URLs that cannot be parsed.
  - Units mounted on `/` are ignored. They do not veto freshness and are absorbed into the baseline.
  - Claude freshness is unchanged.
- **Allowed files:**
  - `src/sites/chatgptSite.ts`
  - `src/sites/selectors/chatgptSelectors.ts`
  - new `src/sites/chatgptIdentity.ts`
  - `src/cli/index.ts`: only the import and the single ChatGPT `assertFresh` call in `browserSites()`
  - `tests/unit/chatgptAdapter.spec.ts`
  - new `tests/unit/chatgptIdentity.spec.ts`
- **Forbidden files:**
  - `src/browser/domUtil.ts`
  - `src/sites/siteTypes.ts`
  - the Claude site and selectors
  - `src/orchestration/**`, `src/conversation/**`, `src/main.ts`, `src/config/**`
  - all 7B files
  - `package.json` and the lockfile
- **Residual risk (accepted):** if the server truncates a response without showing an error banner, the adapter will accept it as complete.

## 5. Live selector validation — identity contract is STALE

| Selector | Live count |
|---|---|
| `[data-message-author-role="assistant"][data-message-id]` (selector in the architecture decision) | **0** |
| `[data-content-search-unit-key$=":assistant"]` (modern assistant unit) | **4** |

- The ID actually comes from the `data-chatgpt-selection-message-id` attribute.
- Corrected DOM path:

```
[data-content-search-unit-key$=":assistant"]
  [data-chatgpt-selection-message-id]
```

**The identity selector in §4 is stale and must be corrected before implementation.** The corrected contract has to define:

- The assistant unit is `[data-content-search-unit-key$=":assistant"]`. The "last assistant unit in document order" rule applies to these units.
- The ID is read from the `data-chatgpt-selection-message-id` descendant of that unit. A unit with zero descendants carrying the ID is ignored for identity. A unit whose descendants carry more than one distinct ID must fail closed.
- The existing `chatgptSelectors.assistantMessage` entries and the user selector `[data-message-author-role="user"]` were not validated against the live DOM. Treat them as unverified.
- The stop-button, send-button and error-banner selectors were also not live-validated in E3.

## 6. Frozen boundaries

- No changes to `src/orchestration/**`
- No Claim Ledger changes
- No Decision Engine changes
- No Human Gate changes
- No JEV authority changes
- No Claude adapter changes
- No Milestone 7B changes

## 7. Milestone 7B

- 7B exists separately in the main working tree and **must not be touched by this branch**.
- 7B development can continue independently. 7B acceptance is blocked until this adapter fix is merged and validated in a real browser.
- When 7B rebases, its preflight `assertFresh` call for ChatGPT must switch to `assertChatGPTFresh`. That change belongs to 7B, not to this branch.

## 8. Testing constraints

- Unit tests can run in Claude Cloud.
- **Real-browser tests need the local Chrome DevTools endpoint `127.0.0.1:9222` and cannot run in Claude Cloud. They must be run locally.** Required local runs:
  - **R1:** existing long conversation (≥20 turns).
  - **R2:** New Chat with stale units mounted on `/`, then two turns.
  - **R3:** cold-loaded `/`.
  - **R4:** freshness rejections.
  - **R5:** long response with pauses, run 3 times, with no early completion.
  - **R6:** scroll during generation to trigger virtualization; the result must be either correct text or `identity_lost`.
  - **R7:** record whether a new user-message ID appears before the assistant message (diagnostic only).
- Any wrong-text result or early completion blocks the merge.

## 9. Claude adapter backlog (not in scope)

Separate risk: the Claude path still relies on `domUtil` index and `data-testid` fallbacks, count-based start detection, and count-based `assertFresh`. All of these are exposed to virtualization. This needs its own evidence phase.
