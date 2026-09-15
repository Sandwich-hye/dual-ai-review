# PHASE2_DESIGN.md 鈥?dual-ai-review

Design document for Phase 2A (fully automatic ChatGPT 鈫?Claude review loop). This is a
design only 鈥?no implementation code is included. It builds directly on the accepted,
frozen Phase 1 foundation (see `REVIEW.md`) and follows the extension points already
reserved for it in `SPEC.md` 搂15 and `DECISIONS.md` 搂6.

**Constraints carried over from the user's Phase 2 brief (binding on every section below):**
- Web UI automation only 鈥?no Codex CLI, no Claude Code CLI, no OpenAI/Anthropic API, at
  runtime.
- No manual copy/paste between ChatGPT and Claude 鈥?the program does the handoff.
- User manually launches the dedicated Chrome (`scripts/start-browser.ps1`) and logs in;
  Playwright attaches via CDP exactly as Phase 1 does (`chromium.connectOverCDP`, no
  navigation of existing tabs, never closes the attached browser).
- No Cloudflare bypass, no stealth plugins, no fingerprint spoofing 鈥?ever.
- If login/security verification is required mid-run, automation pauses and waits for a
  human; it never attempts to solve or click through it.
- No user confirmation required between rounds in the normal path.
- `maxRounds` default `12`.

---

## 0. Architecture at a glance

```
reviewMain.ts (new composition root)
  鈹溾攢 loadConfig()                     [extended]
  鈹溾攢 launchBrowser()                  [unchanged]
  鈹溾攢 discoverSitePages()              [unchanged]
  鈹溾攢 chatgptSite.ts / claudeSite.ts   [extended: + sendPrompt/wait*/getLatest*]
  鈹溾攢 orchestrator/reviewOrchestrator.ts  [new] 鈥?depends only on the adapter interface
  鈹溾攢 orchestrator/convergence.ts         [new] 鈥?pure text 鈫?{status, summary, issues}
  鈹溾攢 orchestrator/prompts.ts             [new] 鈥?pure template functions
  鈹斺攢 orchestrator/runStore.ts            [new] 鈥?runs/<id>/ persistence + resume
```

`ReviewOrchestrator` never imports `chatgptSite.ts`/`claudeSite.ts` directly 鈥?it is
constructed with two objects satisfying a shared adapter interface, exactly as
`DECISIONS.md` 搂6 requires. This is what makes it unit-testable with fake, in-memory
adapters and zero browser dependency (see 搂11).

---

## 1. ChatGPTWebAdapter

