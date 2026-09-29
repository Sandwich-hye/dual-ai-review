# MILESTONE7_PRODUCTIZATION_DESIGN.md — Productization Phase

## Implementation status (Milestone 7.1 release preparation)

This document began as a pre-implementation design. Sections 1, 3, and 4 retain historical
assessment and proposals; they are not instructions for the current CLI. The current source,
README, and tests are authoritative for shipped behavior.

| Implemented now | Deferred or only conceptual |
| --- | --- |
| `npm run review -- --task ...` with optional `--diff`, explicit `--provider browser` or `--provider ollama --model MODEL_NAME` | Standalone `auditable` binary, replay command, `--json` stdout mode |
| Browser ChatGPT/Claude adapters or local-HTTP Ollama compatibility bridges | API provider, web viewer, provider registry |
| Existing audited loop, deterministic recommendation, unchanged interactive Human Gate | CLI wiring to Milestone 6A/6B supervised or augmented review |
| Human-readable terminal report and complete/failed CLI audit envelopes (schema v2) with provider/model/execution provenance | Rich line/hunk evidence rendering and automatic report sharing |
| Safe synthetic examples in `examples/` | A published, consented, real-provider example audit |

The browser and Ollama paths use the same audited loop. Ollama uses two independent sessions
of the selected local model; it is never presented as ChatGPT or Claude. The compatibility
bridge remains temporary because the frozen loop still requires a `Page` parameter.

Design document for Milestone 7. Grounded in the actual repository state as of commit
`4f303d2` (Milestone 6B implemented and merged), not just prior design docs — `git log`,
`package.json`, `config/config.json`, `src/main.ts`, and `scripts/smoke-augmented-review.ts`
were all read directly before writing this.

---

## 1. Current architecture assessment

### What should NOT change — the real product asset

- **The Claim Ledger** (`src/orchestration/claims/claimLedger.ts`) is already the evidence
  model the product vision asks for: typed claims, severity, confidence that moves by
  discrete evidence-strength steps, `DISPUTED` classification when evidence conflicts, full
  history. This is not a research artifact to be replaced — it *is* "evidence-grounded
  auditing," already built. Productizing means exposing it, not redesigning it.
- **The Decision Agent** (`decisionAgent.ts`) — a pure, seven-branch, deterministic function.
  Keep it exactly this small and this deterministic; that's what makes its output trustworthy
  and auditable, not a limitation to grow past.
- **The Human Gate** (`humanGate.ts`) — the literal embodiment of "keeps humans in control."
  This is the product's core differentiator versus "AI reviews AI and auto-merges." Do not
  weaken it, automate around it, or make it optional.
- **The deterministic JEV Supervisor (6A)** and **the LLM audit-augmentation layer (6B)** —
  frozen, safety-authoritative, and now genuinely working end to end (confirmed by reading
  `scripts/smoke-augmented-review.ts`: it dispatches a real LLM leg, asserts `prompt`/
  `rawResponse`/`groundedSignals` are populated, and verifies timeout→degradation behavior).
  This is a real, demonstrable engineering result — a portfolio asset, not a side quest.
- **`ConversationalSiteAdapter`** (`src/sites/siteTypes.ts`) — `checkReady`,
  `sendPrompt`, `waitForGenerationStart/Complete`, `getLatestAssistantResponse`. This is
  already the right *shape* for a provider abstraction. The productization work in §3/§4
  reuses this shape; it does not replace it.
- **The strict-parsing, no-partial-result discipline** (`structuredClaimParser.ts` and
  siblings) and **the schema-versioned, immutable audit-record discipline**
  (`AuditedReviewResult`, `SupervisedReviewResult`) — unusual rigor for a solo project, and
  worth calling out explicitly in a portfolio README as a deliberate practice, not hiding it.

### What is already well designed

- Every orchestration boundary (Human Gate, both site adapters) is dependency-injected, never
  hardcoded — this is precisely what makes multi-provider support cheap rather than a rewrite.
- Isolation tests that verify module boundaries by source-scanning imports (e.g.
  `supervisorIsolation.spec.ts`) are an unusual, genuinely good practice worth highlighting.
- The three-tier test strategy (offline unit → fake-adapter simulation → gated real-browser
  smoke) already matches how a real product would want to test an LLM-integration surface.

