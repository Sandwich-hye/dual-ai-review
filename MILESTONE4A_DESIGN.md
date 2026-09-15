# MILESTONE4A_DESIGN.md — Fixed multi-round ChatGPT ⇄ Claude review loop

Design-only document for Phase 2A Milestone 4A. No production TypeScript is changed by
this document. It builds on the frozen, real-browser-verified Milestone 3 flow
(`src/orchestration/runSingleReviewRound.ts`) and the adapter contracts in
`src/sites/siteTypes.ts`, `src/sites/chatgptSite.ts`, `src/sites/claudeSite.ts`,
`src/sites/claudeUserTurns.ts`, and `src/browser/domUtil.ts`.

---

## 1. Goal / Non-goals

**Goal:** extend the proven single-round flow into a deterministic, fixed-count
multi-round loop:

```
G0 → C1 → G1 → C2 → G2 → ... → C(reviewRounds) → G(reviewRounds) → finish
```

where one "review round" = **Claude reviews the current ChatGPT answer, then ChatGPT
revises based on that review.** `reviewRounds = 2` means exactly `G0 C1 G1 C2 G2` — five
site turns total, in that order, and nothing else.

**Non-goals (explicitly out of scope for Milestone 4A):**
- Convergence detection, `STATUS: CONTINUE`/`CONVERGED`, semantic stopping.
- Using `maxRounds` as anything other than a fixed count to execute in full.
- Persistence/resume, `runs/<run-id>/`, an `ArtifactStore`.
- File upload/download, artifact transfer between sites.
- Pause/interruption, mid-run human guidance injection.
- Any API usage, private endpoints, stealth, or CAPTCHA/Cloudflare automation.
- Any redesign of Milestone 3's send/wait/extract adapter internals.

---

## 2. Existing stable foundation (frozen, reused as-is)

Milestone 3 proved the following and none of it is touched by this design:

- `ConversationalSiteAdapter` (`src/sites/siteTypes.ts`): `checkReady`,
  `captureTurnBaseline`, `sendPrompt`, `waitForGenerationStart`,
  `waitForGenerationComplete`, `getLatestAssistantResponse`.
- ChatGPT and Claude adapters (`chatgptSite.ts`, `claudeSite.ts`) implementing that
  interface, including the two-signal (UI-state + text-stability) completion detector
  and the id-diff `TurnBaseline`/`AmbiguousNewMessageError` mechanism in `domUtil.ts`.
- Claude-specific DOM facts: assistant container
  `[role="article"]:has([data-perf-reply-text])`, response text
  `[data-perf-reply-text]`, active generation `[data-is-streaming="true"]`; user turns
  positively identified via the Edit control (`claudeUserTurns.ts`).
- `runSingleReviewRound.ts`'s stage-wrapped error pattern
  (`ensureReady`/`captureBaseline`/`send`/`waitStart`/`waitComplete`/`extract`, each
  wrapping failures into a typed, stage-tagged error).
- Attached-browser invariants: never navigate, never close, never fill/click through a
  login or Cloudflare/security-verification page, never call a private API.

Milestone 4A adds a **new** orchestration module that calls these same adapter methods
more times, in a fixed sequence, on the same `Page` instances. It does not add new
adapter methods and does not change `chatgptSite.ts`/`claudeSite.ts`/`domUtil.ts`.

---

## 3. Fixed-round state machine

For a run with `reviewRounds = N` (N ≥ 1):

```
state: INITIAL_CHATGPT
  → send task to ChatGPT → wait → extract → G0
  → state: ROUND(1)

state: ROUND(n)   [n = 1..N]
  → build Claude review prompt from (task, G[n-1])
  → send to Claude → wait → extract → C[n]
  → build ChatGPT revision prompt from (task, G[n-1], C[n])
  → send to ChatGPT → wait → extract → G[n]
  → if n == N: state DONE (finalAnswer = G[N])
    else: state ROUND(n+1)
```

There is no branching on response content anywhere in this state machine — the only
loop-control variable is the round counter against `reviewRounds`. This is intentionally
the simplest model that satisfies the spec; convergence/early-stop is a Milestone 4B
concern and must not leak in here (e.g. no peeking at Claude's text to decide whether to
continue).

