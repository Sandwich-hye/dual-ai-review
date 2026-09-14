# SPEC.md — dual-ai-review

## 1. Project Objective

Build a local, browser-based orchestration system that drives the normal, visible web
interfaces of ChatGPT and Claude (the consumer chat websites, not their APIs) so the two
models can iteratively review and improve each other's answers to a task supplied by the
user.

## 2. Overall Long-Term Goal

```
User task
  → ChatGPT proposes a solution
  → Claude reviews the solution
  → ChatGPT revises it
  → Claude reviews again
  → ... repeat ...
  → stop when the models converge or the maximum number of rounds is reached
```

Longer-term the system should support:

- Configurable maximum rounds (typically up to 10–15)
- A ChatGPT "proposer" role and a Claude "reviewer" role
- Tracking of OPEN vs RESOLVED issues raised during review
- Convergence detection (deciding when further rounds add no value)
- Pause / resume of an in-progress review session
- Manual human intervention at any round
- Structured logs of the whole conversation/orchestration
- Multiple review/debate modes (e.g. strict review, brainstorm, adversarial)
- A modular adapter layer so additional AI web interfaces (Gemini, Grok, etc.) can be
  added later without touching orchestration logic

## 3. Phase 1 Scope

Phase 1 builds only the **browser foundation** that every later phase depends on:

- Launch a persistent Chromium browser using Playwright with a dedicated, reusable user
  data directory (profile), so logins survive process restarts.
- Open ChatGPT (chat.openai.com / chatgpt.com) in one page/tab.
- Open Claude (claude.ai) in another page/tab.
- Detect, per site, whether the page loaded into a recognizable, ready state (e.g. chat
  input visible) versus a login/error/blocked state, using only observable DOM/network
  signals — no private APIs.
- Emit clear, structured logs of what happened (launch, navigation, detection result,
  errors) to console and to a log file.
- Provide a minimal, typed configuration surface (profile path, URLs, timeouts) via a
  config file, with no orchestration behavior yet.
- Clean shutdown of the browser/context on exit and on failure.
- Provide a simple interactive first-run login flow: if either site is classified
  `login_required`, keep the browser open, prompt the user in the console to log in
  manually, wait for an ENTER keypress, then re-run readiness detection (see §8a).

## 4. Explicit Phase 1 Non-Goals

Phase 1 must **not**:

- Send any message/prompt into ChatGPT or Claude.
- Read, scrape, or parse any AI-generated response text.
- Transfer any content between ChatGPT and Claude.
- Implement any orchestration, round-tracking, or role logic.
- Implement convergence detection, OPEN/RESOLVED issue tracking, or pause/resume.
- Call the OpenAI API or the Anthropic API.
- Depend on any undocumented/private backend endpoint of either service.
- Build a UI beyond CLI console output.
- Automate any part of the login process itself (usernames, passwords, OTPs, SSO,
  CAPTCHA) — the interactive login flow in §8a only waits for the user to finish logging
  in by hand; it never fills in or submits credentials.

## 5. Proposed Technology Stack

| Concern            | Choice                                   | Notes |
|---------------------|-------------------------------------------|-------|
| Language/runtime    | Node.js (LTS) + TypeScript                 | Playwright's most mature, best-typed API is Node; TS gives adapters a typed contract early, which matters once ChatGPT/Claude adapters diverge in behavior. |
| Browser automation  | Playwright (`playwright` npm package)      | See DECISIONS.md for why. Uses Playwright's own bundled Chromium by default, with an option to launch the installed Chrome executable via `channel: "chrome"` — but always against the project's own dedicated `userDataDir` (§8), never the user's normal daily Chrome profile. |
| Config              | Single `config.json` (or `.jsonc`) file, no env-var framework | Keep it inspectable and diffable; no dotenv/config libraries needed for this scale. |
| Logging             | Minimal custom logger (timestamped console + append-only file), no logging framework | Avoid pulling in winston/pino for what is currently a handful of log lines. Revisit only if log volume/structure demands it. |
| Package manager     | npm (ships with Node, no extra tooling)    | Keeps setup to `npm install`. |
| Testing (Phase 1)   | Playwright's own test runner (`@playwright/test`) for browser-dependent unit tests against local fixtures; plain Node assertions where no `Page` is needed | Already a transitive dependency family; avoids adding Jest/Vitest. Real ChatGPT/Claude sites are deliberately excluded from this automated suite — see §14. |
| Process model       | Single long-lived Node process per run     | No daemon, no IPC, no server — matches "avoid overengineering." |

