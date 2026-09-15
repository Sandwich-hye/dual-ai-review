# DECISIONS.md 鈥?dual-ai-review

This file records architectural decisions and their rationale so that future AI coding
agents (and humans) do not accidentally reverse them without understanding why they were
made. Read this alongside `SPEC.md` and `TODO.md` before changing code or architecture.

---

## 1. Why Playwright is selected

Playwright is used to drive real, visible ChatGPT and Claude web sessions in a real
browser, because:

- It supports **persistent browser contexts** (`launchPersistentContext`) with a
  user-data directory out of the box, which is exactly the mechanism needed for login
  sessions to survive between runs (see 搂5).
- It has first-class TypeScript support and a stable, well-documented API for navigation,
  waiting for elements, and state inspection 鈥?needed for the readiness-detection work in
  Phase 1 and the send/extract work in Phase 2/3.
- It can drive either its own bundled Chromium or an installed real Chrome (`channel:
  "chrome"`), giving flexibility without changing the architecture.
- It is actively maintained, widely used for browser automation, and does not require any
  private/reverse-engineered protocol 鈥?it automates the browser the same way a human
  using it would (clicking, typing, reading the DOM).

Alternatives considered and rejected: Selenium (older API, weaker auto-waiting, no native
persistent-context concept as ergonomic as Playwright's), Puppeteer (Chromium-only,
weaker multi-browser story, no material advantage here since Chromium-only is fine for
this project anyway).

## 2. Why the OpenAI API is not used

The user already has a normal ChatGPT web account and explicitly does not want to pay for
API usage. Using the OpenAI API would mean paying per token on top of (or instead of) an
existing subscription, and would not fulfill the actual requirement, which is to automate
the **consumer web chat interface** the user already has access to. API usage is
explicitly out of scope for every phase of this project, not just Phase 1.

## 3. Why the Anthropic API is not used

Same reasoning as 搂2: the user has a normal Claude web account and does not want to incur
API billing. This project automates the visible claude.ai web interface via Playwright
instead. API usage is explicitly out of scope for every phase of this project, not just
Phase 1.

## 4. Why private/undocumented backend APIs should not be used

It would be technically possible to reverse-engineer ChatGPT's or Claude's internal
XHR/fetch endpoints and call them directly instead of driving the visible UI. This is
rejected because:

- Private endpoints are undocumented, unstable, and can change or be revoked without
  notice 鈥?this is precisely what killed the project's previous approach (see 搂9,
  ChatHub).
- Calling private endpoints directly is far more likely to be flagged as abuse/bot traffic
  than driving the actual rendered UI a human would use, since it bypasses the normal
  client entirely.
- It couples the project to internal implementation details of two external products
  instead of to their stable, user-facing surface (the rendered chat UI), which is far
  less likely to break in ways nobody can debug.