`reviewRounds` is a plain function parameter (not a config-file field) — see §14 for why.

---

## 4. Data model

New file `src/orchestration/fixedReviewLoopTypes.ts` (or inlined at the top of
`runFixedReviewLoop.ts` — implementation detail, not load-bearing):

```ts
export interface InitialChatGptTurn {
  prompt: string;        // exactly the original task text, unmodified
  response: string;      // G0
  startedAt: string;     // ISO timestamp, captured just before sendPrompt
  completedAt: string;   // ISO timestamp, captured just after extract
}

export interface ReviewRoundRecord {
  roundNumber: number;             // 1..reviewRounds
  claudeReviewPrompt: string;      // built from task + G[n-1]
  claudeReviewResponse: string;    // C[n]
  claudeStartedAt: string;
  claudeCompletedAt: string;
  chatgptRevisionPrompt: string;   // built from task + G[n-1] + C[n]
  chatgptRevisionResponse: string; // G[n]
  chatgptStartedAt: string;
  chatgptCompletedAt: string;
}

export interface FixedReviewLoopPartialResult {
  originalTask: string;
  reviewRounds: number;              // requested count
  initial?: InitialChatGptTurn;      // present once G0 completes
  rounds: ReviewRoundRecord[];       // only fully-completed rounds, in order
}

export interface FixedReviewLoopResult extends FixedReviewLoopPartialResult {
  initial: InitialChatGptTurn;       // guaranteed present on success
  finalAnswer: string;               // last completed round's G[n], or G0 if reviewRounds is 0
}
```

A "round" record is written atomically **in memory** — it is only pushed onto
`rounds[]` after both its Claude and ChatGPT turns have completed successfully. A round
that fails partway (e.g. Claude review completes but the ChatGPT revision fails) is
**not** added to `rounds[]`; its partial content is instead attached to the thrown error
(§8), not silently dropped and not silently counted as done.

This avoids inventing a separate `ReviewRun`/`ChatGPTTurn`/`ClaudeReview` class
hierarchy — three flat interfaces are enough to satisfy every field the task lists
(round number, inputs, outputs, timestamps, and — via the error object — failure stage).

---

## 5. Adapter / orchestrator boundaries

`runFixedReviewLoop` depends **only** on `ConversationalSiteAdapter` from
`siteTypes.ts`, exactly like `runSingleReviewRound`. It never imports `chatgptSite.ts`
or `claudeSite.ts` directly (call sites pass in
`createChatGPTConversationalAdapter(...)`/`createClaudeConversationalAdapter(...)`
instances, same as `scripts/smoke-single-round.ts` does today).

Proposed signature (new file `src/orchestration/runFixedReviewLoop.ts`):

```ts
export interface FixedReviewLoopSite {
  page: Page;
  adapter: ConversationalSiteAdapter;
  generationTimeoutMs?: number;
}

export interface FixedReviewLoopInput {
  originalTask: string;
  reviewRounds: number;                 // >= 1, validated synchronously
  chatgpt: FixedReviewLoopSite;
  claude: FixedReviewLoopSite;
  baselineSettle?: { delayMs?: number; maxAttempts?: number }; // see §9, has defaults
}

export async function runFixedReviewLoop(
  input: FixedReviewLoopInput,
): Promise<FixedReviewLoopResult>;
```

Internally it reuses the same shape of stage-wrapped helpers as
`runSingleReviewRound.ts` (`ensureReady`, `send`, `waitStart`, `waitComplete`,
`extract`), parameterized by the current `FixedReviewLoopStage` (§8) instead of the
flat `SingleRoundStage` string union. Whether these helpers are literally duplicated
into the new file or factored into a small shared internal module
(`src/orchestration/siteTurnSteps.ts`) is a mechanical implementation choice for
Milestone 4A's build step, not a design decision — either way `runSingleReviewRound.ts`
and its tests/smoke script are left byte-for-byte working and unmodified.

`reviewRounds = 1` must produce **exactly** the same four-turn sequence
(`G0 C1 G1`, i.e. one Claude review and one ChatGPT revision) as a degenerate case of the
same loop — there is no separate code path for "one round" vs "many rounds."