No web framework, no database, no message queue in Phase 1 (or arguably ever, given the
scale of this tool). These may be reconsidered only if a future phase (e.g. a UI in Phase
6) demonstrably needs them — see DECISIONS.md.

## 6. Proposed Folder Structure

```
dual-ai-review/
├── SPEC.md
├── TODO.md
├── DECISIONS.md
├── package.json
├── tsconfig.json
├── config/
│   └── config.json            # user-editable runtime config (URLs, timeouts, profile path)
├── src/
│   ├── main.ts                 # Phase 1 entry point: launch browser, open both sites, detect, prompt login if needed, re-detect, log, exit
│   ├── config/
│   │   └── loadConfig.ts       # reads + validates config.json
│   ├── browser/
│   │   ├── launchBrowser.ts    # creates persistent context (profile dir), returns BrowserContext
│   │   └── shutdown.ts         # graceful close on success/error/signal
│   ├── sites/
│   │   ├── siteRegistry.ts     # declarative list of sites to open (Phase 1: chatgpt, claude)
│   │   ├── siteTypes.ts        # shared TS types: SiteDefinition, SiteLoadResult, etc.
│   │   ├── openSite.ts         # navigate a page to a site URL + run its readiness check
│   │   ├── chatgptSite.ts      # ChatGPT-specific: URL + "is this page ready?" detector only
│   │   └── claudeSite.ts       # Claude-specific: URL + "is this page ready?" detector only
│   ├── logging/
│   │   └── logger.ts           # timestamped console + file logger
│   └── types/
│       └── index.ts            # cross-cutting shared types
├── logs/                        # gitignored; run logs written here
├── .browser-profile/            # gitignored; DEDICATED persistent Playwright user data dir (never the user's daily Chrome profile)
└── tests/
    ├── fixtures/                 # local/static HTML fixtures standing in for ready / login_required / unknown page states
    ├── unit/                     # automated/local tests: config, logging, classification, openSite isolation (no real ChatGPT/Claude dependency)
    └── manual/
        └── phase1.real-sites.md  # manual/integration test checklist run against the real ChatGPT and Claude sites
```

This structure intentionally keeps `sites/chatgptSite.ts` and `sites/claudeSite.ts` as the
**only** files that know anything about ChatGPT's or Claude's DOM. Everything else
(`browser/`, `main.ts`) is site-agnostic, which is what lets Phase 2/3 grow these files
into full adapters (send message, extract response) without restructuring the project.

## 7. Responsibility of Each Future File/Module

- **`src/main.ts`** — Composition root. Loads config, launches the browser, opens each
  configured site, runs readiness detection, and — if any site is `login_required` —
  drives the interactive login-wait flow (§8a) before re-detecting and logging final
  outcomes, then exits (or waits, per config) — no business logic beyond this
  sequencing.
- **`src/config/loadConfig.ts`** — Reads `config/config.json`, validates required fields
  (profile dir, site URLs, timeouts), fails fast with a clear error if malformed.
- **`src/browser/launchBrowser.ts`** — Owns Playwright's `launchPersistentContext` call:
  profile directory, headless/headed flag, viewport, channel selection (bundled Chromium
  vs installed Chrome). Returns a ready `BrowserContext`.
- **`src/browser/shutdown.ts`** — Ensures the context/browser is closed on normal exit,
  unhandled error, or process signal (SIGINT/SIGTERM), so the profile lock file is never
  left dangling.
- **`src/sites/siteRegistry.ts`** — The single place listing which sites Phase 1 opens.
  Adding a future site (e.g. Gemini) in Phase 2+ means adding one entry here plus one
  `*Site.ts` file — nothing else changes.
- **`src/sites/siteTypes.ts`** — Defines the `SiteAdapter`-shaped contract each site module
  must satisfy (`url`, `name`, `checkReady(page): Promise<SiteLoadResult>`). Phase 2/3 will
  extend this same interface with `sendMessage`/`extractResponse`, not replace it.