- Driving the visible web UI with Playwright is easy to reason about, easy to debug
  visually (the browser window shows exactly what's happening), and matches the project's
  explicit design constraint.

**Rule for future agents: do not add any direct `fetch`/`XHR` calls to ChatGPT or Claude
backend endpoints anywhere in this codebase. All interaction must go through Playwright
driving the rendered page.**

## 5. Why persistent browser profiles are needed

Logging into ChatGPT and Claude typically involves passwords, 2FA, and/or SSO 鈥?a flow
that should happen **once, manually, by the user**, not be scripted. A persistent
Playwright context (a real user-data directory on disk) is what allows the cookies/local
storage from that one manual login to be reused on every subsequent run, which is a hard
requirement from the project brief ("login sessions should persist between runs"). Without
this, every run would require a fresh manual login, making the tool unusable for iterative
orchestration.

### 5a. Why the profile must be dedicated, not the user's daily Chrome profile

The persistent `userDataDir` (搂8 of `SPEC.md`) **must** be a folder dedicated to this
project (default `.browser-profile/`), and must **never** point at or reuse the user's
normal, everyday Chrome profile directory. `channel: "chrome"` (launching the real,
installed Chrome executable) is fine to use, but only in combination with this dedicated
`userDataDir` 鈥?the executable may be the user's real Chrome; the profile data directory
may not be shared with daily browsing. Reasons:

- **Avoid Chrome profile locking conflicts.** Chromium places an exclusive lock on a
  profile directory while it's open. If this tool pointed at the user's daily profile, the
  user could not have their normal Chrome open (with that profile) at the same time as a
  run of this tool, which would make the tool actively hostile to normal use of the
  computer.
- **Reduce risk to the user's normal browser data.** This project's automation code
  navigates, waits, and (in later phases) reads page content programmatically. Scoping it
  to a throwaway/dedicated profile means any bug, crash, or unexpected automation
  behavior cannot corrupt, log out, or otherwise disturb the user's real bookmarks, saved
  passwords, extensions, other logged-in accounts, or browsing history.
- **Keep automation state isolated.** A dedicated profile means the only cookies/sessions
  present are the ones this tool created for ChatGPT and Claude 鈥?nothing else. This makes
  the tool's state easy to reason about, easy to wipe/reset (just delete the folder), and
  easy to inspect/debug without wading through unrelated personal browsing data.
- **The user logs into ChatGPT and Claude once, inside the dedicated automation
  profile** 鈥?a separate, intentional login distinct from (and with no bearing on) their
  normal daily browser session. This is the login this project's 搂8a interactive login
  flow waits on.

## 6. Why browser adapters should be separated from orchestration logic

`src/sites/chatgptSite.ts` and `src/sites/claudeSite.ts` contain **only** site-specific
knowledge (URLs, selectors, readiness/completion detection). Orchestration logic (Phase 4)
must depend only on the shared `SiteAdapter` interface (`src/sites/siteTypes.ts`), never on
a specific site module directly. This separation exists because:

- ChatGPT's and Claude's DOMs, loading behavior, and streaming/completion signals will
  differ and will change independently over time; isolating that volatility to one file
  per site keeps breakage contained and easy to locate/fix.
- It is the mechanism that makes "modular support for additional AI web interfaces later"
  (an explicit long-term goal) actually achievable 鈥?adding a third AI means adding one
  new `*Site.ts` file, not touching the orchestrator.
- It keeps Phase 1 (foundation) honest: the readiness-check contract designed now must be
  the same shape the send/extract methods plug into later, so this decision is being made
  early on purpose.

## 7. Why project state is stored in repository documents instead of relying on chat memory

`SPEC.md`, `TODO.md`, and `DECISIONS.md` are the durable source of truth for what this
project is, what's been done, and why 鈥?not any AI chat session's memory. This is because:

- Different AI coding agents (potentially different tools, models, or sessions) will work
  on this project over time, and none of them share memory with each other or with past
  sessions.
- A chat session ending, being cleared, or switching models must not cause loss of project
  context, rationale, or progress tracking.
- `TODO.md` in particular must reflect **verified, actual** implementation state (per its
  own rules), so any agent 鈥?or the user 鈥?can trust it as ground truth without needing to
  re-derive status from conversation history.

**Rule for future agents: always read `SPEC.md`, `TODO.md`, and `DECISIONS.md` before
changing code. Update `TODO.md` and, when an architectural decision is made or reversed,
this file 鈥?as part of the same change, not as an afterthought.**

## 8. Why Phase 1 is intentionally minimal

Phase 1 deliberately stops at "launch browser, open both sites, detect load state, log
clearly" and does **not** send messages, read responses, or orchestrate anything. This is
because:

- Every later phase (adapters, orchestrator, state machine) depends on the browser
  foundation being solid and well-understood first 鈥?building message-sending or
  orchestration on top of an unproven foundation risks compounding bugs that are hard to
  localize.
- Session persistence and site-load detection are the two riskiest, most
  external-dependency-prone pieces of the whole system (subject to UI changes, login
  flows, anti-bot measures); proving these work in isolation, with their own acceptance
  criteria and test plan, avoids a large-bang integration where the failure could be any
  one of many concerns.
- This matches the project's explicit guidance to avoid overengineering and unnecessary
  frameworks 鈥?build the smallest useful slice, verify it, then extend.

## 9. Rejected alternative: the ChatHub approach

Before settling on direct Playwright automation, an open-source **ChatHub v1.45.7 fork**
was built and evaluated as a possible foundation, since it already claimed to support
multiple AI chat providers in one UI. Findings:

- The fork built successfully and its UI worked as a shell.
- Its **ChatGPT web adapter** failed at runtime with a `"Failed to fetch"` error 鈥?  consistent with it depending on ChatGPT backend endpoints/mechanisms that have since
  changed or been locked down, which it had no ability to detect or recover from
  gracefully.
- Its **Claude adapter** failed to recognize an already-logged-in Claude account in the
  browser, meaning even a valid, active session couldn't be used through it.
- Both failures traced back to the same root cause: ChatHub's adapters relied on
  private/internal web-app integration points (not simply "drive the rendered UI like a
  user"), and those integration points had drifted out from under the fork's pinned
  version with no clear path to fix short of reverse-engineering the current internals.

**Decision:** rather than repairing or forking further an approach built on outdated,
private web-adapter integrations, this project moves to **direct browser automation via
Playwright against the normal rendered UI** (see 搂1 and 搂4). This is expected to be more
durable because it interacts with the same surface a human user does, and any breakage
(e.g. a changed selector) is visually debuggable in an open browser window rather than
requiring reverse-engineering of a private API contract.

This history is recorded so that a future agent does not reintroduce a ChatHub-style
private-adapter dependency, and understands *why* the project is not using or resurrecting
that codebase.

## 10. Phase 2 compliance gate: automatic ChatGPT response extraction is not yet approved

Phase 1, as built, does not extract, scrape, or otherwise read any AI-generated response
content from either site 鈥?it only detects page load/readiness state. This decision
record exists to stop a future agent from casually implementing automatic response
extraction in Phase 2 without first checking whether it's actually permitted.

**The issue:** OpenAI's current consumer Terms of Use prohibit automatically or
programmatically extracting data or Output from the ChatGPT consumer web product. Future
Phase 2, as currently sketched in `SPEC.md`/`TODO.md`, proposes exactly this 鈥?`extractLatestResponse(page)` reading ChatGPT's generated text out of the DOM
programmatically. As currently worded, that would conflict with OpenAI's terms as they
stand today.

**Decision:** this is recorded as an explicit **gate on Future Phase 2**, not a reason to
change any Phase 1 work (Phase 1 never extracts output, so it is unaffected). Before any
code is written to automatically extract ChatGPT responses:

1. Re-evaluate OpenAI's *then-current* service terms specifically regarding automated/
   programmatic extraction of Output from the consumer product (terms can change; do not
   rely on this document's description staying accurate 鈥?verify at implementation time).
2. Choose a compliant approach before writing extraction code. Possible directions
   (none pre-selected 鈥?this is a decision for whoever starts Phase 2, informed by
   whatever the terms say at that time):
   - Use an official, supported API or integration point for retrieving ChatGPT output,
     if one exists and fits the project's no-paid-API preference, or is otherwise
     accepted as a tradeoff at that time.
   - A **human-in-the-loop relay**: the user manually copies ChatGPT's response into the
     tool (e.g. pasting it into a prompt or a local input), so no programmatic extraction
     from the ChatGPT page ever occurs.
   - Any other mechanism that is explicitly, officially sanctioned by OpenAI at
     implementation time.
3. Document whichever approach is chosen, and the terms-of-use basis for believing it is
   compliant, in an update to this file before merging Phase 2 extraction code.

**Rule for future agents:** do not implement `extractLatestResponse` (or any equivalent
automatic scraping of ChatGPT's generated output) against the live ChatGPT web page until
this gate has been explicitly satisfied and recorded here. This gate is specific to
*ChatGPT* because it is the specific service whose current consumer terms were identified
as a concern; if Claude's or any future site's terms impose similar restrictions, apply
the same gate-and-record process to that site's adapter as well.


## 11. Why manual Chrome + CDP attach mode is supported

Claude Cloudflare verification succeeded when the user manually launched Google Chrome with a dedicated project profile, but looped when Chrome was launched directly by Playwright. Phase 1 therefore supports an attach mode using Playwright `chromium.connectOverCDP`.

Attach mode is strictly local and user-owned: Chrome is started with `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=9222`, and the project `.browser-profile` path. The application discovers existing ChatGPT and Claude tabs by hostname, performs only readiness checks, and does not create or navigate tabs. It must not close the attached Chrome process on shutdown.

This remains browser UI automation only. It does not bypass Cloudflare, use private APIs, send messages, or extract responses.
### 11a. Verified real-site attach-mode result

The Phase 1 real-site attach-mode manual test was completed successfully. Direct
Playwright-launched Chromium caused Claude Cloudflare verification loops, and launching
installed Chrome through Playwright caused the same loop. Manually launching the
dedicated Chrome with localhost remote debugging successfully completed Cloudflare
verification. Playwright CDP attach mode then detected both ChatGPT and Claude as ready.

The dedicated profile retained authentication across a complete Chrome restart: neither
ChatGPT nor Claude required login again. The attached Chrome remains user-owned; the
application exits cleanly without closing the attached browser. This is browser
automation through the visible UI, not a Cloudflare bypass.
### 11b. Verified ChatGPT Milestone 1 real-site smoke test

The real ChatGPT Milestone 1 smoke test passed against the manually launched dedicated
Chrome over CDP. The adapter successfully discovered the existing ChatGPT tab, captured
the current turn baseline, submitted the prompt `Reply with exactly: PHASE2_CHATGPT_OK`,
detected generation start, detected generation completion, and extracted the current-turn
response exactly as `PHASE2_CHATGPT_OK`.

The real-page completion detector lesson is that Send-button visibility is not a
completion requirement. Completion requires a new response relative to the baseline, a
non-empty normalized response, no visible generation-active/stop control for consecutive
polls, and unchanged response text for the configured stability interval. The Send button
is diagnostic only.
### 11c. Verified Claude Milestone 2 real-site adapter result

The real Claude Milestone 2 smoke test passed through the existing attached Claude tab.
It verified existing-tab discovery, prompt submission, generation-start detection,
generation-completion detection, and extraction of the current-turn response
PHASE2_CLAUDE_OK.

The live DOM lesson is that the stable assistant message boundary is
`[role="article"]:has([data-perf-reply-text])`; the response content is
`[data-perf-reply-text]`; and `[data-is-streaming="true"]` is the Claude-specific
generation-active signal. Sidebar conversation rows, chat headers, conversation titles,
and user messages do not qualify as assistant messages because they lack the response-text
descendant. Completion continues to require the existing new-message, non-empty, and
text-stability safeguards.