---

## 6. Prompt contracts

New pure module `src/orchestration/fixedReviewPrompts.ts` (kept separate from the
existing `src/orchestration/reviewPrompt.ts`, which stays exactly as-is — it is still
used by `runSingleReviewRound.ts` and its frozen Milestone 3 tests/smoke script, and its
wording ("For this Milestone 3 test...") is specific to that milestone).

```ts
export function buildInitialChatGptPrompt(task: string): string;
// Identity for 4A: returns `task` unchanged. Kept as a named function (rather than
// inlining `task` at the call site) so every prompt sent to either site in this module
// has a single, testable builder — see the unit-test matrix (§10, test 4).

export function buildClaudeReviewPrompt(task: string, chatgptAnswer: string): string;
// Used for EVERY round's Claude review (round 1..N) — the wording does not vary by
// round number, and the full task + full current answer are restated every time
// (see §7 for why this is a deliberate 4A choice). Must NOT request a STATUS line.

export function buildChatGptRevisionPrompt(
  task: string,
  chatgptPreviousAnswer: string,
  claudeReview: string,
): string;
// Instructs ChatGPT to produce a COMPLETE revised answer, not commentary about the
// review. Restates task + its own previous answer + Claude's review in full.
```

Illustrative bodies (final wording is an implementation detail, not a design
constraint — the contract is *which fields are present*, not the exact prose):

```
buildClaudeReviewPrompt:
  "You are Claude. Review the following answer produced by ChatGPT.
   TASK: <task>
   CURRENT ANSWER: <chatgptAnswer>
   Review it critically but fairly. Identify concrete issues that materially affect
   correctness, completeness, or quality. Do not invent speculative objections.
   Do not include a STATUS line or any convergence verdict — just the review."

buildChatGptRevisionPrompt:
  "TASK: <task>
   YOUR PREVIOUS ANSWER: <chatgptPreviousAnswer>
   REVIEWER FEEDBACK: <claudeReview>
   Revise your previous answer to address this feedback. Provide your complete,
   revised, standalone answer — not a summary of what you changed, not commentary
   about the review itself."
```

**Every unit test that checks prompt contents (§10, tests 4–6) asserts against these
builder functions directly**, not against the orchestrator's internal wiring — this
keeps prompt-format tests independent of the loop's control flow.

---

## 7. Conversation-context policy

Three explicit layers, so responsibility never blurs between "the loop" and "the DOM":

**a) What belongs to orchestration (`runFixedReviewLoop`, 4A, implemented now):**
- It never navigates a page and never opens/closes a tab. It receives already-open,
  already-`page`-attached `FixedReviewLoopSite` objects and reuses the same `Page`
  instance for every turn of every round in the run — this *is* "within a run, reuse the
  same conversation," and it requires no new mechanism because Milestone 3 already
  behaves this way (`runSingleReviewRound` already sends two prompts into the same pages
  it was given).
- It captures a fresh `TurnBaseline` at the top of every single turn (not once per
  round, not once per run) — exactly Milestone 3's existing discipline, carried forward
  unchanged. This is what keeps each extraction correct regardless of how long the
  conversation has grown.