- **`src/sites/openSite.ts`** — Generic "navigate this page to this site and run its
  readiness check" routine, parameterized by a `SiteAdapter`. Contains no site-specific
  knowledge.
- **`src/sites/chatgptSite.ts` / `claudeSite.ts`** — Phase 1: URL + a readiness detector
  (e.g. "chat input textbox is visible" vs "login form is visible" vs "error/blocked
  page"). Phase 2/3 will extend these into full adapters (send prompt, read reply) — this
  is the designated extension point, see §15.
- **`src/logging/logger.ts`** — `info/warn/error` functions that timestamp, write to
  console, and append to a run-scoped file under `logs/`.
- **`tests/fixtures/`** — Local, static HTML files representing a "ready" page, a
  "login required" page, and an unrecognized/unknown page, used to test the readiness
  detector without depending on real ChatGPT/Claude sites.
- **`tests/unit/`** — Automated tests covering config loading/validation, logging,
  `SiteLoadResult` classification (against `tests/fixtures/`), and `openSite` failure
  isolation — the primary, CI-runnable Phase 1 test suite (see §14A).
- **`tests/manual/phase1.real-sites.md`** — A manual/integration checklist run by a human
  against the real ChatGPT and Claude sites, covering first login, session persistence
  across restarts, and real-world failure isolation (see §14B). Not part of the automated
  suite.

## 8. Browser Profile / Session Persistence Strategy

- Use Playwright's `chromium.launchPersistentContext(userDataDir, options)` rather than
  `launch()` + `newContext()`, so cookies, localStorage, and IndexedDB (where ChatGPT/
  Claude session tokens live) persist on disk between runs.
- `userDataDir` **must** be a dedicated, project-local folder (default
  `.browser-profile/`), configurable via `config.json` only to relocate that dedicated
  folder (e.g. onto a different drive) — **never** to point at the user's normal daily
  Chrome profile directory (e.g. `...\Google\Chrome\User Data\Default`) or any profile
  used for everyday browsing.
- `channel: "chrome"` (launching the user's installed Chrome executable instead of
  Playwright's bundled Chromium) is permitted, but only when still combined with the
  project's own dedicated `userDataDir` — the executable may be the user's real Chrome,
  the profile directory may not.
- The user logs into ChatGPT and Claude manually, once, **inside this dedicated
  automation profile** — this is a separate, isolated login from the user's normal
  browser session and does not touch or read from it.
- The folder is **gitignored** — it contains real session credentials and must never be
  committed.
- Run headed (visible browser window) by default in Phase 1, since the user must log in
  manually the first time; headless mode is a config flag for later, once login state is
  proven durable.
- Only one process may hold a given `userDataDir` at a time (Chromium enforces this via a
  profile lock); Phase 1's job is to fail with a clear log message if the profile is
  already locked, not to work around it. Using a dedicated profile also means this lock
  can never conflict with the user's everyday Chrome window(s) being open at the same
  time.

## 8a. Interactive First-Run Login Flow

Because the dedicated automation profile (§8) starts out logged out, Phase 1 includes a
minimal, manual-only login flow so the user has enough time to log in before the process
exits:

1. Launch the browser and open both sites; run readiness detection on each, as normal.
2. If **either** site is classified `login_required`:
   - Keep the browser window open (do not close the context).
   - Print a clear console message identifying which site(s) need login and asking the
     user to complete login manually in the open browser window, e.g.:
     `"Please log into ChatGPT / Claude manually in the opened browser window, then
     press ENTER here to continue..."`
   - Block and wait for the user to press ENTER (a single blocking read from stdin) —
     no timeout, no polling, no automated retry loop.
   - Re-run readiness detection for **both** sites (not just the one that was
     `login_required`), since the user may have been prompted to act on either.
   - Log the new classification for each site.
3. If neither site is `login_required` after the initial detection, this flow is skipped
   entirely and the run proceeds straight to final logging.
4. This flow runs **at most once per process run** — Phase 1 does not loop the
   prompt-and-recheck cycle multiple times. If a site is still `login_required` (or
   becomes `unknown_state`) after the single re-check, that is logged as the final
   result for the run; the user can simply run the tool again.

This flow performs no automation of the login process itself: it never reads, fills, or
submits usernames, passwords, one-time codes, SSO redirects, or CAPTCHA challenges — it
only waits for a human to do so, then re-observes the resulting page state.

## 9. Error Handling Strategy

- Fail loud, fail clearly: any failure to launch the browser, load config, or navigate is
  logged with context (which site, which URL, underlying error) and causes a non-zero
  exit — Phase 1 does not retry or self-heal.
- Per-site failures are isolated: if ChatGPT fails to load, Claude is still attempted, and
  the run's final summary reports per-site status independently rather than aborting the
  whole run on first failure.
- "Not ready" is a **detected state**, not an exception: login pages, CAPTCHA/challenge
  pages, and outright errors should be classified and logged as distinct
  `SiteLoadResult` statuses (e.g. `ready`, `login_required`, `unknown_state`,
  `navigation_failed`) rather than only a boolean or a thrown error — this classification
  is what later phases will build recovery logic on top of.
- No silent fallbacks: if the readiness detector can't confidently classify the page, it
  reports `unknown_state` (with a screenshot saved for diagnosis) rather than guessing.

## 10. Logging Strategy

- Every run writes to both stdout (human-readable, for interactive use) and an append-only
  file `logs/run-<ISO-timestamp>.log` (for later inspection/debugging).
- Log format: `[ISO timestamp] [LEVEL] [component] message` — no logging framework
  dependency needed at this size.
- Minimum events logged in Phase 1: process start/config loaded, browser launch
  start/success/failure, per-site navigation start/result, per-site readiness
  classification, and process shutdown (clean or on error).
- On an `unknown_state` or `navigation_failed` classification, save a screenshot next to
  the log file (`logs/<timestamp>-<site>.png`) to aid debugging without requiring the user
  to reproduce interactively.

## 11. Configuration Strategy

- Single `config/config.json`, loaded once at startup, no env-var layering and no CLI-flag
  parsing library in Phase 1 (keeps the surface small; can be added later if genuinely
  needed).
- Fields for Phase 1:
  ```json
  {
    "browserProfileDir": ".browser-profile",
    "headless": false,
    "navigationTimeoutMs": 30000,
    "sites": {
      "chatgpt": { "url": "https://chatgpt.com/" },
      "claude": { "url": "https://claude.ai/new" }
    }
  }
  ```
- `loadConfig.ts` validates the file at startup and throws a descriptive error (caught by
  `main.ts`, logged, process exits non-zero) rather than proceeding with partial/undefined
  config.
- No secrets live in config — see §12.

## 12. Security and Privacy Considerations

- The project code does not capture or persist passwords, OTPs, or login credentials. The
  user logs into ChatGPT and Claude manually, once, in the automated browser window;
  Playwright never sees or touches passwords/OTPs. The dedicated browser profile (§8)
  does store browser-managed authenticated session data — cookies, localStorage,
  IndexedDB — which is what makes login persistence possible; this data is managed by the
  browser itself, not read, copied, or handled by this project's own code.
- The automation profile (§8) is fully isolated from the user's normal daily browsing
  profile — automation never reads from or writes to the user's everyday Chrome data, and
  a compromise or bug in this project's code cannot affect the user's normal browser
  session.
- The persistent profile directory (`.browser-profile/`) and `logs/` (which may contain
  screenshots of a logged-in UI) are gitignored and must never be committed or shared —
  documented explicitly in `DECISIONS.md` and `.gitignore`.
- No network calls are made by this project other than Playwright driving the browser to
  the two normal site URLs — no telemetry, no third-party services.
- Because this automates real user accounts against production consumer web UIs (not a
  public/documented API), the user is bound by ChatGPT's and Claude's respective terms of
  service for automated/scripted use of the consumer product; this is a personal-use,
  local-only tool and should not be operated at scale or in a way that mimics abuse
  patterns (e.g. high frequency, many parallel sessions).
- Logs must avoid capturing message content once later phases add message sending — noted
  here so it isn't forgotten when Phase 2+ design logging for prompts/responses.

## 13. Phase 1 Acceptance Criteria

Phase 1 is complete when all of the following are true and verified (see TODO.md for the
checklist that tracks this):

- [ ] Running the entry point launches a single persistent Chromium context using a
      project-local profile directory.
- [ ] A second run of the entry point reuses the previously-logged-in session for both
      ChatGPT and Claude (no re-login prompt), proving persistence works.
- [ ] ChatGPT opens in its own page and the run correctly logs one of: ready,
      login_required, unknown_state, or navigation_failed.
- [ ] Claude opens in its own page and the run correctly logs one of the same states,
      independently of ChatGPT's outcome.
- [ ] If one site fails to load, the other site's attempt still proceeds and is logged.
- [ ] If either site is initially classified `login_required`, the browser stays open, a
      clear console prompt is shown, the process waits for ENTER, then re-runs readiness
      detection for both sites and logs the updated result.
- [ ] The login-wait flow never automates entry of usernames, passwords, OTPs, SSO, or
      CAPTCHA — it only waits for the user and re-checks page state.
- [ ] The dedicated automation profile directory is never the user's normal daily Chrome
      profile — verified by inspecting the configured `userDataDir`.
- [ ] All runs produce a timestamped log file under `logs/` in addition to console output.
- [ ] On `unknown_state`/`navigation_failed`, a screenshot is saved alongside the log.
- [ ] The browser/context is always closed cleanly on success, on error, and on
      SIGINT/SIGTERM.
- [ ] No message is ever sent to either site; no response content is ever read/parsed.
- [ ] No calls to the OpenAI API or Anthropic API exist anywhere in the codebase.
- [ ] `config/config.json` fully controls profile dir, headless flag, timeouts, and site
      URLs without code changes.

## 14. Phase 1 Test Plan

Phase 1's automated test suite must not depend on the live ChatGPT/Claude production
websites — external site availability and UI changes must not make the core test suite
flaky. Testing is split into (A) automated/local tests, which are the primary,
CI-runnable suite, and (B) a manual real-site integration test, which is the only place
actual ChatGPT/Claude sites are touched.

### A. Automated / local tests (no dependency on real ChatGPT/Claude sites)

Run via a standard local test runner (e.g. `@playwright/test` for anything needing a
`Page`, plain Node-based unit tests otherwise) against local/static/mock fixtures only:

1. **Config loading and validation** — valid config loads correctly; missing/malformed
   required fields (profile dir, site URLs, timeouts) throw a clear, descriptive error.
2. **Logging** — log lines are written in the documented format to both console and the
   run's log file; a log file is created per run and is non-empty after at least one
   logged event.
3. **`SiteLoadResult` classification** — given local/static HTML fixtures standing in for
   "ready" (chat input present), "login required" (login form present), and
   "unknown/unrecognized" page shapes, the readiness detector returns the correct
   classification for each fixture. These fixtures are simple local HTML files loaded via
   `page.setContent()` or `page.goto('file://...')` — not the real sites — so they remain
   stable regardless of upstream UI changes.
4. **`openSite` failure isolation** — given a deliberately invalid/unreachable URL for one
   "site" and a valid local fixture URL for another, confirm the failing site is
   classified `navigation_failed` (or similar) while the other site still completes and is
   classified independently — proving one site's failure doesn't block or crash the other.
5. **Context shutdown** — the browser/context closes without throwing on a normal run,
   and cleanup runs correctly when a simulated error is thrown mid-run.

Where practical, the readiness detector's *logic* (matching a set of DOM signals to a
`SiteLoadResult`) should be testable against local/mock HTML independent of any real
network call, so this suite can run offline and in CI without flaking on real-site
availability or unrelated UI changes.

### B. Manual real-site integration test (marked manual/integration; not part of the
core automated suite)

