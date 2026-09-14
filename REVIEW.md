# Phase 1 Final Review

Reviewer: independent final-review pass (Claude), 2026-09-15. Read SPEC.md, TODO.md,
DECISIONS.md in full, inspected every file listed in the review request, independently
re-ran `npm run build` (passes, no errors) and `npm test` (18 passed, 0 failed — matches
the user's reported result), and grepped the full `src/` tree for message-sending,
response-extraction, private-API, and stealth/evasion code (none found).

## Verdict

**PASS WITH NON-BLOCKING ISSUES**

Phase 1 is functionally complete, architecturally sound, and safe with respect to browser
ownership, hostname matching, and scope (no Phase 2 behavior present). No BLOCKING issues
were found. A handful of NON-BLOCKING, DOCUMENTATION, and TEST GAP items should be tracked
but do not need to be fixed before accepting/freezing Phase 1.

---

## Blocking Issues

None found.

---

## Non-Blocking Issues

### 1. Attach mode has no interactive login-wait flow
- **File:** `src/main.ts` (attach branch, lines 25–36)
- **Why it matters:** SPEC.md §8a describes the login-wait behavior ("if either site is
  `login_required`, keep the browser open, prompt, wait for ENTER, re-check") as a general
  Phase 1 requirement, not scoped to a specific `browserMode`. The implementation only runs
  this flow in the `launch` branch of `main.ts`. In `attach` mode, a `login_required`
  result is simply logged and the run ends. This works today because the verified
  real-world workflow always completes login/Cloudflare verification manually in the
  externally launched Chrome *before* running the app (DECISIONS.md §11), so the gap is
  currently harmless in practice — but the code doesn't enforce or assist that ordering.
- **Smallest recommended fix:** Add one sentence to SPEC.md §8b stating the login-wait flow
  is launch-mode-only by design (attach mode assumes login already completed in the
  user-owned browser). Alternatively, extend the attach branch to also prompt-and-recheck
  on `login_required`/`unknown_state` — but that's implementation work, not a Phase 1
  blocker.

### 2. Test artifacts are not gitignored
- **File:** `.gitignore`
- **Why it matters:** Running `npm test` creates `.test-browser-profile/` (a real
  Playwright/Chromium profile directory with leveldb files) and `.test-logs/`, neither of
  which is covered by `.gitignore`. `git status` confirms both currently show as untracked
  (`?? .test-browser-profile/`, `?? .test-logs/`). This is exactly the class of directory
  SPEC.md §8/§12 says must never be committed (profile data / logs); it's currently just an
  oversight rather than a real credential leak, since it's a throwaway test profile, but a
  careless `git add -A` would sweep it in.
- **Smallest recommended fix:** Add `.test-browser-profile/` and `.test-logs/` (or a
  `.test-*` glob) to `.gitignore`.

### 3. `tests/fixtures/*.html` are unused
- **File:** `tests/fixtures/ready.html`, `login_required.html`, `unknown.html`
- **Why it matters:** SPEC.md §6/§14A describes these as fixtures loaded via
  `page.setContent()` or `page.goto('file://...')`. They exist and TODO.md marks them done,
  but no test actually loads them — `tests/unit/siteLoadResult.spec.ts` inlines equivalent
  HTML directly via `page.setContent()` instead. Functional coverage is present; the files
  themselves are dead.
- **Smallest recommended fix:** Either point `siteLoadResult.spec.ts` at the fixture files,
  or delete the unused files and drop the "loaded via fixtures" wording from SPEC.md §14A.3
  in a later doc pass.

### 4. `scripts/start-browser.ps1` doesn't read `config/config.json`
- **File:** `scripts/start-browser.ps1`
- **Why it matters:** The script hardcodes `.browser-profile` itself rather than reading
  `browserProfileDir` from `config/config.json`. Today the two happen to agree. If a user
  ever changes `browserProfileDir` in config expecting it to relocate the attach-mode
  browser's profile too, the script would silently keep using the old path — config would
  no longer be the single source of truth for that value in attach mode, contrary to
  SPEC.md §11's "config fully controls profile dir ... without code changes."
- **Smallest recommended fix:** Document this explicitly (config's `browserProfileDir` only
  fully governs `launch` mode; `attach` mode's profile path is fixed by the startup
  script) in SPEC.md §8b or DECISIONS.md §11.

---

## Test Gaps

### 1. No automated test for the daily-Chrome-profile rejection
- **File:** `src/config/loadConfig.ts` (lines 43–45), `tests/unit/config.spec.ts`
- **Why it matters:** This is the single line of code that enforces review requirement #9
  ("the project never uses the user's normal daily Chrome profile") and SPEC.md §8/§5a's
  central safety rule. It has zero automated coverage today — only manual inspection would
  catch a regression here.
- **Smallest recommended fix:** Add a `config.spec.ts` case that sets `browserProfileDir` to
  a path under `%LOCALAPPDATA%\Google\Chrome\User Data` (mocked or constructed the same way
  the implementation resolves `LOCALAPPDATA`) and asserts `loadConfig` throws.

### 2. `unknown_state` screenshot path is not asserted
- **File:** `src/sites/openSite.ts` (`checkSiteReady`, lines 20–26)
- **Why it matters:** `navigation_failed`'s screenshot behavior is asserted in
  `openSite.spec.ts`, but the sibling `unknown_state` screenshot path (same
  `saveScreenshot` helper, different call site) is only exercised for *classification*, not
  for the resulting `screenshotPath`, in `siteLoadResult.spec.ts`.
- **Smallest recommended fix:** Add an assertion (or a small dedicated test) that drives a
  page to `unknown_state` through `checkSiteReady` and checks `result.screenshotPath` is
  set.

### 3. SIGINT/SIGTERM shutdown path is untested
- **File:** `src/browser/shutdown.ts` (lines 18–20)
- **Why it matters:** This is an explicit Phase 1 acceptance criterion ("Browser always
  closes cleanly ... signal paths all verified" — TODO.md, still correctly left unchecked).
  Signal handling is awkward to unit-test in this runner, so this is noted as a known,
  reasonable gap rather than a defect.

---

## Documentation Consistency

- SPEC.md §8a (login-wait flow) predates §8b (attach mode addendum) and doesn't state
  whether §8a applies to `attach` mode; §8b doesn't mention login-wait at all. See
  Non-Blocking Issue #1 above.
- SPEC.md §6/§14A's description of `tests/fixtures/` doesn't match how the fixtures are
  actually (not) used. See Non-Blocking Issue #3 above.
- No outright factual contradictions were found between SPEC.md, TODO.md, and
  DECISIONS.md regarding attach mode itself — §8b (SPEC), the "Manual Chrome attach mode"
  section (TODO), and §11/§11a (DECISIONS) all agree with each other and with the verified
  real-world results.

---

## TODO Consistency

Two issues were found and corrected directly in `TODO.md` as part of this review (per the
review instructions allowing checkbox corrections without touching implementation code):

1. **Stale phase banner.** TODO.md's "Current Phase" line still read *"Phase 1 — Browser
   Foundation (design complete; implementation not started)"* despite the checklist below
   it showing most of Phase 1 implemented, tested, and manually verified — a direct
   violation of TODO.md's own rule #1 (must reflect actual, verified state). Corrected to
   reflect the actual current state.
2. **Self-contradictory checkbox pair.** "Failure on one site does not prevent the other
   site's attempt" was checked `[x]` under **Behavior**, but the identical fact, mirrored
   under **Phase 1 Acceptance Criteria** as "One site's failure does not block the other
   site's attempt," was left unchecked `[ ]`. Both are backed by the same evidence
   (`tests/unit/openSite.spec.ts`, independently re-run and confirmed passing). Checked the
   second line to match the first.
3. **Missing test entry.** `tests/unit/browserDiscovery.spec.ts` exists, passes, and is the
   primary automated coverage for attach-mode's hostname-matching safety (review
   requirement #6) but had no corresponding TODO line. Added it under Tests — A, checked,
   since it demonstrably exists and passes.

No TODO item was found to be checked `[x]` without real implementation or verification
evidence behind it. Several items remain correctly (conservatively) unchecked because they
require real-site verification in `launch` mode specifically, which the user's verified
real-world testing did not exercise (only `attach` mode was live-tested against real
sites) — e.g. "Single persistent Chromium context launches from a project-local profile
dir," the launch-mode login-wait real-site checklist item, the Ctrl+C-mid-run checklist
item, and the broken-URL-isolation real-site checklist item. These should stay unchecked
until someone actually runs `launch` mode against the real sites.

---

## Security / Browser Ownership Review

All items verified directly against source, independently of the user's reported results:

- **`connectOverCDP` usage (req. #3):** confirmed — `src/browser/launchBrowser.ts:15`,
  only code path that establishes an attach-mode session.
- **Attach mode only uses existing tabs (req. #4/#5):** confirmed — the attach branch of
  `src/main.ts` (lines 25–36) calls only `discoverSitePages` and `checkSiteReady`; neither
  `context.newPage()` nor `page.goto()` is ever called in that branch. Grepped the whole
  `src/` tree for `sendMessage`, `extractResponse`, `.fill(`, `.type(`, `page.click`,
  `fetch(` — no matches outside the hostname string `chat.openai.com`.
- **Hostname matching safety (req. #6):** `src/browser/discoverSitePages.ts`'s `matches()`
  requires exact match or a `.`-prefixed suffix match, which correctly rejects lookalikes
  such as `evilchatgpt.com` (no match) and `chatgpt.com.evil.com` (no match, since it
  neither equals `chatgpt.com` nor ends with `.chatgpt.com`) while still matching real
  subdomains. URL-parse failures degrade to an empty hostname, which matches nothing.
  Covered by `tests/unit/browserDiscovery.spec.ts` (5 tests, all passing).
- **Cannot accidentally close the externally owned browser (req. #7/#8):** confirmed — the
  only `context.close()` call in the codebase is in `src/browser/shutdown.ts:15`, gated
  behind `session.ownsBrowser`, which `launchBrowser.ts` sets to `false` for `attach` and
  `true` for `launch`. Verified by `tests/unit/shutdown.spec.ts` (both branches tested,
  including idempotency) and by the user's real-world result (external Chrome remained
  open after the app exited).
- **Never uses the user's daily Chrome profile (req. #9):** `src/config/loadConfig.ts:43–45`
  resolves `browserProfileDir` and rejects it if it equals or is nested under
  `%LOCALAPPDATA%\Google\Chrome\User Data`. This is the one safety-critical check with no
  automated test — see Test Gap #1.
- **`scripts/start-browser.ps1` (req. #10):** uses only the hardcoded project-local
  `.browser-profile` folder, binds remote debugging to `127.0.0.1` only, resolves paths via
  `$PSScriptRoot`/`Resolve-Path` (no injection risk, no untrusted input), and throws a clear
  error if Chrome isn't found in any of the three standard install locations it checks.
- **Errors handled safely (req. #15):** CDP-unavailable (`connectOverCDP` throws, caught
  and logged, non-zero exit), missing ChatGPT/Claude tab (logged as `navigation_failed`
  with a `... tab missing` detail, does not abort the other site), `unknown_state` (screen
  -shotted and logged, no automated action taken), `login_required` (classified and logged;
  see Non-Blocking Issue #1 for the attach-mode wait-flow gap).
- **No Phase 2 behavior (req. #16/#17):** grepped `src/` for message-sending,
  response-extraction, private/undocumented API calls, OpenAI/Anthropic API usage, stealth
  plugins, and fingerprint-spoofing — none present. `chatgptSite.ts`/`claudeSite.ts`
  implement only `checkReady`.

---

## Phase 1 Scope Compliance

Confirmed: Phase 1 code never sends a message, never reads/parses AI-generated response
content, never calls the OpenAI or Anthropic APIs, and never touches an undocumented
backend endpoint. `launch` mode remains architecturally intact and has not been broken by
the `attach`-mode addition — both modes share the same `SiteAdapter`/`SiteLoadResult`
contract, `loadConfig` still validates all original fields, and `shutdown.ts`'s
`ownsBrowser` gate is what lets both modes share one shutdown code path safely.

---

## Recommendation

- **Phase 1 can be accepted.** The user's reported real-world verification (attach success,
  both sites ready, clean exit, external Chrome left open, session survived a full Chrome
  restart, build passes, 18/18 tests pass) was independently re-confirmed for the automated
  parts (`npm run build`, `npm test`) during this review, and the source-level inspection
  found no BLOCKING issues — in particular, no browser-ownership violation, no
  message-sending/response-extraction code, and safe, boundary-correct hostname matching.
- **No blocking fix is required before commit.** The issues found are NON-BLOCKING,
  DOCUMENTATION, or TEST GAP class — worth tracking (the `.gitignore` gap and the missing
  daily-Chrome-profile test are the two most worth picking up soon), but none change
  Phase 1's actual behavior or safety posture.
- **It is safe to freeze Phase 1 before planning Phase 2.** The browser foundation
  (persistent/attach session handling, per-site readiness classification, clean shutdown,
  config validation) is solid, tested where it matters most, and matches its own spec and
  decision record closely enough to build on. Recommend picking up the `.gitignore` fix and
  the daily-Chrome-profile test as small follow-ups whenever convenient, but neither should
  hold up moving to Phase 2 planning.