- Because both prompt builders (§6) restate the **full** task and **full** current
  answer/review on every round, correctness of the handoff does not depend on the model
  actually attending to its own visible conversation history — the explicit restated
  text is authoritative. (This is a deliberate simplification vs. `PHASE2_DESIGN.md`
  §6's leaner "don't re-paste, rely on tab context" sketch for round ≥ 2 — see §14.)

**b) What is explicitly deferred to a future `ConversationSession` abstraction (not
built in 4A):**
- "Start a brand-new, empty conversation for this run" (so run N+1 never sees run N's
  task/answers) is **not implemented**. Doing so would require navigating ChatGPT to a
  fresh chat / clicking Claude's "New chat," which is exactly the kind of tab navigation
  `SPEC.md` §8b forbids in attach mode ("does not create replacement tabs or navigate
  existing tabs" — the attached tabs are user-owned).
- The future interface boundary, when this is built (Phase 4B/5, launch-mode only or
  gated behind explicit user opt-in), would look like:
  ```ts
  interface ConversationSession {
    site: "chatgpt" | "claude";
    startFresh(page: Page): Promise<void>; // navigates to a genuinely new chat
  }
  ```
  `ReviewOrchestrator`/`runFixedReviewLoop` would call `session.startFresh(page)` **once,
  at run start, before capturing any baseline** — never mid-run. Attach mode would either
  not support this capability at all, or require it to have already been done by the
  human (same posture as login: automation waits, never automates the click) before the
  run begins.

**c) How a run "knows it owns a conversation":** it doesn't, and 4A does not pretend it
does. A run simply operates on whatever conversation is currently loaded in the attached
tabs at the moment it starts, for its entire duration. Isolation between *separate runs*
sharing the same tab is the user's responsibility for 4A (start a new ChatGPT/Claude chat
manually before kicking off a new task) — exactly the situation already recorded in
`DECISIONS.md` §11d ("Claude may... say things such as 'same input a fourth time'...
non-blocking"). Milestone 4A does not fix this; it only guarantees that *within one run*,
all rounds correctly share one conversation, and it documents the cross-run limitation
explicitly instead of leaving it as an undocumented side-effect.

**d) Attached-tab safety, restated:** no code path introduced by this design ever calls
`page.goto`, opens a new page, or clicks a "new chat" control. This is the "minimum
implementation 4A should use" answer requested by the task: **reuse whatever is open,
document the limitation, defer fresh-conversation automation entirely.**

---

## 8. Failure semantics

New structured stage type (replaces the flat string union approach for this module only
— `SingleRoundStage` in `runSingleReviewRound.ts` is untouched):

```ts
export type TurnSite = "chatgpt" | "claude";
export type TurnKind = "initial" | "claude_review" | "chatgpt_revision";
export type TurnStep =
  | "readiness" | "baseline" | "send"
  | "generation_start" | "generation_complete" | "extract";

export interface FixedReviewLoopStage {
  round: number;      // 0 for the initial ChatGPT turn, else 1..reviewRounds
  turn: TurnKind;
  site: TurnSite;
  step: TurnStep;
}
```

This directly covers the example stage identifiers from the task
(`initial_chatgpt_send` = `{round:0, turn:"initial", site:"chatgpt", step:"send"}`,
`claude_review_generation` = `{round:n, turn:"claude_review", site:"claude",
step:"generation_complete"}`, etc.) while keeping `round`/`site`/`turn`/`step` as
separately inspectable fields rather than a string to parse.

```ts
export class FixedReviewLoopError extends Error {
  constructor(
    public readonly stage: FixedReviewLoopStage,
    message: string,
    public readonly partialResult: FixedReviewLoopPartialResult,
    public readonly cause?: unknown,
  ) { super(message); this.name = "FixedReviewLoopError"; }
}
```

Every stage-wrapped helper (§5) catches its underlying error/outcome and throws
`FixedReviewLoopError` with:
- the precise `stage` at which it failed,
- a safe, human-readable `message` (mirrors `SingleReviewRoundError`'s existing
  behavior — underlying error message, or a fixed description for a non-`complete`
  `GenerationOutcome`),
- `partialResult` = everything completed so far (`initial`, if done, plus every fully
  completed `ReviewRoundRecord`) — this is what makes the run's partial progress
  inspectable after a failure (task requirement: "partial completed rounds remain
  available in result"),
- `cause` = the original thrown error or `GenerationOutcome`, for diagnostics (never
  logged with content redacted — task/response text is expected in these logs during
  local development, matching Milestone 3's existing practice; no new PII/secret
  handling concern is introduced here beyond what Milestone 3 already has).

**No automatic destructive recovery. No automatic resubmission of `sendPrompt` under any
failure classification, ever** — a `send` step that throws stops the run immediately;
the loop never re-enters the same `turn`/`site`/`step` a second time. (The one
"automatic retry" concept in `PHASE2_DESIGN.md` — the malformed-`STATUS:` reformat retry
— belongs to convergence detection and does not exist in 4A at all.)

---

## 9. Stable waiting / duplicate-submit safety

Two separate concerns, kept separate:

**a) Generation-completion waiting** — unchanged. `waitForGenerationStart` and
`waitForGenerationComplete` are Milestone-3-proven, frozen, and reused as-is
(two-signal design: UI stop-button state, then ≥2 consecutive inactive polls **and** a
700 ms text-stability window before declaring `"complete"`). Milestone 4A does not touch
this and does not need to — it already is the "stable observation window" the task asks
for, and it already fails safe (`timeout`/`error_banner` outcomes, no auto-retry).

