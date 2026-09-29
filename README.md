# Dual AI Review

Dual AI Review runs a Generator LLM and a Reviewer LLM through an audited review loop. It tracks reviewer claims, produces a deterministic recommendation, and asks a person to choose the final `CONTINUE`, `ACCEPT`, or `REJECT` outcome. The CLI saves the result, including provider/model/execution provenance, as JSON.

The CLI currently supports either two browser pages (ChatGPT as generator and Claude as reviewer) or two independent sessions of one locally installed Ollama model. Ollama mode uses the local HTTP API; it does **not** send work to ChatGPT or Claude. The Milestone 6 supervisor and augmented-review paths remain separate smoke scripts; `npm run review` runs the audited loop, not an augmented-supervisor review.

## Requirements

- Node.js 20 or newer and npm. The checked-in lockfile resolves a Playwright version that requires Node 20 or newer.
- An interactive terminal for the Human Gate. The CLI cannot auto-accept or run unattended.
- For Ollama mode: a running local [Ollama](https://github.com/ollama/ollama/blob/main/docs/cli.mdx) service and an installed model. Choose the exact name shown by `ollama list`; use `ollama pull MODEL_NAME` if you still need to install it. The adapter defaults to `http://127.0.0.1:11434` and accepts only a local HTTP origin.
- For browser mode: Chrome, working ChatGPT and Claude sessions, and one fresh conversation tab for each site.

Install dependencies from the repository root:

```sh
npm ci
```

## Run a review with Ollama

Make sure Ollama is running, then replace `MODEL_NAME` with a model shown by `ollama list`:

```sh
npm run review -- --task "Review this signup change for input validation and error handling" --diff examples/demo.patch --provider ollama --model MODEL_NAME
```

The local model must follow the reviewer's strict structured-output prompt. If it does not, the run records an invalid review rather than silently treating malformed text as a valid claim review. Model quality and runtime vary by model and hardware.

On Windows PowerShell, if `npm.ps1` drops options after `--`, invoke `npm.cmd` explicitly:

```powershell
npm.cmd run review -- --task "Review this signup change for input validation and error handling" --diff examples/demo.patch --provider ollama --model MODEL_NAME
```

`--task` is required; `--diff` is optional and accepts a nonempty UTF-8 file of at most 1 MiB. `--provider` defaults to `browser`, so specify `ollama` explicitly for the no-browser path. `--model` is required only for Ollama. `--ollama-endpoint LOCAL_URL` optionally changes its loopback HTTP origin.

## Run a review in the browser

The checked-in [browser config](config/config.json) uses attach mode and local CDP port 9222. On Windows, start a **dedicated** Chrome profile in one terminal:

```powershell
powershell -File scripts/start-browser.ps1
```

In that Chrome window, sign in manually and leave exactly one fresh ChatGPT conversation tab and one fresh Claude conversation tab open. Then run, from another interactive terminal:

```sh
npm run review -- --task "Explain three practical benefits of automated software testing" --provider browser
```

The startup script always uses `.browser-profile/`; changing `browserProfileDir` in `config/config.json` does not change that script. Other platforms need an equivalent locally attached Chrome/CDP session or an appropriately configured launch-mode profile. The CLI refuses missing, ambiguous, unready, or non-fresh tabs; it does not perform login for you. Browser model names are recorded as `not_reported_by_browser_ui` because the exact model serving a turn is not reliably available from the page.

## Decisions and audit files

Each review round presents the current answer, deterministic recommendation, disputed claims, relevant evidence, and legal outcomes. You make the final choice; `REJECT` requires a rationale. A terminal report follows a completed run.

By default, JSON audits go to `~/.dual-ai-review/audits/`. Set `--audit-out FILE` to choose a path; an existing file is never overwritten. Complete audits have CLI envelope `schemaVersion: 2`, `status: "complete"`, `providerMode`, separate generator/reviewer provenance, and a nested audited-review result (`schemaVersion: 1`). A loop failure writes `status: "failed"`, a stage/message, and `partialReview` when available; it does not claim a completed result.

Audits can contain your entire task, diff, prompts, responses, and human rationale. Review them before sharing and do not commit private browser profiles or generated audits. The illustrative files in [examples](examples/README.md) contain no credentials or real user data.

## Verify and explore

```sh
npm run build
npm test
```

The examples directory has a safe input patch and a **synthetic**, schema-shaped audit/report for orientation; it is not evidence of a live Ollama or browser run. Separate real-site smoke scripts remain available through the `smoke:*` npm scripts and require their own prepared sessions. The current CLI has no `--json` stdout mode, replay command, web viewer, or automatic supervisor integration.