Required at least once per meaningful change to site detection or profile handling, since
real login and real site behavior can't be meaningfully faked:

1. Delete/rename the dedicated `.browser-profile/` directory, run the tool, confirm the
   login-wait flow (§8a) triggers, log into ChatGPT and Claude by hand in the opened
   windows, press ENTER, and confirm both are classified `ready` in the logs.
2. Close the tool, run it again without touching the profile, confirm both sites are
   classified `ready` **without** the login-wait flow triggering and **without** being
   prompted to log in again — this is the key session-persistence proof.
3. Temporarily rename/break one site's URL in config, run against the real other site, and
   confirm the other site still loads and is logged correctly (real-world isolation
   proof).
4. Kill the process mid-launch (Ctrl+C) and confirm no orphaned browser process and no
   locked profile directory remains for the next run.
5. Confirm the configured `userDataDir` is the dedicated automation profile and not the
   user's normal daily Chrome profile (inspect the resolved path in logs/config).

This manual/integration test is explicitly allowed to be skipped in routine CI runs; it
is a release-gate/verification step for a human (or an agent under human supervision) to
run before checking off the corresponding Phase 1 acceptance criteria in `TODO.md`, not a
required part of the automated test suite.

## 15. Future Extension Points

- **ChatGPT adapter** (`src/sites/chatgptSite.ts`, Phase 2): extend the existing
  `SiteAdapter` implementation with `sendMessage(page, text)` and
  `extractLatestResponse(page)`, plus streaming-completion detection (knowing when
  ChatGPT has finished generating). The readiness detector built in Phase 1 becomes the
  precondition check before sending.
  **Gated** — see the Phase 2 compliance gate in §16 and `DECISIONS.md`: automatic
  extraction of ChatGPT output must not be implemented until current OpenAI consumer
  Terms of Use are re-evaluated and a compliant approach is chosen.
