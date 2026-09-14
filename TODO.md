# TODO.md — dual-ai-review

This file is the persistent source of truth for project progress. It must always reflect
the actual, verified state of the repository — not intentions, not "should be working."

**Rules for every future agent (human or AI) editing this file:**

1. A task moves from `[ ]` to `[x]` only after it is both implemented **and** verified
   (see each phase's acceptance criteria / test plan in `SPEC.md`).
2. Never delete a completed (`[x]`) task in a future session. If it's superseded, add a
   note rather than removing history.
3. If something is discovered broken or incomplete, uncheck it (with a note in "Blocked /
   Issues") rather than leaving a stale checkmark.
4. If new required work is discovered, add it under the relevant phase (or to "Blocked /
   Issues" if it's a cross-cutting problem) — don't just fix it silently.
5. Read `SPEC.md` and `DECISIONS.md` before changing any code, not just this file.

---

## Current Phase

**Phase 1 — Browser Foundation** (design complete; implementation not started)

---

## Phase 1 — Browser Foundation

### Setup
- [ ] Initialize `package.json` (Node + TypeScript project)
- [ ] Add Playwright as a dependency and run its browser install step
- [ ] Add `tsconfig.json`
- [ ] Add `.gitignore` covering `.browser-profile/`, `logs/`, `node_modules/`,
      `test-results/`, `playwright-report/`
- [ ] Create `config/config.json` with the Phase 1 schema from `SPEC.md` §11

### Core modules
- [ ] `src/logging/logger.ts` — console + file logger
- [ ] `src/config/loadConfig.ts` — load + validate `config/config.json`
- [ ] `src/browser/launchBrowser.ts` — persistent context launch (profile dir, headed,
      timeouts)
- [ ] `src/browser/shutdown.ts` — clean close on success / error / SIGINT / SIGTERM
- [ ] `src/sites/siteTypes.ts` — `SiteAdapter` / `SiteLoadResult` shared types
- [ ] `src/sites/siteRegistry.ts` — Phase 1 site list (chatgpt, claude)
- [ ] `src/sites/openSite.ts` — generic navigate + readiness-check routine
- [ ] `src/sites/chatgptSite.ts` — ChatGPT URL + readiness detector only
- [ ] `src/sites/claudeSite.ts` — Claude URL + readiness detector only
- [ ] `src/main.ts` — composition root wiring the above together, including the
      interactive login-wait flow (SPEC.md §8a)

### Behavior
- [ ] Launch opens ChatGPT and Claude each in their own page within the same persistent
      context
- [ ] The persistent context uses a dedicated, project-local `userDataDir` (default
      `.browser-profile/`) — never the user's normal daily Chrome profile directory, even
      when `channel: "chrome"` is used (SPEC.md §8)
- [ ] Readiness detector classifies each site as one of: `ready`, `login_required`,
      `unknown_state`, `navigation_failed`
- [ ] Failure on one site does not prevent the other site's attempt
- [ ] Interactive login-wait flow: if either site is `login_required` after initial
      detection, the browser stays open, a clear console message is printed, the process
      blocks on ENTER, then readiness is re-checked for both sites and the new
      classifications are logged (SPEC.md §8a)
- [ ] Login-wait flow never automates username/password/OTP/SSO/CAPTCHA entry — waits for
      the human only
- [ ] Screenshot is saved on `unknown_state` / `navigation_failed`
- [ ] Timestamped log file written per run under `logs/`
- [ ] Browser/context closes cleanly on normal exit, thrown error, and SIGINT/SIGTERM

### Tests — A. Automated / local (no dependency on real ChatGPT/Claude sites; SPEC.md §14A)
- [ ] `tests/fixtures/` — local static HTML fixtures for `ready`, `login_required`, and
      unknown page states
- [ ] `tests/unit/config.spec.ts` (or similar) — config loading/validation, including
      malformed/missing-field error cases
- [ ] `tests/unit/logging.spec.ts` — log format, console + file output, file non-empty
      after a logged event
- [ ] `tests/unit/siteLoadResult.spec.ts` — readiness detector returns correct
      classification against each local fixture
- [ ] `tests/unit/openSite.spec.ts` — one invalid/unreachable "site" + one valid fixture
      "site" → failure isolation proven without touching real sites
- [ ] `tests/unit/shutdown.spec.ts` — context closes cleanly on normal run and on a
      simulated mid-run error
- [ ] Automated suite passes locally without network access to chatgpt.com or claude.ai

### Tests — B. Manual / integration (real sites; SPEC.md §14B; not part of core automated suite)
- [ ] `tests/manual/phase1.real-sites.md` checklist written
- [ ] Manual test: fresh dedicated profile → login-wait flow triggers → manual login →
      ENTER → both sites classified `ready`
- [ ] Manual test: second run with same profile → both sites `ready` **without** the
      login-wait flow triggering and **without** a re-login prompt (persistence proof)
- [ ] Manual test: one site URL broken in config, run against the real other site → other
      site still loads and logs correctly (real-world isolation proof)
- [ ] Manual test: Ctrl+C mid-run → no orphaned browser process, no locked profile dir on
      next run
- [ ] Manual test: confirm resolved `userDataDir` is the dedicated automation profile, not
      the user's daily Chrome profile

### Phase 1 Acceptance Criteria (mirrors SPEC.md §13 — check off only after verifying)
- [ ] Single persistent Chromium context launches from a project-local profile dir
- [ ] Session persists across two consecutive runs (no re-login)
- [ ] ChatGPT load outcome correctly classified and logged
- [ ] Claude load outcome correctly classified and logged, independent of ChatGPT's result
- [ ] One site's failure does not block the other site's attempt
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

## Future Phase 2 — ChatGPT Adapter

- [ ] **GATE / BLOCKER — do not implement automatic ChatGPT response extraction until
      this is satisfied.** OpenAI's current consumer Terms of Use prohibit automatically
      or programmatically extracting data or Output from the ChatGPT consumer web
      interface. Before writing `extractLatestResponse` (or any equivalent scraping of
      ChatGPT's generated output): (1) re-evaluate OpenAI's then-current service terms on
      automated/programmatic Output extraction, and (2) choose and document a compliant
      approach — e.g. an official supported API/integration, a human-in-the-loop relay
      (user manually copies the response in), or another officially sanctioned mechanism.
      See `DECISIONS.md` §10 for full rationale. This does not block or change any Phase 1
      work, which never extracts output.
- [ ] Extend `chatgptSite.ts` into a full adapter: `sendMessage(page, text)`
- [ ] Implement `extractLatestResponse(page)` for ChatGPT *(blocked by the gate above)*
- [ ] Detect "response generation complete" (streaming-done signal) for ChatGPT
- [ ] Handle ChatGPT-specific transient UI states (e.g. regenerate button, rate limit
      banner) without leaking that knowledge outside `chatgptSite.ts`
- [ ] Adapter-level tests for send + extract against a logged-in session

## Future Phase 3 — Claude Adapter

- [ ] Extend `claudeSite.ts` into a full adapter: `sendMessage(page, text)`
- [ ] Implement `extractLatestResponse(page)` for Claude
- [ ] Detect "response generation complete" (streaming-done signal) for Claude
- [ ] Handle Claude-specific transient UI states without leaking outside `claudeSite.ts`
- [ ] Adapter-level tests for send + extract against a logged-in session

## Future Phase 4 — Orchestrator

- [ ] `src/orchestrator/` module driving propose → review → revise loop via the shared
      `SiteAdapter` interface only
- [ ] Configurable max rounds (default within 10–15 range)
- [ ] Round counting and per-round transcript capture
- [ ] Generous, configurable per-step timeouts (web UI latency is unpredictable)
- [ ] Graceful handling when an adapter reports `unknown_state` mid-orchestration

## Future Phase 5 — State / Convergence

- [ ] `src/state/` module: OPEN vs RESOLVED issue tracking, separate from orchestrator
      control flow
- [ ] Convergence detection heuristic(s)
- [ ] Serializable session state (round number, issues, last responses) to disk
- [ ] Pause: stop mid-session and persist state
- [ ] Resume: reload persisted state and continue from the correct round
- [ ] Manual intervention: allow a human to edit/inject content between rounds

## Future Phase 6 — User Interface and Robustness

- [ ] Structured, queryable logs (beyond Phase 1's plain log file) covering rounds/issues
- [ ] Recovery from browser/UI failures mid-session (e.g. site reload, re-detect
      readiness, resume orchestration)
- [ ] Multiple review/debate modes (strict review, brainstorm, adversarial, etc.)
- [ ] Modular support for additional AI web interfaces (adapter interface already
      designed for this in Phase 1 — implement additional `*Site.ts` adapters)
- [ ] Consider a minimal local UI (only if justified — avoid overengineering per project
      guidance)

---

## Blocked / Issues

- Phase 1: none currently — implementation has not started.
- **Future Phase 2 (standing gate, not blocking Phase 1):** automatic ChatGPT response
  extraction cannot be implemented until OpenAI's current consumer Terms of Use around
  automated/programmatic Output extraction are re-evaluated and a compliant approach is
  chosen and documented. See the GATE item under "Future Phase 2 — ChatGPT Adapter" above
  and `DECISIONS.md` §10.