**b) The documented reliability observation (baseline 2 / current 4).** Root-caused:
this came from an ad hoc, single-read sanity check in `scripts/smoke-claude-long-prompt.ts`
(lines ~57–66) that breaks out of its poll loop the instant a user-turn count first
reaches `baseline + 1`, then does one hard equality check with no settle read — so a
transient double-render of the message list (observed once, non-reproducible on rerun)
was read as a hard failure instead of a transient state. This is **not** a defect in the
production `sendPrompt`/`waitForGenerationComplete`/`getLatestAssistantResponse` path
(which already debounces) — it is a defect in that one smoke script's own extra
assertion, which is not part of any adapter or orchestrator.

Milestone 4A's design response, without reopening Milestone 3:
1. **Do not add a new hard-equality user-turn-count gate to `runFixedReviewLoop`.**
   Milestone 3's existing `AmbiguousNewMessageError` (exactly-one-new-message check
   inside `getLatestAssistantResponse`) is already the correct, debounced authority for
   "did exactly one new turn happen" — duplicating it with a cruder counter would
   reintroduce the same class of flake, not fix it.
2. **Baseline capture gets a settle-then-confirm read**, added at the orchestration
   level only (new code in `runFixedReviewLoop.ts`, not in `domUtil.ts`):
   ```ts
   async function captureSettledBaseline(
     site: FixedReviewLoopSite,
     settle: { delayMs: number; maxAttempts: number },
   ): Promise<TurnBaseline> {
     let previous = await site.adapter.captureTurnBaseline(site.page);
     for (let attempt = 1; attempt < settle.maxAttempts; attempt += 1) {
       await sleep(settle.delayMs);
       const next = await site.adapter.captureTurnBaseline(site.page);
       if (next.count === previous.count) return next;
       previous = next;
     }
     return previous; // last reading wins; never itself fails the run
   }
   ```
   Defaults: `delayMs: 250`, `maxAttempts: 3` (i.e. at most ~500 ms added per baseline
   capture, only when the count is actually still moving). This targets exactly the
   moment the anomaly was observed — right after a previous turn's UI has just finished
   settling — without ever turning a disagreement into a failure by itself. If the count
   still hasn't stabilized after `maxAttempts`, the loop proceeds with the latest
   reading; if that reading turns out to be wrong, Milestone 3's own
   `AmbiguousNewMessageError` at extraction time is the real, unchanged safety net.
3. **Any future replacement smoke test that re-adds a user-turn sanity assertion** (see
   §11) must use the same settle-then-confirm pattern (poll, then require two
   consecutive equal reads, bounded by a short timeout) instead of the old
   break-on-first-match-then-hard-fail pattern.

**Hard invariant, restated explicitly because the task calls it out:** if submission
state is ever ambiguous — `sendPrompt` throws, `waitForGenerationStart` returns
`"not_observed"` after its timeout and is treated as a failure by the caller, or
`waitForGenerationComplete`/`getLatestAssistantResponse` report anything other than a
clean success — `runFixedReviewLoop` **never** calls `sendPrompt` again for that turn.
It fails the stage (§8) and stops. There is exactly one `sendPrompt` call per logical
turn in the entire module, with no retry path anywhere.

---

## 10. Unit-test matrix