- **Claude adapter** (`src/sites/claudeSite.ts`, Phase 3): same shape as the ChatGPT
  adapter, implemented against Claude's DOM — kept in its own file so ChatGPT-specific
  quirks (e.g. different streaming/completion signals) never leak into shared code.
- **Orchestrator** (new `src/orchestrator/` module, Phase 4): consumes both adapters
  through the shared `SiteAdapter` interface only — it should never import
  `chatgptSite.ts`/`claudeSite.ts` directly if that can be avoided, so a third adapter can
  be dropped in later without touching orchestration logic. Owns the propose→review→
  revise loop and round counting.
- **State machine / convergence detection** (new `src/state/` module, Phase 5): tracks
  round number, OPEN/RESOLVED issues, and convergence signals as data, separate from the
  orchestrator's control flow, so convergence heuristics can be swapped/tuned without
  touching adapters or the orchestrator loop itself.
- **Pause/resume**: depends on the state machine module being able to serialize its
  current state (round number, issue list, last responses) to disk and reload it —
  designed for in Phase 5, not Phase 1.

## 16. Risks and Limitations

- **UI churn**: ChatGPT and Claude can change their DOM/selectors at any time, breaking
  readiness detection (Phase 1) and later message/response handling (Phase 2/3+). Mitigate
  by keeping all site-specific selectors isolated to `chatgptSite.ts`/`claudeSite.ts` and
  favoring resilient selectors (roles/labels/text) over brittle CSS classes.