### Where technical debt actually exists

1. **`src/main.ts` is stuck at Phase 1.** It only discovers and checks readiness on two
   browser tabs — it never calls any review loop. All real capability
   (`runFixedReviewLoop`/`runConvergenceReviewLoop`/`runAuditedReviewLoop`/the 6A/6B
   supervisor stack) is reachable only through one-off `scripts/smoke-*.ts` files launched via
   `npm run smoke:*`. **There is currently no single command that runs "the product" for
   someone who isn't the author.** This is the single largest gap Milestone 7 must close.
2. **No `README.md` at the project root.** For a portfolio piece this is close to
   disqualifying — a visitor has no entry point into what this is or how to run it.
3. **Zero-friction demo path doesn't exist.** Every runnable path requires a logged-in,
   CDP-attached Chrome profile per site (`config/config.json`'s `browserMode: "attach"`,
   `cdpEndpoint`). Nobody can `npm install && npm run demo` and see output in under a minute.
   This is exactly the gap the requested Browser/API/Local-model split exists to close.
4. **Five parallel orchestration entry points accumulated across milestones** (fixed,
   convergence, audited, supervised, augmented), each wired by its own smoke script with
   slightly different setup. This is honest incremental history, not a mistake — but a
   product needs one obvious "current best flow" a user runs, not five scripts to compare.
5. **Config has no provider concept.** `config/config.json` is flat and browser-only; adding
   a provider selection is a small additive change, not a rewrite (§4).

### What would create unnecessary complexity — explicitly avoid

- A generic provider **registry**/plugin-discovery system. Three concrete adapters behind one
  interface is enough; don't build dynamic loading, a plugin marketplace, or config-driven
  reflection.
- A web UI before the CLI proves the workflow. A frontend adds an entire second surface
  (hosting, state, auth) not needed to demonstrate the core value.
- An evaluation/benchmark harness against a labeled dataset of "AI mistakes." This is
  explicitly the deferred research direction — resist building it now.
- Generalizing the Claim Ledger or Decision Agent into a "pluggable rule engine." They are
  valuable *because* they are small and fixed, not despite it.
- A local-model adapter supporting many runtimes at once (Ollama *and* llama.cpp *and* vLLM).
  Pick one — Ollama, for its free, turnkey, cross-platform, simple-HTTP-API profile — and
  defer the rest.

---

## 2. Milestone 7 product vision

**Working name and one-line pitch** (naming itself is an open question, §7):

> An evidence-grounded reliability layer for AI-assisted code review. It runs a second AI as
> a reviewer, forces every criticism it raises to become a tracked, evidence-backed claim,
> and gives a human the final ACCEPT/REJECT/CONTINUE call — with an inspectable audit
> trail of how that decision was reached.

**MVP workflow decision: CLI first, not web.** The core asset is the audit/evidence pipeline
and its rigor, not a visual surface. A CLI lets a technical viewer run one command and read
structured, evidence-grounded terminal output — the register recruiters and engineers already
trust from tools like `eslint`/`semgrep`/`pytest`. A read-only web viewer over the exact same
saved JSON audit output is a good Phase 7.3 addition (§4), never a Phase 7.1 requirement.

**Implemented CLI commands (interactive terminal required):**

```
npm run review -- --task "Review this signup change" --diff examples/demo.patch --provider ollama --model MODEL_NAME
npm run review -- --task "Explain three testing benefits" --provider browser
```

`MODEL_NAME` must be an installed Ollama model. The browser path requires ready, fresh
ChatGPT and Claude tabs. See `README.md` for setup.

**Future command sketches (not implemented):**

```
auditable review --task "Add input validation to signup handler" \
                  --diff ./changes.patch --provider ollama --model qwen2.5-coder

auditable review --task "..." --diff ./changes.patch --provider browser
auditable replay ./audit/run-2026-09-24T18-30-00.json
auditable review --task "..." --diff ./changes.patch --provider ollama --json > result.json
```

**Earlier aspirational report sketch (not current CLI output):**