All tests run offline against fake, in-memory adapters (no Playwright `Page`, following
`tests/unit/runSingleReviewRound.spec.ts`'s existing pattern, extended). New file:
`tests/unit/runFixedReviewLoop.spec.ts`.

Fake adapter needs two upgrades over Milestone 3's `fakeAdapter`: (a) queued/response
sequencing per call (round 1's ChatGPT response must differ from round 2's), and (b) the
ability to script a failure on the *Nth* call of a specific method rather than every
call. Sketch:

```ts
function fakeConversationalAdapter(opts: {
  name: string;
  responses: string[];              // consumed in order by getLatestAssistantResponse
  calls: string[];
  failAt?: { method: keyof ConversationalSiteAdapter; occurrence: number; as?: "throw" | GenerationOutcome };
}): ConversationalSiteAdapter
```

| # | Requirement | Test |
|---|---|---|
| 1 | Exactly 2 fixed review rounds, correct call order | `runFixedReviewLoop({reviewRounds: 2, ...})` → assert call-log order equals `chatgpt(initial).* , claude(round1).*, chatgpt(round1).*, claude(round2).*, chatgpt(round2).*` |
| 2 | Exactly 1 round | same with `reviewRounds: 1` → call log is the round-1 prefix only, `result.rounds.length === 1` |
| 3 | Configurable round count | parameterized test over `reviewRounds ∈ {1,2,3,5}`, asserting `result.rounds.length === reviewRounds` and total ChatGPT calls `=== reviewRounds + 1` |
| 4 | Original task preserved in every prompt | assert `task` substring present in every recorded `sendPrompt` argument across all rounds (initial + every Claude review + every ChatGPT revision) |
| 5 | Claude review N based on ChatGPT answer N−1 | fake ChatGPT responses are distinct per round (`"G0"`,`"G1"`,`"G2"`); assert `claudeReviewPrompt` for round N contains exactly `G[N-1]`, not `G[N]` or any other round's text |
| 6 | ChatGPT revision N receives Claude review N | assert `chatgptRevisionPrompt` for round N contains `C[N]`'s exact text |
| 7 | Final answer is the final ChatGPT revision | `result.finalAnswer === result.rounds[result.rounds.length - 1].chatgptRevisionResponse` |
| 8 | No accidental extra Claude call | total `claude.sendPrompt` calls `=== reviewRounds` exactly |
| 9 | No accidental extra ChatGPT call | total `chatgpt.sendPrompt` calls `=== reviewRounds + 1` exactly |
| 10 | Failure during Claude round 2 stops the run safely | `failAt: {method: "getLatestAssistantResponse", occurrence: 2}` on the Claude adapter with `reviewRounds: 3` → rejects with `FixedReviewLoopError` whose `stage` is `{round:2, turn:"claude_review", site:"claude", step:"extract"}`; assert **no** `chatgpt.sendPrompt` call happened for round 2 or 3 |
| 11 | Failure during ChatGPT revision stops the run safely | `failAt` on ChatGPT's `waitForGenerationComplete` (return `timeout` outcome) at round 1 → rejects with stage `{round:1, turn:"chatgpt_revision", site:"chatgpt", step:"generation_complete"}`; assert no round-2 Claude call happened |
| 12 | Partial completed rounds remain available in result | in test 10/11's failure case, assert `error.partialResult.rounds` contains the fully-completed round(s) before the failure (e.g. round 1 complete, round 2 failed mid-way ⇒ `partialResult.rounds.length === 1`) and `error.partialResult.initial` is present |
| 13 | Transient user-turn/count instability does not cause immediate false failure | fake adapter's `captureTurnBaseline` returns `{count: 2}` on its first call and `{count: 3}` on its second call for the same turn (simulating a still-settling DOM); assert `runFixedReviewLoop` still completes successfully using the settled reading, i.e. `captureSettledBaseline` (§9) is exercised and does not propagate the disagreement as a failure |
| 14 | Ambiguous submit state never causes automatic second Send click | fake adapter's `sendPrompt` throws on its first call for a given turn; assert the call log shows exactly **one** `sendPrompt` invocation for that turn (not two) before the run rejects — i.e. failure short-circuits rather than retrying |

Also carried over unchanged from Milestone 3's own suite (no new test needed, just
confirm they still pass): `tests/unit/runSingleReviewRound.spec.ts` in full, since
`runFixedReviewLoop` is additive and does not modify that file or its dependencies.

---

## 11. Real smoke-test plan