Implemented by extending `src/sites/chatgptSite.ts` in place (its existing
`createChatGPTSite`/`checkChatGPTReady` stay untouched; new functions are added
alongside them, per `SPEC.md` 搂15's designated extension point).

```
sendPrompt(page, text): Promise<void>
waitForGenerationStart(page, baseline): Promise<"started" | "not_observed">
waitForGenerationComplete(page, baseline, timeoutMs): Promise<GenerationOutcome>
getLatestAssistantResponse(page, baseline): Promise<string>
```

Where `baseline` is a `TurnBaseline` captured immediately **before** `sendPrompt` (see 搂10)
鈥?every method after `sendPrompt` is parameterized by it, so "new" is always defined
relative to a concrete snapshot, never "whatever looks newest right now."

### `sendPrompt(page, text)`
1. Locate the composer via the ChatGPT selector fallback group (搂9). Fail (throw a typed
   `ComposerNotFoundError`) if none match 鈥?this is a distinct, orchestrator-visible error,
   not a silent no-op.
2. `locator.click()` to focus, then `locator.fill(text)`. ChatGPT's composer is a
   contenteditable (ProseMirror-style) editor; if `.fill()` does not result in the expected
   text content (verified by reading it back via `innerText`/`textContent` immediately
   after), fall back to `locator.pressSequentially(text, { delay: 0 })`, which dispatches
   real keyboard events and is more compatible with React-controlled contenteditable
   inputs that ignore programmatic value assignment.
3. Submit via the send-button selector fallback group (搂9), not the Enter key by default 鈥?   a dedicated button click is unambiguous regardless of the composer's Enter-vs-Shift+Enter
   convention and avoids accidentally submitting mid-multi-line text. If no send button
   candidate is found/enabled, fall back to pressing `Enter` on the composer.
4. Do not wait for anything here 鈥?waiting is the caller's job via the next two methods,
   kept separate so tests can assert on each phase independently.

### `waitForGenerationStart(page, baseline)`
Best-effort, short-timeout (default 5s) signal that the send was accepted and a
generation actually began, used only to avoid the caller racing straight into
`waitForGenerationComplete` and reading pre-send state as "already done." Considered
"started" on the **first** of:
- the stop/streaming-cancel button (selector fallback group, 搂9) becomes visible, or
- the assistant-message count (re-queried) exceeds `baseline.count`.

If neither happens within the timeout, return `"not_observed"` rather than throwing 鈥?some responses are fast enough that generation completes before this check would ever
catch the transient "started" state, and `waitForGenerationComplete` handles that case on
its own.

### `waitForGenerationComplete(page, baseline, timeoutMs)`
Two-signal design 鈥?never a fixed sleep:
1. **Primary (state) signal:** poll (e.g. every 300ms) until the stop/streaming-cancel
   button is gone **and** the send button is re-enabled/visible again. This is the
   authoritative "the UI thinks it's done" signal.
2. **Confirmation (stability) signal:** once (1) is true, read the candidate new message's
   text, wait one debounce interval (default 700ms), read it again. If unchanged, treat as
   stable and return. If changed (covers UIs that briefly flicker the stop button before a
   final formatting/citation pass finishes rendering), keep polling signal (1) again from
   scratch. This combination 鈥?UI state first, text stability as confirmation 鈥?avoids both
   "declared done while still streaming" and "waiting forever on a UI that never clears its
   own busy indicator."
3. Bounded by `timeoutMs` (config: `generationTimeoutMs.chatgpt`, default `180000`). On
   timeout, return `{ outcome: "timeout", partialText }` rather than throwing 鈥?the caller
   (orchestrator) decides what "timeout" means for the run (搂8), and the partial text is
   preserved for diagnosis (saved alongside a screenshot, reusing `openSite.ts`'s
   `saveScreenshot` helper).
4. Also watches for an explicit error/regenerate banner (selector fallback group, 搂9,
   e.g. "something went wrong" / rate-limit banner). If seen, return
   `{ outcome: "error_banner", detail }` immediately rather than waiting out the full
   timeout 鈥?this is a faster, more specific failure than a generic timeout.

Return type:
```
type GenerationOutcome =
  | { outcome: "complete" }
  | { outcome: "timeout"; partialText: string }
  | { outcome: "error_banner"; detail: string }
```

### `getLatestAssistantResponse(page, baseline)`
Resolves and returns the text of the **single** new assistant message produced since
`baseline`, using the id-diff strategy in 搂10. Throws a typed
`AmbiguousNewMessageError` if zero or more-than-one new message is found 鈥?the
orchestrator treats this the same as a malformed/empty response (搂8), pausing for manual
inspection rather than guessing which text to forward to Claude.

---

## 2. ClaudeWebAdapter

Same four-method shape, same `TurnBaseline` contract, implemented by extending
`src/sites/claudeSite.ts` in place. Only the selector fallback groups and the
stop/streaming-indicator details differ (搂9) 鈥?the send/wait/extract *logic* described
above is identical in shape, so both adapters share the generic polling/debounce helpers
from a new `src/browser/domUtil.ts` (composer fill-with-fallback, button-click-with-fallback,
poll-until-stable) rather than duplicating that logic per site. Only DOM knowledge
(selectors, what "streaming" looks like) stays site-specific, per `DECISIONS.md` 搂6.

Claude-specific notes:
- Claude's composer and message list use different attributes than ChatGPT's; the fallback
  groups in 搂9 encode this, nothing else differs architecturally.
- Claude's equivalent of ChatGPT's "regenerate/error banner" (e.g. a Cloudflare
  re-challenge or an in-app error toast) is treated identically: detected via a selector
  fallback group, returned as `error_banner`, never auto-dismissed or clicked through 鈥?if
  what's actually on screen is a Cloudflare challenge rather than an app-level error, the
  generic `unknown_state` / `login_required` classification from `checkClaudeReady`
  (already reused as a pre-flight guard, see 搂8) is what ultimately catches it, since a
  challenge page won't contain Claude's normal composer/message DOM at all.

---

## 3. ReviewOrchestrator

New module: `src/orchestrator/reviewOrchestrator.ts`. Constructed with:
```
{
  task: string,
  maxRounds: number,                       // default 12
  chatgpt: { page: Page, adapter: ConversationalSiteAdapter },
  claude:  { page: Page, adapter: ConversationalSiteAdapter },
  runStore: RunStore,                       // 搂7
  logger: Logger,                           // reused from Phase 1
}
```
It depends only on `ConversationalSiteAdapter` (搂13) 鈥?never on `chatgptSite.ts`/
`claudeSite.ts` concretely 鈥?so `tests/unit/orchestrator.spec.ts` can drive it with two
fake, in-memory adapters and assert its full state machine with no browser at all (搂11).

Responsibilities:
- Owns **round number** and **run status** (`running | converged | max_rounds_reached |
  paused_login_required | paused_unknown_state | paused_browser_disconnected |
  error_empty_response | error_malformed_convergence | error_ambiguous_response |
  error_tab_missing`).
- Before every send (ChatGPT or Claude), re-runs that site's existing `checkReady(page)`
  as a pre-flight guard (reusing Phase 1's `SiteLoadStatus` classification verbatim) 鈥?if
  not `"ready"`, the run pauses per 搂8 instead of sending into a login/challenge/unknown
  page.
- Drives the ChatGPT 鈫?Claude 鈫?(loop) handoff described in 搂4.
- Calls `runStore` after every completed turn and every status change (搂7) 鈥?persistence
  is not a bolt-on at the end, it is how the orchestrator survives a crash mid-run.
- Owns the single retry-on-malformed-convergence attempt (搂5) 鈥?no other retries exist
  anywhere in the loop; every other failure pauses rather than retries, per the user's
  "pause safely, don't self-heal" requirement.
- Exposes `run(): Promise<RunResult>` for a fresh run and `resume(runId): Promise<RunResult>`
  for continuing a persisted one (搂7).
- Extension point for Phase 2B (搂12): accepts an optional
  `shouldPauseBeforeNextRound?: () => Promise<boolean>` hook, checked once at the top of
  each round's loop iteration; unused (always effectively `false`) in Phase 2A.

---

## 4. Round lifecycle

**Round 1**
1. Build the initial ChatGPT prompt from `task` (template in 搂6).
2. `chatgpt.sendPrompt` 鈫?`waitForGenerationStart` 鈫?`waitForGenerationComplete` 鈫?   `getLatestAssistantResponse` 鈫?this is `round-01-chatgpt`.
3. Build the Claude reviewer prompt from `task` + `round-01-chatgpt` text (template in 搂6).
4. `claude.sendPrompt` 鈫?wait 鈫?`getLatestAssistantResponse` 鈫?this is `round-01-claude`.
5. Parse `round-01-claude` with `convergence.ts` (搂5).
6. If `CONVERGED` 鈫?run status `converged`, write `final.md`, stop.
7. If `CONTINUE` 鈫?proceed to Round 2.

**Round N (N 鈮?2)**
1. Build the ChatGPT revision prompt from the **issues list** parsed out of the previous
   round's Claude review (not the full review text, and not the original task restated in
   full 鈥?see 搂6 on why). Both ChatGPT's and Claude's tabs already hold the full
   conversation natively (Phase 2 never opens a new chat or navigates away), so each
   round's prompt is a short delta, not a replay of history.
2. `chatgpt.sendPrompt` (same tab/conversation) 鈫?wait 鈫?`getLatestAssistantResponse` 鈫?   `round-0N-chatgpt`.
3. Build the subsequent Claude review prompt referencing "the revised answer" (搂6).
4. `claude.sendPrompt` (same tab/conversation) 鈫?wait 鈫?`getLatestAssistantResponse` 鈫?   `round-0N-claude`.
5. Parse; `CONVERGED` 鈫?stop. `CONTINUE` 鈫?increment round, repeat.
6. If `N == maxRounds` after step 5 and status is still `CONTINUE` 鈫?run status
   `max_rounds_reached`, write `final.md` from the last ChatGPT response, stop.

**Stalled-loop guard (cheap, non-ML, in scope for 2A):** if a round's parsed `ISSUES` list
is **byte-identical** to the immediately preceding round's `ISSUES` list, treat this as a
`stalled_no_progress` pause instead of burning the remaining rounds 鈥?this is a literal
string-equality check, not natural-language similarity, so it doesn't conflict with "do not
depend only on NL similarity" (搂5); it only catches the degenerate case of Claude repeating
verbatim the same list.

---

## 5. Convergence protocol

New pure module `src/orchestrator/convergence.ts`:
```
parseConvergence(rawText: string): ConvergenceResult

type ConvergenceResult =
  | { status: "CONVERGED"; summary: string }
  | { status: "CONTINUE"; summary: string; issues: string[] }
  | { status: "MALFORMED"; raw: string }
```

Parsing rules (deterministic, tested against many fixtures 鈥?搂11):
1. Find every line matching `/^\s*STATUS:\s*(CONTINUE|CONVERGED)\s*$/i`. If none, 鈫?   `MALFORMED`.
2. If more than one match, take the **last** one 鈥?models sometimes echo the instruction
   format before their actual answer; the last occurrence is the one most likely to be the
   real answer. This rule is fixed and documented so it's testable, not a heuristic guess
   at runtime.
3. `SUMMARY:` section = text between the chosen `STATUS:` line and the next `ISSUES:`
   line (or end of text if `CONVERGED`/no `ISSUES:` section), trimmed.
4. `ISSUES:` section (only relevant when `CONTINUE`) = lines starting with `-` or `*`
   following an `ISSUES:` line, trimmed of the bullet marker. A `CONTINUE` with zero parsed
   issue lines is still valid (empty array) 鈥?it is not itself malformed, though the
   orchestrator logs a warning since it's an unusual shape.
5. `CONVERGED` with a stray `ISSUES:` section present 鈫?still `CONVERGED`; the issues are
   logged into the transcript as trailing notes but do not affect stopping.

**Orchestrator handling of `MALFORMED`:** one automatic recovery attempt 鈥?send a short,
fixed reformat-request prompt to Claude ("Your previous reply didn't use the required
format. Reply again using exactly: STATUS: CONTINUE or CONVERGED, then SUMMARY:, then
ISSUES: if CONTINUE.") in the same tab, wait, re-parse. If still `MALFORMED`, run status
becomes `error_malformed_convergence`, the raw text is saved, and the run pauses for a
human to read the transcript 鈥?no further automatic retries.

The orchestrator's stop conditions are exactly two, both explicit and machine-checked:
`CONVERGED` (from `convergence.ts`) and `MAX_ROUNDS_REACHED` (round counter hitting
`maxRounds`). No natural-language similarity/diffing is used for stopping.

---

## 6. Prompt templates

New pure module `src/orchestrator/prompts.ts` 鈥?plain functions, no side effects, each
independently snapshot-testable.

**Initial ChatGPT prompt** (`buildInitialChatGptPrompt(task)`):
```
You are working on a task. Another AI will review your answer afterward and you may be
asked to revise it, so aim for a complete, well-reasoned first attempt rather than a
placeholder.

TASK:
<task>
```

**Claude reviewer prompt 鈥?round 1** (`buildInitialClaudeReviewPrompt(task, chatgptResponse)`):
```
You are reviewing another AI's answer to the task below. Review it critically but fairly.
Only raise issues that materially affect correctness, completeness, or quality relative to
the task 鈥?do not invent minor or speculative objections merely to keep the review going.
If the answer already adequately satisfies the task, say so and converge.

TASK:
<task>

CANDIDATE ANSWER:
<chatgptResponse>

Respond in EXACTLY this format and nothing outside it:

STATUS: CONTINUE or CONVERGED
SUMMARY:
<one short paragraph>
ISSUES:
- <only if STATUS is CONTINUE; omit this section entirely if CONVERGED>
```

**ChatGPT revision prompt 鈥?round N鈮?** (`buildRevisionPrompt(issues)`):
```
A reviewer evaluated your previous answer and found these issues. Revise your previous
answer to address them directly. Keep everything from your previous answer that was not
criticized 鈥?do not restart from scratch.

ISSUES TO ADDRESS:
- <issue 1>
- <issue 2>

Provide your complete revised answer.
```

**Claude subsequent review prompt 鈥?round N鈮?**
(`buildFollowUpClaudeReviewPrompt()`):
```
Here is the revised answer, addressing your previous feedback. Review it again with the
same criteria as before. Only raise issues that are new or still genuinely unresolved 鈥?do
not re-raise anything that has clearly been fixed, and do not invent new objections just to
continue the review. If it is now adequate, converge.

Respond again in EXACTLY the same STATUS/SUMMARY/ISSUES format as before.
```
(No task/response text is re-pasted here 鈥?both models already have the full
conversation in-tab; Claude's revised-answer text is already the message immediately
above this prompt in its own conversation. Re-pasting it would be redundant and would
invite the model to review a stale pasted copy instead of what's actually in front of it.)

---

## 7. Persistence

New module `src/orchestrator/runStore.ts`.

```
runs/<run-id>/
  task.md
  state.json
  transcript.md
  final.md
  rounds/
    round-01-chatgpt.md
    round-01-claude.md
    round-02-chatgpt.md
    round-02-claude.md
    ...
```

- `<run-id>`: `<ISO-timestamp>-<short-random-suffix>`, filesystem-safe (colons replaced,
  matching `logger.ts`'s existing `stampForFilename` convention).
- `task.md`: the raw user task, written once at run creation.
- `rounds/round-NN-{chatgpt,claude}.md`: raw response text for that turn plus a small
  metadata comment header (timestamp, character count).
- `transcript.md`: human-readable, append-only 鈥?one section per completed turn, rebuilt
  (not hand-diffed) from `rounds/*.md` each time a turn completes, so it's always
  consistent with the source-of-truth round files.
- `final.md`: written once, at stop time 鈥?the last ChatGPT answer plus the final
  convergence summary and stop reason (`CONVERGED` / `MAX_ROUNDS_REACHED` / a paused/error
  reason if the run didn't reach a clean stop).
- `state.json`: the resumable machine state 鈥?  ```
  {
    "runId": "...",
    "task": "...",
    "maxRounds": 12,
    "currentRound": 2,
    "phase": "chatgpt_pending" | "chatgpt_done" | "claude_pending" | "claude_done"
             | "converged" | "max_rounds_reached" | "paused_login_required"
             | "paused_unknown_state" | "paused_browser_disconnected"
             | "error_empty_response" | "error_malformed_convergence"
             | "error_ambiguous_response" | "error_tab_missing"
             | "stalled_no_progress",
    "lastIssues": ["...", "..."],
    "updatedAt": "..."
  }
  ```
- **Atomic writes:** every `state.json` update is written to `state.json.tmp` then
  `fs.renameSync`'d over `state.json` 鈥?never a partial/corrupt state file if the process
  dies mid-write.
- **Resume (`resume(runId)`):** load `state.json`, then before trusting `phase`,
  reconcile it against what's actually on disk in `rounds/` for `currentRound` (e.g. if
  `phase` says `"chatgpt_pending"` but `round-0N-chatgpt.md` already exists, the previous
  process died after the ChatGPT turn completed but before persisting 鈥?resume treats the
  turn as done and proceeds to the Claude turn instead of re-sending to ChatGPT). This
  reconciliation is what makes resume idempotent and safe against double-submission, not
  the `state.json` phase field alone.
- `runs/` is added to `.gitignore` (it holds real task/response content, same rationale as
  `logs/` and `.browser-profile/`).

---

## 8. Safety / recovery states

| Condition | Detection | Orchestrator action |
|---|---|---|
| ChatGPT tab missing | `discoverSitePages` (unchanged, Phase 1) returns no `chatgpt` page at startup | Do not start a run; log and exit non-zero 鈥?same as Phase 1's `navigation_failed`-on-missing-tab behavior, reused as-is. |
| Claude tab missing | same, for `claude` | same |
| `login_required` (pre-flight or mid-run) | `checkReady(page)` re-run before every send (搂3) | Persist `state.json` with `phase: "paused_login_required"`, print instructions to log in manually in the already-open Chrome window and re-run with `--resume <run-id>`, exit non-zero. **Never** attempts to fill/click a login form. |
| `unknown_state` | same `checkReady` guard | Save a screenshot (reusing `openSite.ts`'s `saveScreenshot`), persist `phase: "paused_unknown_state"`, exit non-zero, same resume instructions. |
| Generation timeout | `waitForGenerationComplete` returns `{outcome:"timeout"}` | Save partial text + screenshot for diagnosis; persist `phase` reflecting the paused turn; exit non-zero. Never guesses with partial text. |
| Browser disconnected | `browser.on("disconnected")` listener registered once in `reviewMain.ts` | Persist current state immediately, log, exit non-zero. No auto-reconnect. |
| Model "refuses" | No reliable DOM signal exists for this; treated via the same threshold as empty response below (a very short response, e.g. under a fixed `minResponseChars` constant, is suspicious) | If under threshold: treated as `error_empty_response` (see below) rather than silently forwarded. If over threshold, forwarded normally 鈥?Claude's own reviewer prompt is instructed to flag an inadequate/refusal-shaped answer as a `CONTINUE` issue, which is the ordinary review path handling it. |
| Empty response | `getLatestAssistantResponse` returns empty/whitespace-only text after stabilization | Do not forward it. Persist `phase: "error_empty_response"`, exit non-zero, raw (empty) turn file kept for inspection. |
| Malformed convergence status | `convergence.ts` returns `MALFORMED` | One automatic reformat-retry (搂5); if still malformed, `phase: "error_malformed_convergence"`, exit non-zero. |
| Ambiguous new-message count | `getLatestAssistantResponse` / `resolveNewAssistantMessage` (搂10) finds 0 or >1 new message ids | `phase: "error_ambiguous_response"`, exit non-zero 鈥?never guesses which message is "the" new one. |

Every paused/error state is designed to be resumable once the human has fixed the
underlying condition (log back in, dismiss a challenge, notice a UI change): re-running
with `--resume <run-id>` re-validates readiness and either proceeds or reports the same
pause again.

---

## 9. Selector strategy

Two new, purely-data modules: `src/sites/selectors/chatgptSelectors.ts` and
`claudeSelectors.ts` 鈥?each exports **ordered arrays** of selector strings per role, tried
in order by a shared helper (`firstVisible(page, selectors[])` in the new
`src/browser/domUtil.ts`) so a UI change only requires editing/reordering an array, never
touching adapter logic. All selectors favor accessible roles/labels/testids over brittle
generated class names, per `SPEC.md` 搂16's stated mitigation for UI churn.

```
// chatgptSelectors.ts (illustrative 鈥?verified/updated at implementation time)
composer: [
  '[data-testid="prompt-textarea"]',
  '#prompt-textarea',
  'div[contenteditable="true"][role="textbox"]',
]
sendButton: [
  '[data-testid="send-button"]',
  'button[aria-label*="Send" i]',
]
stopGenerating: [
  '[data-testid="stop-button"]',
  'button[aria-label*="Stop" i]',
]
assistantMessage: [
  '[data-message-author-role="assistant"]',
]
errorBanner: [
  'text=/something went wrong/i',
  'text=/rate limit/i',
]
```
```
// claudeSelectors.ts (illustrative 鈥?verified/updated at implementation time)
composer: [
  'div[contenteditable="true"].ProseMirror',
  'div[contenteditable="true"][role="textbox"]',
]
sendButton: [
  'button[aria-label*="Send" i]',
]
stopGenerating: [
  'button[aria-label*="Stop" i]',
  '[data-is-streaming="true"]',
]
assistantMessage: [
  '[data-testid="assistant-message"]',
  '.font-claude-message',
]
errorBanner: [
  'text=/something went wrong/i',
]
```
These specific strings are a starting point to be confirmed/corrected against the live
DOM during Milestone 1/2 implementation (搂14) 鈥?the point of the design is the **fallback
array + shared resolver** pattern, not that these exact strings are final. This is called
out explicitly so whoever implements Phase 2 does not treat the illustrative selectors as
already-verified.

`generation-active` state is derived, not a selector of its own: "active" = stop-button
selector group currently visible; "idle" = it is not. No separate signal is needed.

---

## 10. Avoiding accidental response confusion

New shared type + helpers (in `domUtil.ts`, used identically by both adapters):

```
interface TurnBaseline { count: number; ids: ReadonlySet<string> }

captureTurnBaseline(page, assistantMessageSelectorGroup): Promise<TurnBaseline>
resolveNewAssistantMessage(page, assistantMessageSelectorGroup, baseline): Promise<string>
```

- `captureTurnBaseline` is called **before** `sendPrompt`, not after 鈥?this is the anchor
  everything else is relative to.
- Each assistant message node's identity is taken from a stable DOM attribute where the
  site provides one (e.g. a `data-message-id`/`data-testid`-scoped id, or, failing that, a
  synthesized id from `(index, elementHandle)` pairing via Playwright's element handles,
  which remain stable across polls within the same page lifetime even without a DOM
  attribute).
- `resolveNewAssistantMessage` re-queries the assistant message nodes after generation
  completes, computes `newIds = currentIds - baseline.ids`. Exactly one new id is the
  success path 鈥?anything else (`0` = nothing appended yet/extraction ran too early, `>1` =
  more than one message appended, e.g. a regenerate produced a duplicate) is surfaced as
  `AmbiguousNewMessageError`, handled per 搂8's table 鈥?**never** silently falls back to
  "just take the last message on the page," which is exactly the bug this guards against.
- Because the baseline is captured fresh at the top of every round (not reused across
  rounds), a stale baseline from round N can never be mistaken for round N+1's state.

---

## 11. Tests

All automated tests stay local/offline, extending Phase 1's pattern (`SPEC.md` 搂14A) 鈥?real ChatGPT/Claude interaction remains a manual checklist
(`tests/manual/phase2.real-sites.md`, new, mirroring `tests/manual/phase1.real-sites.md`).

**New fixture harness:** `tests/fixtures/fakeChat.html` (parameterized via query string or
a small inline script for ChatGPT-flavored vs Claude-flavored attribute names) 鈥?a tiny
static page with a contenteditable composer, a send button, a toggleable
stop/streaming-button, and a growing list of assistant-message nodes with unique ids. On
"send," a short `setTimeout` simulates generation: shows the stop button, then after a
delay hides it and appends a new assistant message node with a fresh id. This one fixture
backs the send/wait/extract tests for both adapters and the turn-baseline tests, so
selector *logic* is tested against real DOM interaction (via `page.setContent`/
`page.goto('file://...')`) without depending on live ChatGPT/Claude markup.

| Test file | Covers |
|---|---|
| `tests/unit/chatgptAdapter.spec.ts` | `sendPrompt` fills+submits against the fixture; `waitForGenerationStart`/`Complete` correctly track the fixture's stop-button toggle + text-stability debounce; timeout path when the fixture is made to never finish. |
| `tests/unit/claudeAdapter.spec.ts` | Same, against the Claude-flavored fixture variant. |
| `tests/unit/turnBaseline.spec.ts` | New-response identification: baseline captured with N pre-existing messages, exactly the new one is returned; a rigged 0-new and a rigged 2-new case both throw `AmbiguousNewMessageError`. |
| `tests/unit/convergenceParser.spec.ts` | `CONVERGED`/`CONTINUE` happy paths, case-insensitivity/whitespace variance, multiple `STATUS:` lines (last wins), stray `ISSUES:` under `CONVERGED`, no `STATUS:` line at all 鈫?`MALFORMED`. |
| `tests/unit/promptTemplates.spec.ts` | Each template function's output against fixed inputs (snapshot-style) 鈥?mainly guards against accidental prompt-format drift. |
| `tests/unit/orchestrator.spec.ts` | Full round loop against two **fake, in-memory adapters** (no Playwright): converges at round K; runs all the way to `MAX_ROUNDS_REACHED` at 12; malformed-status retry-then-stop; `error_empty_response`; generation-timeout pause; `stalled_no_progress` on repeated identical issues; pre-flight `checkReady` guard triggering `paused_login_required`/`paused_unknown_state`. |
| `tests/unit/runStore.spec.ts` | Run directory layout created correctly; `state.json` written atomically (verified by killing the write mid-way in a controlled way / asserting no partial file is ever visible to a reader); `transcript.md`/`final.md` correctly assembled from round files. |
| `tests/unit/resume.spec.ts` | Given a hand-crafted `runs/<id>/` fixture (state.json + partial rounds/), `resume()` reconciles phase-vs-disk correctly and continues from the right step without re-sending an already-completed turn (idempotency). |
| `tests/unit/toolIsolation.spec.ts` (extends Phase 1's `openSite.spec.ts` pattern) | One site's adapter throwing/timing out does not corrupt the other site's turn or crash the orchestrator 鈥?reuses Phase 1's existing failure-isolation proof, extended to the conversational path. |

`package.json`'s `test` script and `playwright.config.ts`'s `testDir: "./tests/unit"`
need no changes 鈥?new spec files are picked up automatically.

---

## 12. Phase boundaries

**Phase 2A (this design, to be implemented now):** fully automatic round loop, no user
interaction required between rounds, stopping only on `CONVERGED` or
`MAX_ROUNDS_REACHED` (or a safety pause per 搂8).

**Phase 2B (later, not implemented now):** user pause/interrupt/inject-guidance while a
run is active. The only thing Phase 2A commits to for this is the
`shouldPauseBeforeNextRound?()` hook on `ReviewOrchestrator` (搂3) 鈥?a single, optional,
already-defined extension point checked once per round boundary. No pause UI, no
mid-generation interrupt, no guidance-injection prompt template is designed or built now;
Phase 2B designs those when it starts, against a working, frozen Phase 2A.

---

## 13. Existing Phase 1 files

**Untouched:**
- `src/browser/launchBrowser.ts`
- `src/browser/discoverSitePages.ts`
- `src/browser/shutdown.ts`
- `src/logging/logger.ts`
- `src/sites/openSite.ts` (still used as-is for the original Phase 1 readiness-only path;
  `main.ts` keeps working exactly as reviewed/frozen)
- `src/main.ts` (Phase 1's entry point stays the Phase 1 smoke-check entry point 鈥?  untouched, not repurposed)
- `tests/unit/config.spec.ts`, `logging.spec.ts`, `openSite.spec.ts`, `shutdown.spec.ts`,
  `siteLoadResult.spec.ts`, `browserDiscovery.spec.ts` (all keep passing unmodified)

**Minimally extended (additive only 鈥?no existing exported signature changes):**
- `src/config/loadConfig.ts` 鈥?add `maxRounds` (default `12`), `generationTimeoutMs`
  (per-site, e.g. `{ chatgpt: 180000, claude: 180000 }`), `runsDir` (default `"runs"`).
  Existing fields/validation untouched; new fields validated with the same fail-fast style.
- `src/sites/siteTypes.ts` 鈥?add a new `ConversationalSiteAdapter extends SiteAdapter`
  interface (the four new methods from 搂1/搂2) in the same file, rather than modifying
  `SiteAdapter` itself 鈥?Phase 1's `SiteAdapter`/`checkReady`-only usage in `main.ts`/
  `openSite.ts` stays valid and untouched.
- `src/sites/chatgptSite.ts` / `src/sites/claudeSite.ts` 鈥?extended in place with the new
  methods; `checkChatGPTReady`/`checkClaudeReady`/`createChatGPTSite`/`createClaudeSite`
  keep their exact current behavior and signatures.
- `.gitignore` 鈥?add `runs/` (and, independent cleanup noted in `REVIEW.md`,
  `.test-browser-profile/`/`.test-logs/`).

**New files/modules:**
- `src/browser/domUtil.ts`
- `src/sites/selectors/chatgptSelectors.ts`, `src/sites/selectors/claudeSelectors.ts`
- `src/orchestrator/types.ts`
- `src/orchestrator/convergence.ts`
- `src/orchestrator/prompts.ts`
- `src/orchestrator/reviewOrchestrator.ts`
- `src/orchestrator/runStore.ts`
- `src/reviewMain.ts` (new composition root; new `npm run review -- "<task text>"` /
  `--resume <run-id>` script in `package.json`)
- `tests/fixtures/fakeChat.html`
- `tests/unit/chatgptAdapter.spec.ts`, `claudeAdapter.spec.ts`, `turnBaseline.spec.ts`,
  `convergenceParser.spec.ts`, `promptTemplates.spec.ts`, `orchestrator.spec.ts`,
  `runStore.spec.ts`, `resume.spec.ts`, `toolIsolation.spec.ts`
- `tests/manual/phase2.real-sites.md`
- `runs/` (gitignored output directory, created at first run)

---

## 14. Implementation sequence

Each milestone is independently testable and independently mergeable; later milestones
depend only on earlier ones being done, never on Phase 2B.

**Milestone 1 鈥?ChatGPT send + wait + latest-response detection**
Files: `domUtil.ts`, `chatgptSelectors.ts`, `chatgptSite.ts` (extended),
`tests/fixtures/fakeChat.html`, `tests/unit/chatgptAdapter.spec.ts`,
`tests/unit/turnBaseline.spec.ts`.
Done when: fixture-based tests pass locally with no live network, plus one manual
real-site smoke check (send one prompt to real ChatGPT via the attached tab, confirm the
right new response text comes back) added to `tests/manual/phase2.real-sites.md`.

**Milestone 2 鈥?Claude send + wait + latest-response detection**
Files: `claudeSelectors.ts`, `claudeSite.ts` (extended), `tests/unit/claudeAdapter.spec.ts`.
Same done-criteria, mirrored for Claude.

**Milestone 3 鈥?One ChatGPT 鈫?Claude round**
Files: `orchestrator/prompts.ts` (initial + reviewer templates only),
`orchestrator/convergence.ts`, `tests/unit/convergenceParser.spec.ts`,
`tests/unit/promptTemplates.spec.ts`, plus a minimal driver (can live temporarily in
`reviewMain.ts` or a throwaway script) that performs exactly one real handoff against the
attached browser and prints the parsed convergence result. Done when a single manual
real-site run produces a sensible `round-01-chatgpt`/`round-01-claude` pair and a
correctly parsed `STATUS`.

**Milestone 4 鈥?Multi-round orchestrator + convergence loop**
Files: `orchestrator/types.ts`, `orchestrator/reviewOrchestrator.ts` (full state machine:
revision prompts, `maxRounds`, all 搂8 safety states, stalled-loop guard),
`tests/unit/orchestrator.spec.ts`, `tests/unit/toolIsolation.spec.ts`. Done when the full
automated suite (fake adapters, no browser) proves convergence-stop, max-rounds-stop, and
every pause/error path in 搂8's table.

**Milestone 5 鈥?Persistence + resume**
Files: `orchestrator/runStore.ts`, `reviewMain.ts` (real composition root + CLI
`--resume`), `tests/unit/runStore.spec.ts`, `tests/unit/resume.spec.ts`, `.gitignore`
update, `package.json` script. Done when: automated persistence/resume tests pass, and one
full manual end-to-end run against real ChatGPT/Claude (2鈥? rounds) is completed,
including killing the process mid-run and successfully resuming it.

---

## Summary for the user

- **Recommended architecture:** two thin `ConversationalSiteAdapter` implementations
  (extending the existing `chatgptSite.ts`/`claudeSite.ts`, sharing generic polling/fill
  helpers in a new `domUtil.ts`) feeding a browser-agnostic `ReviewOrchestrator` that only
  depends on that adapter interface, with a strict `STATUS:`-line convergence parser and a
  `runs/<id>/` persistence layer with atomic `state.json` writes and disk-reconciled
  resume. This mirrors Phase 1's own separation of concerns (`DECISIONS.md` 搂6) instead of
  introducing a new pattern.
- **Biggest technical risks, roughly in order:**
  1. **Selector/DOM fragility** 鈥?ChatGPT and Claude can change their markup at any time;
     mitigated by the fallback-array pattern (搂9) but never eliminated, and the
     illustrative selectors in this doc are unverified starting points, not final values.
  2. **Generation-completion false signals** 鈥?a UI that clears its "stop" button before
     rendering is fully settled (or that briefly re-shows it mid-stream) can cause either a
     truncated capture or a stuck wait; mitigated by the two-signal (state + text-stability)
     design in 搂1, but this is the single most likely source of subtle bugs.
  3. **Response confusion** (old vs. new message) 鈥?mitigated by the baseline/id-diff
     design in 搂10, but depends on the site consistently exposing *some* stable per-message
     identity; if it doesn't, the fallback (index+handle pairing) is weaker.
  4. **12 rounds 脳 2 sites of real, unattended web-UI automation** is a long unattended
     window in which a Cloudflare re-challenge, a session expiry, or a UI update can occur;
     the pause-and-resume design (搂7/搂8) is what keeps a mid-run failure cheap rather than
     making the whole run worthless, but it does mean Phase 2 is not "fire and forget"
     until a run has actually completed once end-to-end.
  5. Everything else (empty responses, malformed convergence, refusals) is comparatively
     easy 鈥?deterministic checks with a documented, bounded response (搂8).
- **Exact first implementation milestone:** Milestone 1 鈥?ChatGPT send + wait +
  latest-response detection, built and tested entirely against
  `tests/fixtures/fakeChat.html`, with a single manual real-ChatGPT smoke check at the end.
- **Files Codex should touch first (Milestone 1 only):**
  - `src/browser/domUtil.ts` (new)
  - `src/sites/selectors/chatgptSelectors.ts` (new)
  - `src/sites/siteTypes.ts` (add `ConversationalSiteAdapter`, additive only)
  - `src/sites/chatgptSite.ts` (extend in place)
  - `tests/fixtures/fakeChat.html` (new)
  - `tests/unit/chatgptAdapter.spec.ts` (new)
  - `tests/unit/turnBaseline.spec.ts` (new)

  Nothing else 鈥?`claudeSite.ts`, the orchestrator, prompts, and persistence are all later
  milestones and should not be touched yet.
## 15. Milestone 1 real-page completion clarification

The real ChatGPT smoke test verified that the normal Send control may be absent or
replaced after a response completes. Therefore, the completion rule is: a new assistant
response exists relative to the TurnBaseline, its normalized text is non-empty, no
**visible** generation-active/stop control is present for consecutive polls, and the text
remains unchanged for the configured stability interval. Send-button visibility or
enabled state is diagnostic only and must not be required for completion.
## 16. Verified Claude Milestone 2 real-page result

The real Claude Milestone 2 smoke test passed against the existing attached Claude tab.
The adapter successfully verified existing-tab discovery, prompt submission,
generation-start detection, generation-completion detection, and current-turn response
extraction, with the response PHASE2_CLAUDE_OK.

The verified Claude DOM structure is:
- assistant message container: `[role="article"]:has([data-perf-reply-text])`
- response text: `[data-perf-reply-text]`
- active generation: `[data-is-streaming="true"]`

The response container is distinguished from sidebar conversation rows, chat headers,
conversation titles, and user messages by the response-text descendant. The completion
check combines the Claude streaming state with the existing new-response, non-empty,
and text-stability safeguards.