```
Reviewing: Add input validation to signup handler
Round 1/3 — Reviewer flagged 2 claims (1 HIGH, 1 MEDIUM)

  [HIGH] Missing null check on req.body.email before validation
    Evidence: changes.patch, hunk #2, line 42
    Status: OPEN

  [MEDIUM] Error message leaks an internal field name
    Evidence: changes.patch, hunk #3, line 58
    Status: OPEN

Recommendation: CONTINUE (2 open issues, round 1 of 3)
JEV: no anomalies detected

> Your decision [CONTINUE/ACCEPT/REJECT]:
```

**Original pre-implementation demo goals:**

1. One command that runs end to end **without** a live logged-in browser (the Ollama path) —
   directly resolves the biggest technical-debt item above.
2. Human-readable terminal rendering of claims/evidence/recommendation — today the smoke
   scripts only print debug lines, not a report a non-author would want to read.
3. A real `README.md` with an example transcript (a GIF or asciinema recording is a strong,
   cheap addition).
4. At least one real, saved example audit-trail JSON checked into the repo (`examples/`) so a
   visitor can see the shape of the output without running anything themselves.

---

## 3. Original proposed architecture diagram (historical)

**Pre-7.1 baseline at design time:**

```
Chrome/CDP
    |
ChatGPT/Claude webpage  (ConversationalSiteAdapter: claudeSite.ts / chatgptSite.ts)
    |
runAuditedReviewLoop → Claim Ledger → Decision Agent → Human Gate → Audit Trail
```

**Conceptual proposal — the existing adapter shape stays; a common interface sits above three
implementations:**

```
                         CLI  (src/cli/index.ts)
                          |
                 ReviewInput { task, answer?, diff? }
                          |
              LlmProvider interface  (generalizes ConversationalSiteAdapter,
                          |            §4 — a parameter-shape change, not a rewrite)
        ------------------------------------------
        |                 |                       |
   Browser Adapter     API Adapter          Local Model Adapter
   (EXISTING —         (NEW, Phase 7.3,     (NEW, Phase 7.1 —
    claudeSite.ts,       opt-in, off by       Ollama, free,
    chatgptSite.ts,      default, costs       local HTTP API)
    unchanged)           money — §6)
        |                 |                       |
        ------------------------------------------
                          |
     runAuditedReviewLoop → Claim Ledger → Decision Agent → Human Gate → Audit Trail
                          |                                    (UNCHANGED — every
                          |                                     box below the
                 Deterministic JEV (6A, frozen)                 provider line is
                          |                                     completely provider-
              LLM Audit Augmentation (6B, unchanged —           agnostic already)
              can itself use any LlmProvider for its
              own dedicated audit-only session)
                          |
              renderTerminalReport() / --json  (NEW, §4)
```

The key realization: **everything from `runAuditedReviewLoop` downward is already
provider-agnostic** — it only ever talks to `ConversationalSiteAdapter`'s five methods. The
entire productization effort at the architecture layer is (a) generalizing that interface's
parameter shape so a non-browser implementation can satisfy it, and (b) writing two new,
small implementations of it. Nothing about the Claim Ledger, Decision Agent, Human Gate, or
either Supervisor needs to know or care which provider produced a given turn's text.

---

## 4. Original file-level change plan (historical)

This section records the initial proposal, not an inventory of files changed in the current
worktree. The implemented 7.1 path uses `src/providers/ollamaSiteBridge.ts` because the
audited loop still takes `Page`; `src/config/loadConfig.ts` remains browser-only, and the CLI
selects providers from its own flags. Later cleanup changed role wording in
`src/orchestration/claims/claimPrompts.ts` without changing review control flow.

### Files that remain exactly as-is

`src/orchestration/**` (all of it — claims, humanGate, supervisor 6A/6B, runAuditedReviewLoop
and siblings), `src/sites/claudeSite.ts`, `src/sites/chatgptSite.ts` (as *implementations*,
not as the interface — see next section), `src/config/loadConfig.ts`'s existing fields,
`config/config.json`'s existing `sites`/`browserMode`/etc. keys, every existing test file.

### Files that need modification

- **`src/sites/siteTypes.ts`** — `ConversationalSiteAdapter`'s methods currently take a
  Playwright `Page` as their first argument (`sendPrompt(page, prompt)`,
  `waitForGenerationComplete(page, baseline, timeoutMs)`, etc.). A non-browser provider has no
  `Page`. **Fix: introduce a generic `LlmProvider<TSession>` interface with the same five
  methods parameterized over an opaque session type**, and have `ConversationalSiteAdapter`
  become `LlmProvider<Page>` (a type alias, zero behavior change to `claudeSite.ts`/
  `chatgptSite.ts`, which keep their exact current signatures). This is a type-level
  generalization, not a rewrite — every existing call site continues to compile unchanged.
