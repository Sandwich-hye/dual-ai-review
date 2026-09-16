# TODO.md 閳?dual-ai-review

This file is the persistent source of truth for project progress. It must always reflect
the actual, verified state of the repository 閳?not intentions, not "should be working."

**Rules for every future agent (human or AI) editing this file:**

1. A task moves from `[ ]` to `[x]` only after it is both implemented **and** verified
   (see each phase's acceptance criteria / test plan in `SPEC.md`).
2. Never delete a completed (`[x]`) task in a future session. If it's superseded, add a
   note rather than removing history.
3. If something is discovered broken or incomplete, uncheck it (with a note in "Blocked /
   Issues") rather than leaving a stale checkmark.
4. If new required work is discovered, add it under the relevant phase (or to "Blocked /
   Issues" if it's a cross-cutting problem) 閳?don't just fix it silently.
5. Read `SPEC.md` and `DECISIONS.md` before changing any code, not just this file.

---

## Current Phase

**Phase 2A — Milestone 4A complete** (fixed two-round real ChatGPT-to-Claude flow verified); **Milestone 4B design revised after a convergence-safety architect review** (see `MILESTONE4B_DESIGN.md`), implementation not started.

---

## Phase 1 閳?Browser Foundation

### Setup
- [x] Initialize `package.json` (Node + TypeScript project)
- [x] Add Playwright as a dependency and run its browser install step
- [x] Add `tsconfig.json`
- [x] Add `.gitignore` covering `.browser-profile/`, `logs/`, `node_modules/`,
      `test-results/`, `playwright-report/`
- [x] Create `config/config.json` with the Phase 1 schema from `SPEC.md` 鎼?1

### Core modules
- [x] `src/logging/logger.ts` 閳?console + file logger
- [x] `src/config/loadConfig.ts` 閳?load + validate `config/config.json`
- [x] `src/browser/launchBrowser.ts` 閳?persistent context launch (profile dir, headed,
      timeouts)
- [x] `src/browser/shutdown.ts` 閳?clean close on success / error / SIGINT / SIGTERM
- [x] `src/sites/siteTypes.ts` 閳?`SiteAdapter` / `SiteLoadResult` shared types
- [x] `src/sites/siteRegistry.ts` 閳?Phase 1 site list (chatgpt, claude)
- [x] `src/sites/openSite.ts` 閳?generic navigate + readiness-check routine
- [x] `src/sites/chatgptSite.ts` 閳?ChatGPT URL + readiness detector only
- [x] `src/sites/claudeSite.ts` 閳?Claude URL + readiness detector only
- [x] `src/main.ts` 閳?composition root wiring the above together, including the
      interactive login-wait flow (SPEC.md 鎼?a)

### Behavior
- [ ] Launch opens ChatGPT and Claude each in their own page within the same persistent
      context
- [ ] The persistent context uses a dedicated, project-local `userDataDir` (default
      `.browser-profile/`) 閳?never the user's normal daily Chrome profile directory, even
      when `channel: "chrome"` is used (SPEC.md 鎼?)
- [x] Readiness detector classifies each site as one of: `ready`, `login_required`,
      `unknown_state`, `navigation_failed`
- [x] Failure on one site does not prevent the other site's attempt
- [ ] Interactive login-wait flow: if either site is `login_required` after initial
      detection, the browser stays open, a clear console message is printed, the process
      blocks on ENTER, then readiness is re-checked for both sites and the new
      classifications are logged (SPEC.md 鎼?a)
- [ ] Login-wait flow never automates username/password/OTP/SSO/CAPTCHA entry 閳?waits for
      the human only
- [ ] Screenshot is saved on `unknown_state` / `navigation_failed`
- [ ] Timestamped log file written per run under `logs/`
- [ ] Browser/context closes cleanly on normal exit, thrown error, and SIGINT/SIGTERM

### Tests 閳?A. Automated / local (no dependency on real ChatGPT/Claude sites; SPEC.md 鎼?4A)
- [x] `tests/fixtures/` 閳?local static HTML fixtures for `ready`, `login_required`, and
      unknown page states
- [x] `tests/unit/config.spec.ts` (or similar) 閳?config loading/validation, including
      malformed/missing-field error cases
- [x] `tests/unit/logging.spec.ts` 閳?log format, console + file output, file non-empty
      after a logged event
- [x] `tests/unit/siteLoadResult.spec.ts` 閳?readiness detector returns correct
      classification against each local fixture
- [x] `tests/unit/openSite.spec.ts` 閳?one invalid/unreachable "site" + one valid fixture
      "site" 閳?failure isolation proven without touching real sites
- [x] `tests/unit/shutdown.spec.ts` 閳?context closes cleanly on normal run and on a
      simulated mid-run error
- [x] `tests/unit/browserDiscovery.spec.ts` 閳?attach-mode hostname matching (chatgpt.com,
      chat.openai.com, claude.ai) correctly selects existing tabs and ignores unrelated
      hosts
- [x] Automated suite passes locally without network access to chatgpt.com or claude.ai

### Tests 閳?B. Manual / integration (real sites; SPEC.md 鎼?4B; not part of core automated suite)
- [x] `tests/manual/phase1.real-sites.md` checklist written
- [ ] Manual test: fresh dedicated profile 閳?login-wait flow triggers 閳?manual login 閳?      ENTER 閳?both sites classified `ready`
- [x] Manual test: second run with same profile 閳?both sites `ready` **without** the
      login-wait flow triggering and **without** a re-login prompt (persistence proof)
- [ ] Manual test: one site URL broken in config, run against the real other site 閳?other
      site still loads and logs correctly (real-world isolation proof)
- [ ] Manual test: Ctrl+C mid-run 閳?no orphaned browser process, no locked profile dir on
      next run
- [ ] Manual test: confirm resolved `userDataDir` is the dedicated automation profile, not
      the user's daily Chrome profile

### Phase 1 Acceptance Criteria (mirrors SPEC.md 鎼?3 閳?check off only after verifying)
- [ ] Single persistent Chromium context launches from a project-local profile dir
- [x] Session persists across two consecutive runs (no re-login)
- [x] ChatGPT load outcome correctly classified and logged
- [x] Claude load outcome correctly classified and logged, independent of ChatGPT's result
- [x] One site's failure does not block the other site's attempt (same fact as the
      checked Behavior item above; covered by `tests/unit/openSite.spec.ts`)
- [ ] Login-wait flow triggers on `login_required`, waits for ENTER, and re-classifies
      both sites without ever automating credential/OTP/SSO/CAPTCHA entry
- [ ] Dedicated automation profile confirmed distinct from the user's daily Chrome profile
- [ ] Every run produces a timestamped log file under `logs/`
- [ ] Screenshots saved on `unknown_state` / `navigation_failed`
- [ ] Browser always closes cleanly (success, error, and signal paths all verified)
- [ ] No message ever sent to either site; no response content ever read/parsed
- [ ] No OpenAI API or Anthropic API calls anywhere in the codebase
- [ ] `config/config.json` fully controls profile dir, headless flag, timeouts, URLs

---

## Future Phase 2 閳?ChatGPT Adapter

### Phase 2A 閳?Milestone 1: ChatGPT send + wait + latest-response detection
- [x] Add shared DOM utilities and isolated ChatGPT selector fallback groups
- [x] Capture a pre-send `TurnBaseline` and resolve only the new assistant response
- [x] Send prompts through the existing attached ChatGPT page and verify submission
- [x] Detect generation start and bounded generation completion using UI state plus text stability
- [x] Handle composer, submission, timeout, empty-response, login, unknown-state, and disconnect failures
- [x] Add offline fake-chat fixture and adapter/baseline tests; keep all Phase 1 tests passing
- [x] Perform the manual real-ChatGPT Milestone 1 smoke test (not part of automated tests)
### Phase 2A 閳?Milestone 2: Claude send + wait + latest-response detection
- [x] Add Claude-specific selector fallback groups and extend the Claude adapter
- [x] Capture a pre-send Claude `TurnBaseline` and resolve only the new assistant response
- [x] Send prompts through the existing attached Claude page and verify submission
- [x] Detect Claude generation start and bounded completion using visible UI state plus text stability
- [x] Handle Claude login, security verification, unknown state, composer, submission, timeout, empty-response, ambiguity, and disconnect failures
- [x] Add offline fake-Claude fixture and adapter tests; keep all prior tests passing
- [x] Perform the manual real-Claude Milestone 2 smoke test (not part of automated tests)

### Phase 2A - Milestone 3: One automatic ChatGPT to Claude round
- [x] Add a browser-agnostic one-round coordinator using the conversational adapter interface
- [x] Build and send the first Claude review prompt from the original task and new ChatGPT response
- [x] Capture exactly one new completed response from each site and stop after Claude's first review
- [x] Add offline fake-adapter coordinator tests covering order, handoff content, and safe failures
- [x] Add a manual real-site single-round smoke harness
- [x] Perform the manual real ChatGPT to Claude Milestone 3 smoke test (not part of automated tests)

  Verified against the existing attached Claude tab: existing-tab discovery, prompt
  submission, generation-start detection, generation-completion detection, and
  current-turn response extraction all passed. Verified DOM lesson: the assistant
  message container is `[role="article"]:has([data-perf-reply-text])`, response text is
  `[data-perf-reply-text]`, and active generation is indicated by
  `[data-is-streaming="true"]`.


### Phase 2A - Milestone 4A: Fixed multi-round review loop (implementation and real smoke complete)

See `MILESTONE4A_DESIGN.md` for the full design. Planned tasks (do not check off until
implemented and verified):

- [x] Add `src/orchestration/runFixedReviewLoop.ts`: browser-agnostic fixed-round state
      machine (`G0 → C1 → G1 → ... → C(reviewRounds) → G(reviewRounds)`), depending only
      on `ConversationalSiteAdapter`, no Playwright selectors
- [x] Add `src/orchestration/fixedReviewPrompts.ts`: `buildInitialChatGptPrompt`,
      `buildClaudeReviewPrompt`, `buildChatGptRevisionPrompt` (each round restates the
      full task and full current answer/review; no STATUS/convergence line)
- [x] Implement structured failure stages (`round`/`turn`/`site`/`step`) and a
      `FixedReviewLoopError` carrying `partialResult` (completed rounds so far)
- [x] Use the existing adapter-owned baseline/send/wait/extract guarantees; no orchestration DOM/count settling or send retry
- [x] Add `tests/unit/runFixedReviewLoop.spec.ts` covering the 14-case matrix in
      `MILESTONE4A_DESIGN.md` §10 (fixed round counts, prompt content/order, failure
      isolation, partial-result availability, transient-instability tolerance, no
      duplicate-send)
- [x] Add `tests/unit/fixedReviewPrompts.spec.ts` for prompt-builder content
- [x] Add `scripts/smoke-multi-round.ts` + `npm run smoke:multi-round` (reviewRounds = 2
      against the real attached ChatGPT/Claude tabs), including the independent
      turn-count-delta check that guards against a silently duplicated submission
- [ ] Perform the manual real-site Milestone 4A smoke test and record the result in
      `DECISIONS.md`/`REVIEW.md` (not part of the automated suite)
- [x] Explicitly confirmed no changes were made to `chatgptSite.ts`, `claudeSite.ts`, `claudeUserTurns.ts`, `domUtil.ts`, or any selector file

### Phase 2A - Milestone 4B: Convergence-driven review loop (design revised after architect review round 2; implementation not started)

See `MILESTONE4B_DESIGN.md` for the full design, including its "Revision history" section
documenting the round-2 convergence-safety fixes (single-decision-point round lifecycle,
conservative objection matching, severity floor/downgrade rules, strict ledger-id
validation, the JSON structured-review grammar, and corrected maxRounds semantics). Planned
tasks (do not check off until implemented and verified):

- [ ] Add `src/orchestration/convergence/types.ts`: shared convergence/ledger/review types
      (`ReviewSeverity`, `ObjectionLedgerEntry` incl. `highestSeveritySeen`,
      `StructuredClaudeReview`, `ConvergenceOptions` incl. the fingerprint merge/margin/
      shared-token/candidate thresholds, `ConvergenceDecision`, `ConvergenceHistory`,
      `ConvergedReviewResult`, `ConvergenceRoundRecord`)
- [ ] Add `src/orchestration/convergence/fingerprint.ts`: deterministic normalization +
      Dice-coefficient similarity, plus the conservative merge-classification function
      (high absolute score AND a clear margin over the next-best candidate AND a minimum
      shared-token count — see `MILESTONE4B_DESIGN.md` section 6.5); no LLM calls, no
      network access
- [ ] Add `src/orchestration/convergence/structuredReviewParser.ts`: sentinel-wrapped JSON
      parser (`BEGIN_STRUCTURED_REVIEW`/`END_STRUCTURED_REVIEW`) with strict schema
      validation and the full ledger-id cross-validation checklist in
      `MILESTONE4B_DESIGN.md` section 7.2 (unknown id in any bucket, id in contradictory
      buckets, duplicate id within a bucket, non-empty id arrays in round 1); malformed
      input must never parse into anything convergence-shaped, only a valid
      `StructuredClaudeReview` or an explicit `{ invalid: true; reason }`
- [ ] Add `src/orchestration/convergence/objectionLedger.ts`: ledger creation + per-round
      ingest (RESOLVED/STILL_OPEN/REOPENED by id, NEW objections classified via the
      conservative matching policy, unmentioned-OPEN objections default to
      IMPLICITLY_CARRIED_OPEN), plus the severity downgrade-rejection and reopen-floor
      rules in `MILESTONE4B_DESIGN.md` section 6.6
- [ ] Add `src/orchestration/convergence/convergenceEngine.ts`: pure, browser-agnostic
      decision function implementing the single-decision-point round lifecycle and the
      corrected clean-round/stability-window rule (`MILESTONE4B_DESIGN.md` sections 5, 8);
      no Playwright/DOM/site-specific code of any kind
- [ ] Add `src/orchestration/convergence/convergencePrompts.ts`: Claude review prompt
      (round 1 vs round N with open-ledger summary, JSON structured-review contract) and
      ChatGPT revision prompt builders per `MILESTONE4B_DESIGN.md` section 11
- [ ] Add `src/orchestration/runConvergenceReviewLoop.ts`: new orchestration entry point,
      depends only on `ConversationalSiteAdapter`; single per-round decision point
      (CONVERGED / MAX_ROUNDS_REACHED / CONTINUE, in that priority order) right after each
      Claude review, per `MILESTONE4B_DESIGN.md` section 5; does not modify or branch
      inside `runFixedReviewLoop.ts`/`fixedReviewPrompts.ts` or any other Milestone 4A file
- [ ] Add `tests/unit/structuredReviewParser.spec.ts`, `objectionLedger.spec.ts`,
      `convergenceEngine.spec.ts`, `convergencePrompts.spec.ts` covering the full test plan
      in `MILESTONE4B_DESIGN.md` section 15 (original 16-case matrix plus the added
      conservative-matching, severity-rule, ledger-id-validation, and JSON-grammar cases)
- [ ] Add `tests/unit/runConvergenceReviewLoop.spec.ts` (fake in-memory adapters, no
      Playwright) covering full-loop convergence, max-rounds, invalid-review stops, the
      no-duplicate-send invariant on failure, and the four explicit state-machine sequence
      tests in `MILESTONE4B_DESIGN.md` section 15.6 (clean-round-then-converge,
      streak-reset-on-new-MEDIUM, clean-round-that-resolves-the-final-blocker, and
      maxRounds-with-no-unreviewed-trailing-revision)
- [ ] Add a dedicated isolation test (e.g. `tests/unit/convergenceEngineIsolation.spec.ts`)
      proving no file under `src/orchestration/convergence/` imports `playwright` or
      references `Page`
- [ ] Add `scripts/smoke-convergence.ts` + `npm run smoke:convergence` real-site smoke
      script (not part of the automated suite; run manually against the real attached
      ChatGPT/Claude tabs once implemented)
- [ ] Perform the manual real-site Milestone 4B smoke test and record the result in
      `DECISIONS.md`/`REVIEW.md`
- [ ] Explicitly confirm no changes were made to `chatgptSite.ts`, `claudeSite.ts`,
      `claudeUserTurns.ts`, `domUtil.ts`, any selector file, or any Milestone 4A file
      (`runFixedReviewLoop.ts`, `fixedReviewPrompts.ts`, their tests, or
      `scripts/smoke-multi-round.ts`)

- [ ] **GATE / BLOCKER 閳?do not implement automatic ChatGPT response extraction until
      this is satisfied.** OpenAI's current consumer Terms of Use prohibit automatically
      or programmatically extracting data or Output from the ChatGPT consumer web
      interface. Before writing `extractLatestResponse` (or any equivalent scraping of
      ChatGPT's generated output): (1) re-evaluate OpenAI's then-current service terms on
      automated/programmatic Output extraction, and (2) choose and document a compliant
      approach 閳?e.g. an official supported API/integration, a human-in-the-loop relay
      (user manually copies the response in), or another officially sanctioned mechanism.
      See `DECISIONS.md` 鎼?0 for full rationale. This does not block or change any Phase 1
      work, which never extracts output.
- [ ] Extend `chatgptSite.ts` into a full adapter: `sendMessage(page, text)`
- [ ] Implement `extractLatestResponse(page)` for ChatGPT *(blocked by the gate above)*
- [ ] Detect "response generation complete" (streaming-done signal) for ChatGPT
- [ ] Handle ChatGPT-specific transient UI states (e.g. regenerate button, rate limit
      banner) without leaking that knowledge outside `chatgptSite.ts`
- [ ] Adapter-level tests for send + extract against a logged-in session

## Future Phase 3 閳?Claude Adapter

- [ ] Extend `claudeSite.ts` into a full adapter: `sendMessage(page, text)`
- [ ] Implement `extractLatestResponse(page)` for Claude
- [ ] Detect "response generation complete" (streaming-done signal) for Claude
- [ ] Handle Claude-specific transient UI states without leaking outside `claudeSite.ts`
- [ ] Adapter-level tests for send + extract against a logged-in session

## Future Phase 4 閳?Orchestrator

- [ ] `src/orchestrator/` module driving propose 閳?review 閳?revise loop via the shared
      `SiteAdapter` interface only
- [ ] Configurable max rounds (default within 10閳?5 range)
- [ ] Round counting and per-round transcript capture
- [ ] Generous, configurable per-step timeouts (web UI latency is unpredictable)
- [ ] Graceful handling when an adapter reports `unknown_state` mid-orchestration

## Future Phase 5 閳?State / Convergence

- [ ] `src/state/` module: OPEN vs RESOLVED issue tracking, separate from orchestrator
      control flow
- [ ] Convergence detection heuristic(s)
- [ ] Serializable session state (round number, issues, last responses) to disk
- [ ] Pause: stop mid-session and persist state
- [ ] Resume: reload persisted state and continue from the correct round
- [ ] Manual intervention: allow a human to edit/inject content between rounds

## Future Phase 6 閳?User Interface and Robustness

- [ ] Structured, queryable logs (beyond Phase 1's plain log file) covering rounds/issues
- [ ] Recovery from browser/UI failures mid-session (e.g. site reload, re-detect
      readiness, resume orchestration)
- [ ] Multiple review/debate modes (strict review, brainstorm, adversarial, etc.)
- [ ] Modular support for additional AI web interfaces (adapter interface already
      designed for this in Phase 1 閳?implement additional `*Site.ts` adapters)
- [ ] Consider a minimal local UI (only if justified 閳?avoid overengineering per project
      guidance)

---

## Blocked / Issues

- Phase 1: none currently 閳?implementation has not started.
- **Future Phase 2 (standing gate, not blocking Phase 1):** automatic ChatGPT response
  extraction cannot be implemented until OpenAI's current consumer Terms of Use around
  automated/programmatic Output extraction are re-evaluated and a compliant approach is
  chosen and documented. See the GATE item under "Future Phase 2 閳?ChatGPT Adapter" above
  and `DECISIONS.md` 鎼?0.


### Manual Chrome attach mode (Phase 1)
- [x] Support configurable `browserMode` launch/attach and local CDP endpoint
- [x] Attach to existing dedicated Chrome with Playwright CDP without creating or navigating tabs
- [x] Preserve browser ownership: only launch mode closes the browser
- [x] Add dedicated Chrome startup script using `.browser-profile`
- [x] Manual attach-mode real-site test personally verified






Real-browser verification also covered explicit ChatGPT/Claude identities in prompts, the 30,000 ms generation-start timeout and 180,000 ms generation timeout defaults, no automatic resend after timeout, ProseMirror logical multiline verification, Claude stable message:N identity, Claude DOM virtualization handling, tolerance for transient assistant shells without ordinals during generation, no production DOM-index fallback for Claude identity, and set-based smoke-turn verification rather than raw DOM counts.

Known limitation: independent runs still require manually opening fresh ChatGPT and Claude chats.