- **Anti-automation measures**: either site could introduce bot detection, CAPTCHAs, or
  rate limiting aimed at automated browsers. Phase 1's `unknown_state`/screenshot logging
  exists specifically so this is diagnosable rather than silently failing; no
  evasion/fingerprint-spoofing techniques are in scope for this project.
- **ToS risk**: automating a consumer web UI (as opposed to a documented API) may run
  against a site's terms of service for the account owner; this is a known, accepted
  tradeoff of the project's "no paid API" constraint and should stay personal-use/local
  only.
- **Single point of failure per profile**: because Chromium locks the profile directory,
  only one instance of this tool can run against a given profile at a time — acceptable
  for a local single-user tool, documented so it isn't mistaken for a bug.
- **No response-time guarantees**: web UIs can be slower or less predictable than an API;
  later phases (orchestrator) will need generous, configurable timeouts — noted here so
  Phase 4 design accounts for it from the start.
- **Consumer Terms of Use limit on automatic output extraction (Phase 2 gate)**: OpenAI's
  current consumer Terms of Use prohibit automatically or programmatically extracting
  data or Output from the ChatGPT consumer web interface. Phase 1 does not extract any
  model response and is unaffected by this. However, Future Phase 2 as currently
  described proposes automatic extraction of ChatGPT output (`extractLatestResponse`),
  which would conflict with those terms as they exist today. **Before implementing
  automatic ChatGPT response extraction, the project must re-evaluate the then-current
  OpenAI service terms and select a compliant approach** — see `DECISIONS.md` for the
  full rationale and possible alternatives (an official supported API/integration, a
  human-in-the-loop relay where the user manually copies text, or another officially
  sanctioned mechanism). This is recorded as a standing gate on Future Phase 2 in
  `TODO.md`, not a blocker on Phase 1.