- **`src/config/loadConfig.ts`** — add one optional field, `provider: "browser" | "ollama"`
  (default `"browser"`, preserving today's behavior exactly if the field is absent), following
  the file's existing strict-fail-on-malformed-value discipline.

### New files

- `src/providers/llmProvider.ts` — the generalized interface from above, plus a
  `TurnBaseline`-equivalent type parameterized the same way.
- `src/providers/ollamaAdapter.ts` — a second implementation of `LlmProvider<OllamaSession>`
  wrapping Ollama's local HTTP API (`/api/chat`), no page/browser involved. `OllamaSession` is
  just `{ conversationId: string }` or similar — no external dependency beyond `fetch`.
- `src/cli/index.ts` — argument parsing (`--task`, `--diff`, `--provider`, `--model`,
  `--json`), constructs a `ReviewInput`, selects a provider, calls `runAuditedReviewLoop` (or
  the 6A/6B-supervised variant), and hands the result to the renderer.
- `src/cli/reviewInput.ts` — the small `{ task: string; answer?: string; diff?: string }`
  shape and the prompt-building glue feeding it into the existing `claimPrompts.ts` builders.
- `src/cli/renderTerminalReport.ts` — human-readable rendering of
  `AuditedReviewResult`/`SupervisedReviewResult`.
- `README.md` — project root.
- `examples/*.json` — 2–3 saved, real audit-trail outputs (Phase 7.2).
- `package.json` — one new script, `"review": "npm run build && node dist/src/cli/index.js"`.

### Migration risks

1. **The `Page`-coupling generalization touches a type every existing adapter and every
   existing test imports.** Low functional risk (it's additive/parametric, not a semantic
   change) but it is the one change with the widest blast radius in terms of *files that
   import the affected type*. Do this first, in isolation, with the full existing test suite
   as the regression gate, before writing either new provider.
2. **Ollama output quality/format variance.** Unlike the browser adapters (tuned against
   specific, stable DOM/response conventions of two named products), a local model's raw text
   may not reliably produce the sentinel-delimited structured format the parsers expect.
   Mitigate with the same "invalid becomes an explicit, visible failure, never a silent
   partial parse" discipline already used everywhere else — this is a parser-robustness
   concern, not an architecture problem.
3. **Demo-path fragmentation.** Once a CLI exists, the five existing smoke scripts and the new
   CLI both "work" but do different things. Don't delete the smoke scripts (they're the real
   regression-test fixtures for 6A/6B); do make the CLI the one path documented and demoed.

---

## 5. Implementation order

### Phase 7.1 — Smallest useful improvement

**Status: implemented for the audited CLI path; live-provider CLI verification is still a
separate release check.** This phase does not wire the 6A/6B supervisors into the CLI.

**Goal:** one real, documented command that runs the existing audited review loop end to end
against user-supplied input, with zero browser/login required, producing a human-readable
report.

**Implemented files:** `siteTypes.ts` (shared provider shape),
`src/providers/llmProvider.ts`, `ollamaAdapter.ts`, and temporary
`ollamaSiteBridge.ts`; `src/cli/index.ts`, `reviewInput.ts`, `reviewAudit.ts`, and
`renderTerminalReport.ts`; `README.md`, safe synthetic examples, and the `review` npm script.
The browser-only `loadConfig.ts` was not changed.

**Estimated complexity:** Medium. Mostly plumbing; Ollama's API is simple; the interface
generalization is the only piece requiring care.

**Risks:** the `Page`-coupling generalization (§4, risk 1); Ollama output-format variance
(§4, risk 2).

**Current usage:** `npm run review -- --task "..." --provider ollama --model MODEL_NAME`
uses a running local Ollama service and an installed model, with no browser login. Browser
mode uses ready ChatGPT and Claude pages. Both paths require a human in an interactive
terminal; neither path has been represented here as a successful live CLI smoke result.

### Phase 7.2 — Demo-ready version

**Status: future work.** The optional `--diff` input path and a clearly synthetic example
already exist in 7.1; the remaining items below are not shipped.