New script: `scripts/smoke-multi-round.ts`, new command `npm run smoke:multi-round`
(`"smoke:multi-round": "npm run build && node dist/scripts/smoke-multi-round.js"`),
mirroring `scripts/smoke-single-round.ts`'s structure exactly (CDP connect → discover
existing tabs by hostname → build adapters → run → print → exit code).

Deterministic small task, e.g.:
```
const TASK = "Give exactly three practical benefits of automated software testing.";
```
`reviewRounds = 2` (hard default for this script; could accept an optional CLI arg later
if needed, but 4A only requires 2 to be exercised for real).

**Output contract** (printed in order, matching the task's requested shape):
```
Original task
<task>

Initial ChatGPT answer
<G0>

Round 1 Claude review
<C1>
Round 1 ChatGPT revision
<G1>

Round 2 Claude review
<C2>
Round 2 ChatGPT revision
<G2>

Final answer
<G2>

MULTI-ROUND SMOKE TEST PASSED
```
On failure: `MULTI-ROUND SMOKE TEST FAILED`, plus the structured `stage`
(`round`/`turn`/`site`/`step`) and message, plus whatever `partialResult` was captured —
mirroring `smoke-single-round.ts`'s existing catch block.

**Guarding against a silent hidden duplicate submission** (explicit task requirement):
before running the loop, capture each site's assistant-message count via the already
public `captureChatGPTTurnBaseline`/`captureClaudeTurnBaseline` (used only as a
counter here, not as the loop's own baseline). After the run completes:
```
finalChatGptCount - initialChatGptCount === reviewRounds + 1   // G0..G(reviewRounds)
finalClaudeCount  - initialClaudeCount  === reviewRounds        // C1..C(reviewRounds)
```
If either delta is off (too high ⇒ a duplicate send produced an extra turn; too low ⇒
something was skipped), the script exits non-zero with an explicit
`"MULTI-ROUND SMOKE TEST FAILED: unexpected turn-count delta"` message **even if**
`runFixedReviewLoop` itself reported success — this is an independent, outside-the-loop
check specifically so a hidden double-submission cannot silently pass. This replaces
(and corrects, per §9) the old single-read hard-equality pattern from
`smoke-claude-long-prompt.ts`: the counts here are read once well after generation has
fully completed and stabilized (not raced against streaming), so no settle-loop is
needed for this particular check — it's a before/after delta, not a mid-stream read.

**Manual pass criteria:** run once against the real, attached ChatGPT/Claude tabs
(same CDP setup as Milestone 3), read the five printed exchanges for sanity (Claude's
review 2 should plausibly reference round 1's revision), confirm the turn-count deltas
above, confirm exit code 0 and the `PASSED` banner. Recorded in
`tests/manual/phase2.real-sites.md` (new checklist entries) or a new
`tests/manual/phase2.multi-round.md`, mirroring the existing manual-test doc pattern.

---

## 12. Proposed implementation file changes (for the future implementation session — none of this is created now)

**New files:**
- `src/orchestration/runFixedReviewLoop.ts` — the state machine (§3–5, §8–9).
- `src/orchestration/fixedReviewPrompts.ts` — the three prompt builders (§6).
- `scripts/smoke-multi-round.ts` — real smoke test (§11).
- `tests/unit/runFixedReviewLoop.spec.ts` — test matrix (§10).
- `tests/unit/fixedReviewPrompts.spec.ts` — prompt-builder content tests (small,
  snapshot-style, mirrors what `runSingleReviewRound.spec.ts` currently checks inline
  for `buildClaudeReviewPrompt`).

**Modified files:**
- `package.json` — add the `smoke:multi-round` script only. No other script changes.
- `TODO.md` — add planned (unchecked) Milestone 4A tasks (done as part of *this* design
  turn, per the task's own instructions — see the diff already applied).

**Explicitly untouched:**
- `src/sites/siteTypes.ts`, `src/sites/chatgptSite.ts`, `src/sites/claudeSite.ts`,
  `src/sites/claudeUserTurns.ts`, `src/browser/domUtil.ts`, `src/sites/selectors/*`.
- `src/orchestration/runSingleReviewRound.ts`, `src/orchestration/reviewPrompt.ts`,
  `scripts/smoke-single-round.ts`, `scripts/smoke-claude-long-prompt.ts`.
- `src/config/loadConfig.ts`, `config/config.json` (see §14 on why `reviewRounds` is not
  a config field in 4A).
- Every existing test file.

---

## 13. Acceptance criteria

Milestone 4A implementation (a future session) is done when:

- [ ] `runFixedReviewLoop` exists, depends only on `ConversationalSiteAdapter`, and
      contains no Playwright selectors.
- [ ] All 14 unit-test-matrix cases (§10) pass, offline, with no real browser.
- [ ] `npm test` (existing Playwright-test-runner suite) still passes in full, unchanged,
      including every Milestone 1–3 spec file.
- [ ] `npm run smoke:multi-round` passes once against the real, attached ChatGPT and
      Claude tabs with `reviewRounds = 2`, producing the exact five-turn output shape in
      §11 and satisfying both turn-count-delta checks.
- [ ] No new adapter method, selector, or DOM-reading helper was added to
      `chatgptSite.ts`/`claudeSite.ts`/`domUtil.ts`.
- [ ] No tab navigation, tab creation, or tab close was added anywhere in the new code.
- [ ] `TODO.md` reflects the real, verified state (unchecked until actually implemented
      and verified, per `TODO.md`'s own rules).

---

## 14. Risks / open questions

1. **Full restatement vs. lean prompts.** This design has every round's prompts restate
   the full task and full current answer/review (per the task's explicit prompt-content
   spec), which is a deliberate step back from `PHASE2_DESIGN.md` §6's leaner "don't
   re-paste, the tab already has it" sketch for round ≥ 2. This trades some prompt
   verbosity/token-length growth for robustness against exactly the kind of
   conversation-context confusion `DECISIONS.md` §11d already flagged. Recommend keeping
   the restatement approach through 4A and revisiting only if real multi-round runs show
   it causing its own problems (e.g. a model getting confused by being handed its own
   answer twice — once in visible history, once pasted back).
2. **`reviewRounds` as a parameter, not a config field.** Kept out of
   `config/config.json`/`loadConfig.ts` for 4A to avoid growing the config schema before
   Phase 4B/5 persistence needs a real place to store per-run settings anyway. Open
   question for whoever starts 4B: does `runs/<run-id>/state.json` (from
   `PHASE2_DESIGN.md` §7) become the actual home for this, making a config-file default
   unnecessary permanently?
3. **Settle-read constants (250 ms × 3 attempts, §9) are unverified against real Claude
   behavior** — they're a reasonable guess informed by the one observed anomaly, not a
   number derived from repeated measurement. The real multi-round smoke test (§11) is the
   first place these constants get exercised against the actual site; they may need
   tuning after that run.
4. **No early stop.** By design, the loop always runs the full `reviewRounds` count even
   if Claude's very first review would clearly say the answer is already fine. This is
   correct per the explicit non-goals (§1) but worth flagging so a future reader isn't
   surprised the fixed loop "wastes" rounds — that's expected until Milestone 4B adds
   convergence detection.
5. **Cross-run conversation contamination remains unresolved by design** (§7c) — this is
   carried forward as a known, documented limitation rather than solved, consistent with
   `DECISIONS.md` §11d's existing non-blocking status. No open question here, just a
   reminder that it is still not fixed.

## 15. Implementation correction

The implementation follows the architecture correction for Milestone 4A: baseline capture
is a single call to the existing adapter contract for each turn. `runFixedReviewLoop` does
not inspect Claude DOM, user-turn counts, selectors, or ProseMirror structure, and does not
add a settling helper or adapter method. The adapter's existing baseline/send/wait/extract
guarantees remain authoritative; ambiguous submission fails safely without retry.

### Generation-start timeout

The fixed loop uses a bounded, configurable generation-start timeout. generationStartTimeoutMs defaults to 30,000 ms and is passed to every G0/C1/G1/C2/G2 start wait. Generation completion remains separately bounded by each site''s generationTimeoutMs, defaulting to 180,000 ms. A timeout fails the current stage and preserves the partial result; it never triggers an automatic resend.