**Goal:** polish CLI output, exercise the existing `--diff` path with live providers, ship
consented and sanitized real example audits, add `--json` output mode,
expand the README with a real transcript or recording.

**Files changed:** `src/cli/*` extensions, `examples/*.json`, `README.md`. No changes to
`src/orchestration/**`.

**Estimated complexity:** Low–Medium.

**Risks:** scope creep ("just one more feature") — hold the line at CLI polish plus examples;
no new orchestration capability in this phase.

**Acceptance criteria:** a first-time visitor reads the README, runs one command against a
bundled example with no login required, and understands the output without reading source.

### Phase 7.3 — Portfolio-quality version

**Goal:** a minimal, read-only web viewer that renders a saved audit JSON as a shareable
report (claims, evidence, timeline, decision) — a thin renderer over existing data, not a new
backend. Optionally, an explicitly opt-in, off-by-default API provider adapter for people
without a machine that can run Ollama well. A short case-study write-up.

**Files changed:** new `web/` (static viewer, no server-side state), new
`src/providers/apiAdapter.ts` (opt-in only).

**Estimated complexity:** Medium.

**Risks:** the API adapter reopens this project's own "no paid API" rule (`DECISIONS.md`
§§2–4) — must remain strictly opt-in, never default, never required for the core demo, and
clearly labeled as costing money (§6, §7).

**Acceptance criteria:** a shareable static page renders a real audit trail legibly; the repo
has a one-paragraph "why this exists" write-up suitable for linking from a resume or
portfolio site.

---

## 6. Risks and trade-offs

- **Interface generalization risk** — contained to one type and its call sites; do it first,
  gated by the full existing test suite, before either new provider is written.
- **The "no paid API" identity tension** — this project has an explicit, documented rule
  against paid LLM APIs (`DECISIONS.md` §§2–4), and the requested architecture asks for an API
  adapter option. Resolved by making it strictly Phase 7.3, opt-in, off by default, clearly
  cost-labeled. Currently the CLI defaults to browser mode; local Ollama is selected with
  `--provider ollama`. Any paid API path would be a deliberate exception to the standing rule,
  not a silent reversal of it.
- **Scope creep** — each phase above states what NOT to build; the biggest risk to this
  milestone succeeding is treating it as "one more design pass" rather than shipping the
  smallest working CLI first.
- **Repo signal-to-noise for a portfolio visitor** — this repo currently has ten-plus
  `MILESTONE*_DESIGN*.md` files at the root recording a long, rigorous design history (a real
  asset for a technical reviewer who digs in) but a two-minute skim currently sees process
  artifacts, not a product. Recommend moving historical design docs into `docs/design-history/`
  (6B's docs are already partially archived this way) so the root reads as a product, with the
  design history still fully available and honestly preserved for anyone who wants the depth.
- **Local model quality risk** — a small local model may produce weaker or malformed
  structured reviews. Document provider differences without claiming equivalent output
  quality or implying that browser access has no account requirements or costs.
- **Realistic sizing** — this is solo, portfolio-driven work; the phases above are sized to be
  achievable in days, not weeks, for 7.1 specifically. If there's a deadline, it should shape
  how much of 7.2/7.3 is attempted before it (§7).

---

## 7. Questions requiring my decision

1. **Hardware/local-model assumption.** Can you run a 7–8B quantized model reasonably (a
   discrete GPU, or enough RAM for CPU inference at acceptable speed), or should Phase 7.1
   assume CPU-only and pick a smaller, faster model as the documented default?
2. **Timeline.** Is there a target date this needs to be demo-ready by (e.g., a job
   application window)? This changes how much of 7.2/7.3 is worth attempting versus stopping
   cleanly at a polished 7.1.
3. **The API-adapter exception.** Are you comfortable with Phase 7.3 introducing a strictly
   opt-in, off-by-default, clearly-cost-labeled API provider, as a deliberate, documented
   exception to this project's own "no paid API" rule — or should that rule stay absolute, in
   which case Phase 7.3's provider options stay at Browser + Ollama only?
4. **Naming/positioning.** Keep `dual-ai-review` as the project's public name, or pick a
   product-style name for the README/portfolio framing (the working pitch in §2 doesn't
   require a specific name, but a portfolio piece usually benefits from one)?
