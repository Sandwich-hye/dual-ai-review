# MILESTONE5_DESIGN.md — Auditable multi-agent review system (Claim Ledger + Human Gate)

Design-only document for Phase 2A Milestone 5. **No production TypeScript is changed by
this document, and none should be changed to implement it without a separate,
explicitly-approved implementation pass.** It builds on the frozen, real-browser-verified
Milestone 4A fixed-round loop (`src/orchestration/runFixedReviewLoop.ts`,
`fixedReviewPrompts.ts`) and the frozen, real-browser-verified Milestone 4B
convergence-driven loop (`src/orchestration/runConvergenceReviewLoop.ts` and everything
under `src/orchestration/convergence/`). **Milestone 4A and Milestone 4B are not modified
by this design** — every file either introduced keeps working exactly as verified, and
Milestone 5 is a new, parallel module, not an edit to either.

---

## 0. Inspection summary (what this design is built on)

Before drafting this design, the following were re-read in full: the current repository
file tree (`src/`, `scripts/`, `tests/`), `TODO.md`, `DECISIONS.md`, `REVIEW.md`, and every
file under `src/orchestration/` including `runFixedReviewLoop.ts`,
`runConvergenceReviewLoop.ts`, and all five pure modules under
`src/orchestration/convergence/` (`types.ts`, `fingerprint.ts`,
`structuredReviewParser.ts`, `objectionLedger.ts`, `convergenceEngine.ts`).

Key facts this design relies on:

- **Milestone 4B is complete and real-browser-verified** (`DECISIONS.md` §11f,
  `REVIEW.md`'s Milestone 4B section, `TODO.md`'s Milestone 4B checklist): flow
  `G0 → C1 → G1 → C2`, `stopReason: CONVERGED`, 2 rounds consumed, `cleanStreak: 2`, 0 open
  HIGH/MEDIUM. `npm run build`, `npm test` (133 passed), and `npm run smoke:convergence`
  all pass.
- **The convergence engine is already pure and browser-agnostic.** No file under
  `src/orchestration/convergence/` imports `playwright` or references `Page`; the only
  file that touches `Page`/adapters is `runConvergenceReviewLoop.ts` itself. This is the
  exact separation Milestone 5 must preserve and extend, not re-architect.
- **Two conversational participants exist today, bound via `ConversationalSiteAdapter`**
  (`src/sites/siteTypes.ts`): ChatGPT (`src/sites/chatgptSite.ts`, proposer/reviser role)
  and Claude (`src/sites/claudeSite.ts`, reviewer role). Both are attach-mode-only, CDP,
  never launch/close/navigate a tab (`discoverSitePages.ts`, `DECISIONS.md` §11).
- **The current ledger is objection-shaped, not claim-shaped**:
  `ObjectionLedgerEntry { id, severity, highestSeveritySeen, summary, reason, status,
  firstSeenRound, lastSeenRound, normalizedFingerprint, history }` (`convergence/types.ts`).
  It tracks whether something is wrong and how blocking it is; it does not track *why one
  side believes a claim is true or false*, i.e. it has no evidence concept.
- **There is no human-in-the-loop decision point anywhere in 4A or 4B.** Both loops run to
  a terminal `stopReason` (`CONVERGED` / `MAX_ROUNDS_REACHED` / `INVALID_REVIEW`, or 4A's
  fixed round count) fully autonomously; a human only reads the result afterward via smoke
  script console output.
- **Persistence is explicitly deferred, twice.** `MILESTONE4B_DESIGN.md` §12 designed a
  JSON-serializable round-record shape "not implemented"; `PHASE2_DESIGN.md` §7 sketches a
  `runs/<run-id>/` layout that has never been built. Milestone 5 inherits this same
  discipline (§13, open question 4) rather than silently expanding scope.

---

## 1. Goal / Non-goals

**Goal:** evolve the two-party ChatGPT ⇄ Claude convergence loop into an **auditable
multi-role review system**: a richer Claim Ledger (claims, not just objections, each
carrying evidence and a continuous confidence signal), an explicit Evidence Agent role, a
Decision Agent that produces a *recommendation* (never a final action), and a mandatory
**human decision gate** between every AI-computed recommendation and any actual
Continue/Accept/Reject outcome. The system must remain fully explainable after the fact:
every claim's final status and every human decision must be traceable to a reason.

**Non-goals (explicitly out of scope for Milestone 5):**

- **No changes to Milestone 4A or 4B.** `runFixedReviewLoop.ts`, `fixedReviewPrompts.ts`,
  `runConvergenceReviewLoop.ts`, and everything under `src/orchestration/convergence/`
  stay byte-for-byte frozen (§9).
- **No browser/adapter changes of any kind.** `chatgptSite.ts`, `claudeSite.ts`,
  `claudeUserTurns.ts`, `domUtil.ts`, `discoverSitePages.ts`, `siteTypes.ts`, any selector
  file — all untouched. No new site adapter, no third browser tab, no new CDP target.
- **No new external evidence sources.** The "Evidence Agent" role (§7) is model-elicited
  justification from the two existing conversational participants, not live web search,
  document retrieval, or any other integration. That is an explicit future option (§13),
  not built now.
- **No automatic human-gate bypass, simulation, or timeout-based auto-decision** in
  production code. A fake, scripted gate exists only in test code (§12), never as a
  production fallback.
- **No persistence/disk writes.** Exactly like `MILESTONE4B_DESIGN.md` §12, the data model
  is designed to be JSON-serializable so a future persistence layer could adopt it
  directly, but Milestone 5 does not write `runs/<run-id>/` or any file to disk. This is a
  deliberate, named open question (§13.4), not an oversight.
- **No LLM-backed Decision Agent.** The Decision Agent (§7) is a deterministic function —
  a direct evolution of today's `convergenceEngine.ts` — not a third model call. An
  LLM-backed decision synthesis is an explicit future option (§13.2).
- **No change to `config/loadConfig.ts` or `config/config.json`.** Continuing 4A/4B's own
  precedent (`MILESTONE4B_DESIGN.md` §14), any new tunables (confidence thresholds, gate
  policy) stay call parameters with defaults, not config-schema additions, until a real
  persistence/config layer needs a home for them.

---

## 2. Current state recap (frozen foundation)

```
runFixedReviewLoop.ts            — Milestone 4A: fixed G0→C1→G1→...→C(n)→G(n), untouched
runConvergenceReviewLoop.ts      — Milestone 4B: G0→C1→G1→C2→... until CONVERGED /
                                    MAX_ROUNDS_REACHED / INVALID_REVIEW, untouched
  convergence/convergencePrompts.ts     — pure prompt builders
  convergence/structuredReviewParser.ts — pure text → StructuredClaudeReview | Invalid
  convergence/objectionLedger.ts        — pure ledger create/ingest, conservative
                                           fingerprint matching, severity floor/reject rules
  convergence/fingerprint.ts            — pure normalization + Dice-coefficient similarity
  convergence/convergenceEngine.ts      — pure decision function (CONTINUE/CONVERGED/
                                           MAX_ROUNDS_REACHED/INVALID_REVIEW)
```

Both loops are two-party, fully autonomous, and terminate with no human involvement. Both
depend only on `ConversationalSiteAdapter` for I/O and on pure, DOM-free modules for
decision logic. Milestone 5 keeps exactly this shape — a new orchestrator depending on
`ConversationalSiteAdapter` plus new pure modules — and adds a human-facing gate as a
**third kind of dependency**, alongside adapters and pure logic (§3.2, §7).

---

## 3. Architecture evolution

### 3.1 Current (Milestone 4B) architecture

```
                 ┌─────────────────────────────┐
 originalTask →  │ runConvergenceReviewLoop.ts  │ → ConvergedReviewResult
                 │  (sole Page/adapter caller)  │    (stopReason, finalAnswer, ledger, …)
                 └──────────────┬───────────────┘
                                │ calls
                 ┌──────────────┴───────────────┐
                 │  convergence/* (pure, no DOM) │
                 │  parser → ledger → engine     │
                 └───────────────────────────────┘
     ChatGPT tab (Generator/Reviser) ⇄ Claude tab (Reviewer)
     — fully autonomous, no human step, stops itself
```

### 3.2 Future (Milestone 5) architecture

```
                 ┌───────────────────────────────────┐
 originalTask →  │  runAuditedReviewLoop.ts           │ → AuditedReviewResult
                 │  (sole Page/adapter/gate caller)   │    (outcome, finalAnswer,
                 └──┬───────────────┬──────────────┬──┘     claimLedger, auditTrail, …)
                    │ calls         │ calls        │ calls
     ┌──────────────┴───┐  ┌────────┴─────────┐  ┌─┴──────────────────┐
     │ claims/* (pure)   │  │ convergence/*    │  │ humanGate/*         │
     │ claimLedger.ts    │  │ (REUSED, not     │  │ HumanGate interface │
     │ evidence.ts       │  │  modified —      │  │ + real terminal     │
     │ decisionAgent.ts  │  │  parser/         │  │   implementation    │
     │ (new pure logic)  │  │  fingerprint     │  │ + fake scripted     │
     └───────────────────┘  │  reused as-is)   │  │   implementation    │
                             └──────────────────┘  │   (tests only)     │
                                                     └─────────────────┘
     ChatGPT tab (Generator)  ⇄  Claude tab (Reviewer, doubles as Evidence
     — same two adapters, same ConversationalSiteAdapter contract, NO new browser code —
     — plus a synchronous, blocking HUMAN GATE before any Continue/Accept/Reject action
```

**The central architectural decision, stated explicitly:** the four roles named in the
task (§7 — Generator, Reviewer, Evidence, Decision) are **logical roles layered on top of
the existing two `ConversationalSiteAdapter` bindings and one new deterministic module**,
not four new integrations. This is what satisfies "no browser code changes" without
weakening the multi-agent goal:

| Role | Bound to | New browser code? |
|---|---|---|
| Generator Agent | The existing ChatGPT adapter (identical binding to 4B's `G` turns) | No |
| Reviewer Agent | The existing Claude adapter (identical binding to 4B's `C` turns) | No |
| Evidence Agent | A **new prompt kind** (`buildEvidenceRequestPrompt`, §11) sent to either the ChatGPT or Claude adapter on demand, per claim, using the same `sendPrompt`/`waitForGenerationStart`/`waitForGenerationComplete`/`getLatestAssistantResponse` contract | No — reuses the same two adapters, no third site |
| Decision Agent | A **new deterministic pure function** (`decisionAgent.ts`, §7.4), a direct superset of `convergenceEngine.ts`'s decision logic — no model call by default | No — pure TypeScript, no `Page` involved |

A fifth "role" is added that is not in the task's AI-role list because it is explicitly
**not** an AI: the **Human Gate** (§6) is a first-class dependency of the orchestrator,
injected the same way an adapter is, with a real (blocking terminal prompt) and a fake
(scripted, tests-only) implementation — mirroring exactly how `ConversationalSiteAdapter`
already has a real DOM-backed implementation and fake in-memory implementations in
`tests/unit/runConvergenceReviewLoop.spec.ts`.

---

## 4. Claim Ledger enhancement

### 4.1 Field-by-field evolution table

| Current (`ObjectionLedgerEntry`, `convergence/types.ts`) | Future (`ClaimLedgerEntry`, new `claims/types.ts`) | What changed and why |
|---|---|---|
| `id: string` (`OBJ-<n>`) | `id: string` (`CLAIM-<n>`) | Renamed prefix only; same engine-assigned, monotonic, never-reused identity rule (§6.1 of `MILESTONE4B_DESIGN.md`, reused verbatim). |
| `severity: ReviewSeverity` (`HIGH`\|`MEDIUM`\|`LOW`) | `severity: ReviewSeverity` (unchanged, reused type) **plus** `confidence: number` (`0.0`–`1.0`) | Severity still answers "how much does this block acceptance if true"; confidence is a **new, orthogonal** axis answering "how sure are we this claim is actually true," derived from the accumulated evidence (§4.2). A HIGH-severity claim can have low confidence (a serious *if true* allegation nobody has substantiated yet) — the two must never be conflated into one number. |
| `status: ObjectionStatus` (`OPEN`\|`RESOLVED`\|`REJECTED`) | `status: ClaimStatus` (`OPEN`\|`RESOLVED`\|`REJECTED`\|`DISPUTED`) | Added `DISPUTED`: a claim with both supporting and challenging evidence whose confidence sits in an ambiguous middle band (§4.3) — distinct from `OPEN` (nobody has challenged it yet) so the human gate (§6) can be shown disputed claims with higher priority. |
| `summary` / `reason` (two free-text fields) | `claim: { statement: string; rationale: string }` | Renamed for clarity to match the task's own vocabulary ("original claim"), field-for-field equivalent to `summary`/`reason` — no semantic change, only naming, so existing prompt-building patterns from `convergencePrompts.ts` transfer directly. |
| *(none)* | `evidenceFor: EvidenceRef[]` | **New.** References into the run's evidence log (§5) supporting the claim as true. |
| *(none)* | `evidenceAgainst: EvidenceRef[]` | **New.** References into the evidence log challenging the claim (the "counter evidence" the task asks for). |
| *(none)* | `confidenceHistory: ConfidenceChangeEvent[]` | **New.** Append-only, one entry per confidence recomputation, mirroring `history`'s "never silently overwritten" rule (§4.4). |
| `highestSeveritySeen: ReviewSeverity` | `highestSeveritySeen: ReviewSeverity` (unchanged) | Reused verbatim — the reopen-floor rule (`MILESTONE4B_DESIGN.md` §6.6) still applies to severity exactly as before. |
| `firstSeenRound`, `lastSeenRound` | unchanged, same names/semantics | No change needed. |
| `normalizedFingerprint: string[]` | unchanged, same names/semantics | The existing conservative Dice-coefficient matcher (`fingerprint.ts`) is **reused by direct import**, not copied — it is provider-agnostic pure logic with no claim-ledger-specific assumptions baked in (§9). |
| `history: ObjectionHistoryEvent[]` | `history: ClaimHistoryEvent[]` — superset of the existing event kinds (`RAISED`, `REPEATED`, `PARAPHRASED`, `RESOLVED`, `REJECTED`, `REOPENED`, `IMPLICITLY_CARRIED_OPEN`, `SEVERITY_CHANGED`, `SEVERITY_DOWNGRADE_REJECTED`, `DUPLICATE_COLLAPSED`) plus new kinds: `EVIDENCE_ADDED`, `CONFIDENCE_CHANGED`, `DISPUTED`, `UNDISPUTED`, `HUMAN_DECISION_RECORDED` | Every new mechanism gets its own history event kind, continuing 4B's rule that *nothing changes ledger state without an accompanying, permanent, typed history entry* (§8). |

### 4.2 Confidence, not severity, absorbs evidence

Severity stays exactly what it was in 4B: a human/reviewer-declared measure of how much a
claim (if true) should block acceptance. Confidence is new and is **derived, not
declared** — it starts at a neutral prior when a claim is raised and moves only in
response to logged evidence (§5), via a documented, deterministic update rule (not an LLM
"vibe" score):

```
confidence(claim) starts at 0.5 when RAISED (no evidence yet — maximally uncertain)

on each EvidenceRef added:
  supporting evidence  → confidence moves toward 1.0
  challenging evidence → confidence moves toward 0.0
  magnitude of movement scales with the evidence's own declared strength
    (STRONG | MODERATE | WEAK — set by whichever agent submitted the evidence,
     §5.1), not by which side submitted it — this is what keeps the rule
     symmetric and prevents "the last agent to speak always wins"
```

The exact update function (weighted average vs. Bayesian-style update vs. a simple
bounded increment table) is left as an **implementation-time decision**, not fixed here,
because it has no bearing on the architecture — but whichever function is chosen must
satisfy three invariants, each with a corresponding required unit test (§12.1):

1. **Monotonic-with-evidence-count is not required, but boundedness is:** confidence must
   always remain in `[0, 1]` — no update rule may push it outside that range regardless of
   how much evidence accumulates on one side.
2. **Symmetry:** identical evidence submitted for vs. against two otherwise-identical
   claims must move their respective confidences by equal and opposite amounts. This is
   the confidence-axis analogue of 4B's "false-new must be preferred over false-merge"
   design bias (`MILESTONE4B_DESIGN.md` §6.5) — here, the bias to guard against is
   confidence drifting toward whichever agent happens to submit evidence *last*, rather
   than toward whichever side's evidence is actually stronger.
3. **No silent overwrite:** every confidence change appends a `ConfidenceChangeEvent`
   (old value, new value, the `EvidenceRef` that caused it, round) to `confidenceHistory`
   — never a bare mutation of the `confidence` field alone.

### 4.3 The `DISPUTED` status band

A claim is `DISPUTED` (not `OPEN`) when it has **at least one** entry in both
`evidenceFor` and `evidenceAgainst` **and** its confidence sits inside a configurable
middle band (default `0.35`–`0.65`). This is a pure, recomputed-every-ingest classification
— not a status any agent can set directly — mirroring how 4B never lets Claude's
`reviewStatus` field decide anything (`MILESTONE4B_DESIGN.md` §7.1 rule 3, §8: "advisory
only"). `DISPUTED` claims are surfaced to the human gate (§6) ahead of merely `OPEN` ones,
since they are the claims where the two AI roles most concretely disagree.

### 4.4 Resolution history (the task's explicit ask)

`ClaimHistoryEvent` already carries `RESOLVED`/`REJECTED`/`REOPENED` from 4B's design
unchanged. What's added for "resolution history" specifically is that a `RESOLVED` or
`REJECTED` event on a `ClaimHistoryEvent` **must** carry a `resolutionEvidenceRef:
EvidenceRef` (§5.2) — i.e., a claim cannot be marked resolved or rejected without a
specific, logged piece of evidence justifying it, closing the one gap 4B's design left
open (severity-only bookkeeping, no requirement that a resolution point at *why*). 4B's
`resolutionEvidence: Record<string,string>` free-text map (`convergence/types.ts`) is the
direct ancestor of this field; Milestone 5 turns that free text into a first-class,
independently-listable `Evidence` record (§5) rather than an inline string.

---

## 5. Evidence tracking system

### 5.1 `Evidence` — a first-class, independently addressable record

```ts
// design sketch — src/orchestration/claims/types.ts (new module)
export type EvidenceKind = "SUPPORTING" | "CHALLENGING" | "RESOLUTION";
export type EvidenceStrength = "STRONG" | "MODERATE" | "WEAK";
export type EvidenceSourceRole = "GENERATOR" | "REVIEWER" | "EVIDENCE_AGENT" | "HUMAN";

export interface Evidence {
  id: string;                 // "EV-<n>", engine-assigned, never reused (same rule as claim ids)
  claimId: string;            // the ClaimLedgerEntry this evidence is attached to
  kind: EvidenceKind;
  strength: EvidenceStrength;      // declared by the submitting agent/human, drives confidence movement (§4.2)
  sourceRole: EvidenceSourceRole;
  text: string;                // the actual evidentiary content (a quote, an excerpt, a
                                 // worked counter-example, a citation to prior conversation text)
  round: number;
  submittedAt: string;         // ISO timestamp
}

export type EvidenceRef = string; // an Evidence.id — claims reference evidence by id,
                                    // never by inlining a copy, so evidence is never
                                    // duplicated or silently diverges from its own record
```

Evidence is **append-only and immutable once created** — exactly like `ObjectionLedgerEntry.history`
entries in 4B, evidence records are never edited after submission; a correction is a new
`Evidence` record referencing the old one in its `text` (or a dedicated optional
`supersedesEvidenceId` field), never an in-place edit. This is what makes an evidence log
independently auditable: given a finished run, every `EvidenceRef` on every claim resolves
to exactly one immutable record with a fixed author, round, and timestamp.

### 5.2 What each claim supports, mapped directly to the task's five bullet points

| Task's requirement | Design element |
|---|---|
| Original claim | `ClaimLedgerEntry.claim: { statement, rationale }`, fixed at `RAISED` time; later `PARAPHRASED` merges update it but the prior wording remains recoverable from `history` (§4.1, unchanged rule from 4B §6.2). |
| Source/evidence | `evidenceFor` / `evidenceAgainst`: `EvidenceRef[]` resolving into the immutable `Evidence` log (§5.1), each carrying `sourceRole` and `strength`. |
| Reviewer challenge | An `Evidence` record of `kind: "CHALLENGING"`, `sourceRole: "REVIEWER"` — a challenge **is** a specific evidence submission, not a separate concept; this keeps the model uniform (challenging and supporting evidence are the same shape, differing only in `kind`) rather than adding a parallel "challenge" object that would need its own confidence-update rule. |
| Resolution evidence | An `Evidence` record of `kind: "RESOLUTION"`, referenced by the terminating `RESOLVED`/`REJECTED` `ClaimHistoryEvent`'s mandatory `resolutionEvidenceRef` (§4.4). |
| Confidence changes | `confidenceHistory: ConfidenceChangeEvent[]` on the claim, one entry per `Evidence` ingested, each entry recording which `EvidenceRef` caused the change (§4.2). |

### 5.3 Evidence Agent turn (how evidence actually gets produced)

Per §3.2, the Evidence Agent role is realized as a new, explicit prompt kind
(`buildEvidenceRequestPrompt(task, claim, currentAnswer)` in a new
`claims/claimPrompts.ts`, following the exact pattern of `convergencePrompts.ts`), sent to
whichever adapter is configured as the evidence-elicitation target for a given claim
(default: the Reviewer's adapter, i.e. Claude, since it is already the reviewing party;
configurable per-claim to instead ask the Generator, e.g. "defend your own answer" cases).
The response is parsed by a new, equally strict sentinel-JSON grammar
(`BEGIN_EVIDENCE_RESPONSE` / `END_EVIDENCE_RESPONSE`), reusing 4B's proven parsing pattern
(§7 of `MILESTONE4B_DESIGN.md`) rather than inventing a new grammar style:

```
BEGIN_EVIDENCE_RESPONSE
{
  "kind": "SUPPORTING" or "CHALLENGING",
  "strength": "STRONG" or "MODERATE" or "WEAK",
  "text": "<the actual evidentiary content>"
}
END_EVIDENCE_RESPONSE
```

A malformed evidence response is handled exactly like 4B's `INVALID_REVIEW`: it never
silently becomes a usable `Evidence` record, the requesting round is flagged, and no
confidence update occurs from unparseable output (§9 reuses this "never partial/best-effort"
principle directly).

**Evidence requests are not unconditional.** Requesting evidence for every claim every
round would multiply browser turns unnecessarily. The recommended default policy (an
implementation-time tunable, not fixed here): request evidence only for claims entering or
already in the `DISPUTED` band (§4.3), or explicitly requested by the human at the gate
(§6) — "I don't believe this claim, get more evidence before I decide."

---

## 6. Human decision gate

### 6.1 Placement in the lifecycle

```
   AI review (Generator + Reviewer + on-demand Evidence Agent turns,
              ingested into the Claim Ledger, confidence recomputed)
                              ↓
   Decision Agent computes a RECOMMENDATION only
   (CONTINUE_RECOMMENDED | ACCEPT_RECOMMENDED | REJECT_RECOMMENDED) — §7.4
                              ↓
   ════════════ HUMAN DECISION GATE (blocking, mandatory, every round) ═══════════
   Presented to the human: the claim ledger delta this round, all DISPUTED claims,
   the Decision Agent's recommendation and its stated reason, and the current answer.
   Human returns exactly one of:
                              ↓
        CONTINUE                    ACCEPT                    REJECT
   (engine proceeds to      (run stops now, finalAnswer   (run stops now, marked
    the next round exactly   is accepted — analogous to    rejected — no retry, no
    like 4B's CONTINUE       4B's CONVERGED, but now        auto-resume; a human must
    branch)                  human-ratified, not purely     restart deliberately)
                             engine-decided)
```

**The gate is mandatory on every round, not only at a computed stopping point.** This is a
deliberate difference from 4B, where the engine is the sole authority on when to stop.
Here, a human can:

- **Override an `ACCEPT_RECOMMENDED` into `CONTINUE`** — e.g., the human doesn't trust a
  clean streak because a `DISPUTED` claim's confidence is still borderline, even though
  severity-wise nothing is blocking.
- **Override a `CONTINUE_RECOMMENDED` into `ACCEPT`** — e.g., the human judges the
  remaining open claims immaterial and wants to stop early (this is the one place a human
  can shortcut the engine's own patience, which the engine itself is never allowed to do
  autonomously).
- **Issue `REJECT` at any point** — the run stops, and unlike 4B's terminal states, `REJECT`
  is not something the engine can arrive at by itself; it exists only as a human action.
  `REJECT` requires a mandatory rationale string (§8); `CONTINUE`/`ACCEPT` rationale is
  optional but always recordable.

### 6.2 Gate contract (design sketch)

```ts
// design sketch — src/orchestration/humanGate/humanGate.ts (new module)
export type HumanGateOutcome = "CONTINUE" | "ACCEPT" | "REJECT";

export interface HumanGatePresentation {
  round: number;
  currentAnswer: string;
  recommendation: DecisionRecommendation;   // §7.4
  disputedClaims: ClaimLedgerEntry[];
  claimLedgerDelta: ClaimLedgerEntry[];      // entries touched this round only
}

export interface HumanGateResponse {
  outcome: HumanGateOutcome;
  rationale?: string;      // REQUIRED when outcome === "REJECT" (validated by the caller,
                            // not merely by convention — see §8)
  decidedAt: string;       // ISO timestamp, engine-stamped at the moment the response is read
}

export interface HumanGate {
  presentAndAwaitDecision(presentation: HumanGatePresentation): Promise<HumanGateResponse>;
}
```

This is intentionally the same shape as `ConversationalSiteAdapter`: a narrow interface
with exactly one production implementation (a blocking terminal prompt, §6.3) and fake,
scripted implementations used only in tests (§12.1) — never a code path in production that
answers on the human's behalf.

### 6.3 Production implementation: blocking terminal prompt

The real `HumanGate` implementation blocks on terminal input, structurally identical to
Phase 1's existing login-wait ENTER flow (`SPEC.md` §8a, `src/main.ts`'s launch branch) —
this project already has one precedent for "stop everything and wait for a human to type
something in this same terminal," and Milestone 5 reuses that established pattern rather
than inventing a GUI, a file-watch protocol, or a network callback. It prints the
`HumanGatePresentation` in full (claim ledger delta, disputed claims, recommendation and
its reason), then reads a line of input, validated against exactly three accepted tokens
(case-insensitive: `continue`, `accept`, `reject`) plus, for `reject`, a required non-empty
follow-up line for `rationale`. Invalid input is re-prompted, never defaulted.

### 6.4 Why the gate cannot be skipped or timed out in production

A "no answer within N seconds → default to X" fallback would silently reintroduce full
autonomy through the back door and defeat the entire purpose of Milestone 5. **No timeout,
no default outcome, and no `--yes`/`--auto-accept` flag exists in this design for
production use.** The only place a `HumanGate` may answer without an actual human is
inside a test's fake implementation (§12.1), which is a different, clearly-labeled
`HumanGate` instance never shared with production wiring — the same separation 4A/4B
already maintain between real adapters and fake in-memory adapters.

---

## 7. Multi-agent roles

### 7.1 Generator Agent

Produces `G0` and, on a `CONTINUE` human decision, a complete revised answer — identical in
responsibility to 4B's ChatGPT role. Bound to the existing ChatGPT adapter, unchanged.

### 7.2 Reviewer Agent

Raises claims against the current answer — identical in responsibility to 4B's Claude
role, with its output grammar extended (not replaced) to carry the new claim-ledger fields
(§4). Bound to the existing Claude adapter, unchanged. The reviewer's structured-review
parser is a **new module** (`claims/structuredClaimParser.ts`) that extends 4B's grammar
(adds `confidence`-relevant fields) rather than editing
`convergence/structuredReviewParser.ts` in place (§9) — 4B's own frozen parser continues to
serve `runConvergenceReviewLoop.ts` exactly as before, for any caller who still wants the
simpler two-party loop without the audit/gate machinery.

### 7.3 Evidence Agent

Described fully in §5.3. Not a new adapter — a new prompt kind fired against one of the
two existing adapters, on-demand, gated by the `DISPUTED`-claim policy or explicit human
request. This is the role most likely to be strengthened by a genuinely new integration
later (live retrieval, a documents connector, etc.) — deliberately deferred (§13.1) so
Milestone 5 does not couple "richer evidence" to "new browser code."

### 7.4 Decision Agent

A **new, pure, deterministic module** (`claims/decisionAgent.ts`), architecturally the
direct descendant of `convergenceEngine.ts`. It computes a `DecisionRecommendation`, never
a `HumanGateOutcome` — the rename from 4B's `ConvergenceDecision` to
`DecisionRecommendation` is deliberate, to make it structurally impossible to mistake an
AI-computed value for a human-authorized one anywhere in the type system:

```ts
// design sketch — src/orchestration/claims/decisionAgent.ts (new module)
export type RecommendationKind =
  | "CONTINUE_RECOMMENDED" | "ACCEPT_RECOMMENDED" | "REJECT_RECOMMENDED";

export interface DecisionRecommendation {
  kind: RecommendationKind;
  round: number;
  reason: string;                 // human-readable — WHY this recommendation (§8)
  cleanStreak: number;             // reused concept from convergenceEngine.ts §8.2
  openHighCount: number;
  openMediumCount: number;
  disputedCount: number;           // new — count of DISPUTED claims (§4.3)
  averageConfidence: number;       // new — mean confidence across OPEN + DISPUTED claims
}
```

`REJECT_RECOMMENDED` is a genuinely new recommendation kind with no 4B ancestor: it fires
when the claim ledger's shape indicates the current answer is *unlikely to be salvageable
by further revision* (e.g., a HIGH-severity claim has been reopened after resolution more
than a configured number of times, indicating the Generator cannot actually address it) —
this is a **recommendation only**; the engine never rejects a run by itself (§6.4). The
exact trigger conditions for `REJECT_RECOMMENDED` are an implementation-time tuning
decision, out of scope for this design beyond naming the concept and its non-binding
nature.

By default, the Decision Agent is **not** LLM-backed — like `convergenceEngine.ts`, it is
ordinary TypeScript over the ledger's plain data, cheap, instant, and fully deterministic
(so its own behavior is itself unit-testable without any adapter, §12.1). An LLM-backed
alternative (asking a model to *synthesize* a recommendation in prose, rather than
computing it from counts) is named as an explicit future option (§13.2), not built now,
precisely because a non-deterministic recommendation source would make Decision Agent
behavior itself harder to audit — direct tension with this milestone's own goal.

### 7.5 Role summary table

| Role | AI-backed? | Bound to | Can finalize an outcome? |
|---|---|---|---|
| Generator | Yes (ChatGPT) | Existing adapter | No |
| Reviewer | Yes (Claude) | Existing adapter | No |
| Evidence | Yes (either adapter, on demand) | Existing adapter(s) | No |
| Decision | No (deterministic) | Pure function | No — recommendation only |
| **Human Gate** | **No — a real person** | `HumanGate` interface | **Yes — the only role that can** |

---

## 8. Audit trail

**Every decision must be explainable as: why raised, why accepted, why rejected** — this
is not a new mechanism so much as a discipline already proven in 4B (`ObjectionLedgerEntry.history`,
`MILESTONE4B_DESIGN.md` §6.2: "nothing is ever silently overwritten without a corresponding
history entry") extended to cover the two new surfaces Milestone 5 adds: evidence/confidence
and human decisions.

### 8.1 Reconstructing "why" for any claim, mechanically

Given a finished `AuditedReviewResult` (§10), answering each of the task's three questions
is a pure, deterministic lookup — never a re-derivation from raw prompts:

| Question | How it's answered |
|---|---|
| Why was this claim raised? | `ClaimLedgerEntry.history[0]` is always a `RAISED` event (or `PARAPHRASED`/`REOPENED` if it began life as a merge, in which case the merge event names the original) — carries the originating round and, transitively, `claim.rationale`. |
| Why was this claim accepted (resolved)? | The terminal `RESOLVED` event's `resolutionEvidenceRef` resolves to exactly one `Evidence` record of `kind: "RESOLUTION"` — its `text`, `sourceRole`, and `round` are the complete, final answer to "why." |
| Why was this claim rejected? | Same mechanism, terminal `REJECTED` event, `resolutionEvidenceRef` of `kind: "RESOLUTION"` explaining the rejection (e.g., "this is not actually a defect because..."). |
| Why did the run stop where it did? | The final round's `DecisionRecommendation.reason` (§7.4) plus the `HumanGateResponse.rationale` recorded for that round (§6.2) — both are stored, never just the outcome enum alone. |
| Why does this claim's confidence sit where it does? | `confidenceHistory` is a complete, ordered list of every `ConfidenceChangeEvent`, each naming the `EvidenceRef` responsible — replaying it from `0.5` reproduces the final value exactly, so "why" is always mechanically re-derivable, not just asserted. |

### 8.2 The one new non-negotiable rule this milestone adds

**A `REJECT` human decision must carry a non-empty `rationale`.** This is the single
audit-trail requirement Milestone 5 enforces at the type/validation level rather than by
convention (§6.2's `rationale?: string` is optional in the type only because `CONTINUE`/
`ACCEPT` don't require it — the real gate implementation, §6.3, refuses to submit a
`REJECT` response without one). Every other history/evidence event already carries a
mandatory reason string by construction (`Evidence.text`, `ClaimHistoryEvent.detail`,
`DecisionRecommendation.reason`) — `REJECT` is the one place a human could otherwise walk
away with zero explanation, and the design closes that gap deliberately.

---

## 9. Backward compatibility

This section is the enforceable checklist for Milestone 5's own future acceptance review,
in the same spirit as `MILESTONE4B_DESIGN.md` §14's "explicitly untouched" list and this
project's established practice of running `git diff --stat` against named frozen files
before accepting a milestone (as done for Milestone 4B's real-smoke closeout).

**Frozen, byte-for-byte, verified by `git diff` producing no output:**

- `src/orchestration/runFixedReviewLoop.ts`, `src/orchestration/fixedReviewPrompts.ts`
- `src/orchestration/runConvergenceReviewLoop.ts`
- `src/orchestration/convergence/types.ts`, `fingerprint.ts`, `structuredReviewParser.ts`,
  `objectionLedger.ts`, `convergenceEngine.ts`, `convergencePrompts.ts`
- `src/sites/chatgptSite.ts`, `src/sites/claudeSite.ts`, `src/sites/claudeUserTurns.ts`
- `src/browser/domUtil.ts`, `src/browser/discoverSitePages.ts`, `src/browser/launchBrowser.ts`,
  `src/browser/shutdown.ts`
- `src/sites/siteTypes.ts`, `src/sites/selectors/*`
- `scripts/smoke-multi-round.ts`, `scripts/smoke-convergence.ts`, `scripts/start-browser.ps1`
- `src/config/loadConfig.ts`, `config/config.json`
- Every existing test file under `tests/unit/` (all must still pass, unmodified, after
  Milestone 5 code lands — a regression here is a Milestone 5 defect, not an acceptable
  side effect)

**New, additive-only:**

- `package.json` may gain new script entries (e.g. `"smoke:audited-review"`) — existing
  script lines must be byte-identical, exactly the discipline already followed when
  `smoke:convergence` was added in Milestone 4B (a single-line diff, verified).
- A new top-level directory `src/orchestration/claims/` and a new
  `src/orchestration/humanGate/` — never inside `src/orchestration/convergence/`.
- A new `runAuditedReviewLoop.ts`, parallel to (not replacing) `runConvergenceReviewLoop.ts`.

**Explicitly reused by direct import, not copy-paste, where genuinely provider-agnostic:**

- `convergence/fingerprint.ts`'s `normalizeForFingerprint`/`diceCoefficient`/
  `classifyFingerprint` — claim-matching needs the exact same conservative-merge behavior
  4B already proved (`MILESTONE4B_DESIGN.md` §6.5), and reimplementing it would risk
  drifting the two systems' matching behavior apart for no reason. Importing it does not
  modify the source file and does not create a circular dependency (`claims/` depends on
  `convergence/fingerprint.ts`; nothing under `convergence/` ever depends on `claims/`).

**Isolation test required for Milestone 5's own acceptance (§12.4):** a dependency-graph
test asserting no file under `src/orchestration/convergence/` imports anything from
`src/orchestration/claims/` or `src/orchestration/humanGate/` — the dependency arrow only
ever points one way, guaranteeing 4B genuinely cannot be affected by anything Milestone 5
adds.

---

## 10. Data model (consolidated design sketch)

```ts
// design sketch — src/orchestration/claims/types.ts (new module; does not edit
// src/orchestration/convergence/types.ts)

export type ReviewSeverity = "HIGH" | "MEDIUM" | "LOW";              // reused from convergence/types.ts
export type ClaimStatus = "OPEN" | "DISPUTED" | "RESOLVED" | "REJECTED";
export type EvidenceKind = "SUPPORTING" | "CHALLENGING" | "RESOLUTION";
export type EvidenceStrength = "STRONG" | "MODERATE" | "WEAK";
export type EvidenceSourceRole = "GENERATOR" | "REVIEWER" | "EVIDENCE_AGENT" | "HUMAN";

export interface Evidence {
  id: string; claimId: string; kind: EvidenceKind; strength: EvidenceStrength;
  sourceRole: EvidenceSourceRole; text: string; round: number; submittedAt: string;
  supersedesEvidenceId?: string;
}

export interface ConfidenceChangeEvent {
  round: number; previousConfidence: number; newConfidence: number;
  causeEvidenceId: string;
}

export type ClaimHistoryEventKind =
  | "RAISED" | "REPEATED" | "PARAPHRASED" | "RESOLVED" | "REJECTED" | "REOPENED"
  | "IMPLICITLY_CARRIED_OPEN" | "SEVERITY_CHANGED" | "SEVERITY_DOWNGRADE_REJECTED"
  | "DUPLICATE_COLLAPSED"
  | "EVIDENCE_ADDED" | "CONFIDENCE_CHANGED" | "DISPUTED" | "UNDISPUTED"
  | "HUMAN_DECISION_RECORDED";

export interface ClaimHistoryEvent {
  round: number; kind: ClaimHistoryEventKind; detail?: string;
  resolutionEvidenceRef?: string;   // required in practice when kind is RESOLVED|REJECTED (§4.4, §8.2)
}

export interface ClaimLedgerEntry {
  id: string;                          // "CLAIM-<n>"
  claim: { statement: string; rationale: string };
  severity: ReviewSeverity;
  highestSeveritySeen: ReviewSeverity;
  confidence: number;                  // 0..1, derived (§4.2)
  status: ClaimStatus;
  evidenceFor: string[];               // Evidence ids
  evidenceAgainst: string[];           // Evidence ids
  confidenceHistory: ConfidenceChangeEvent[];
  firstSeenRound: number; lastSeenRound: number;
  normalizedFingerprint: string[];      // reused matcher from convergence/fingerprint.ts
  history: ClaimHistoryEvent[];
}

export interface DecisionRecommendation {
  kind: "CONTINUE_RECOMMENDED" | "ACCEPT_RECOMMENDED" | "REJECT_RECOMMENDED";
  round: number; reason: string; cleanStreak: number;
  openHighCount: number; openMediumCount: number; disputedCount: number;
  averageConfidence: number;
}

export type HumanGateOutcome = "CONTINUE" | "ACCEPT" | "REJECT";
export interface HumanGateResponse { outcome: HumanGateOutcome; rationale?: string; decidedAt: string; }

export interface AuditedRoundRecord {
  roundNumber: number;
  reviewerPrompt: string; reviewerRawResponse: string;
  evidenceRequests: { claimId: string; prompt: string; rawResponse: string; parsedEvidenceId?: string }[];
  recommendation: DecisionRecommendation;
  humanGateResponse: HumanGateResponse;   // ALWAYS present — every round is gated (§6.1)
  generatorPrompt?: string; generatorResponse?: string;   // absent when the round's human
                                                            // decision was ACCEPT or REJECT
}

export interface AuditedReviewResult {
  originalTask: string;
  outcome: "ACCEPTED" | "REJECTED";       // never "CONVERGED"/"MAX_ROUNDS_REACHED" — those
                                            // are recommendation-language, not final-outcome
                                            // language, by design (§7.4)
  finalAnswer: string;
  initial: { prompt: string; response: string; startedAt: string; completedAt: string };
  rounds: AuditedRoundRecord[];
  claimLedger: ClaimLedgerEntry[];
  evidenceLog: Evidence[];
  invalidReview?: { round: number; rawText: string; reason: string };
  invalidEvidenceResponses?: { round: number; claimId: string; rawText: string; reason: string }[];
}
```

Every field is plain, JSON-serializable data — no class instances, no functions, no
`Page`/adapter references — continuing 4B §12's persistence-readiness discipline even
though Milestone 5, like 4B, does not write any of it to disk (§13.4).

---

## 11. Round lifecycle (design)

Adapted directly from `MILESTONE4B_DESIGN.md` §5's single-decision-point pseudocode, with
the Evidence Agent and Human Gate steps inserted. The engine still has exactly **one**
computed decision point per round (the Decision Agent, §7.4) — what's new is that this
decision point no longer directly causes a stop or continuation; it only produces input to
the mandatory gate.

```
state: INITIAL_GENERATOR
  → send task to Generator → wait → extract → G0
  → currentAnswer = G0; round = 1

state: ROUND(r)
  → build Reviewer prompt from (task, currentAnswer, OPEN+DISPUTED claim ledger summary)
  → send to Reviewer → wait → extract → rawReview
  → parse rawReview (claims/structuredClaimParser.ts, extends 4B's grammar)
  → if parse fails: record INVALID_REVIEW-shaped failure, claim ledger untouched this round,
        recommendation := "CONTINUE_RECOMMENDED" with reason citing the parse failure,
        still proceed to the human gate below (a human may still choose to REJECT here,
        e.g. if repeated parse failures suggest the run itself is unproductive)
  → ingest parsed claims into the Claim Ledger (extends 4B §6.3's ingest table with
        evidence/confidence bookkeeping, §4)
  → for each claim entering/already in DISPUTED, or explicitly flagged by the prior
        round's human response: fire an Evidence Agent turn (§5.3), ingest resulting
        Evidence, recompute confidence (§4.2) and DISPUTED status (§4.3)
  → Decision Agent computes a DecisionRecommendation (§7.4) — never acts on it directly
  → ════ HUMAN GATE (§6) — always fires, every round ════
        present: claim ledger delta, disputed claims, recommendation + reason, currentAnswer
        human responds: CONTINUE | ACCEPT | REJECT (+ mandatory rationale on REJECT)
  → act strictly on the human's HumanGateResponse, never on the recommendation alone:
        ACCEPT  → STOP, outcome = "ACCEPTED", finalAnswer = currentAnswer
        REJECT  → STOP, outcome = "REJECTED", finalAnswer = currentAnswer (returned for
                   reference only — a rejected run's answer is not "the result," it is
                   "the answer as of rejection," and callers must treat it accordingly)
        CONTINUE → build Generator revision prompt (reusing 4B's revision-prompt shape,
                   §11 of MILESTONE4B_DESIGN.md, extended with claim/evidence context)
                   → send to Generator → wait → extract → Gr
                   → currentAnswer = Gr; round = r + 1; repeat
```

Two structural differences from 4B's lifecycle are worth naming explicitly:

1. **There is no `maxRounds` safety bound removed by this design — it is still needed and
   still enforced**, but it now manifests differently: reaching a configured round bound
   without a human `ACCEPT`/`REJECT` does not autonomously stop the run (that would be an
   engine-decided outcome, forbidden by §6.4) — instead it becomes part of the
   `DecisionRecommendation.reason` presented at the gate (e.g., "round budget exhausted —
   recommend REJECT or manual override"), and the human is the one who must actually stop
   it. This preserves 4B's safety-bound *intent* (a run must not loop forever unsupervised)
   while preserving Milestone 5's core rule that only a human finalizes an outcome.
2. **`INVALID_REVIEW`/malformed-evidence conditions no longer silently terminate the
   run** (contrast 4B §9, where `INVALID_REVIEW` is itself a terminal `stopReason`) —
   they become recommendation input, and the human decides whether to continue, reject, or
   (in an implementation detail left open, §13.3) request a re-elicitation. This is a
   deliberate, named departure from 4B's behavior, justified by the fact that Milestone 5
   has a human present every round to make exactly this judgment call, whereas 4B's smoke
   script (§9 of `MILESTONE4B_DESIGN.md`) explicitly did not.

---

## 12. Testing strategy

### 12.1 Unit tests (offline, pure functions, no Playwright)

Following 4B's proven pattern (`tests/unit/structuredReviewParser.spec.ts`,
`objectionLedger.spec.ts`, `convergenceEngine.spec.ts`) exactly:

| New test file | Covers |
|---|---|
| `tests/unit/structuredClaimParser.spec.ts` | Sentinel/JSON grammar for claims (extends 4B's parser test matrix with the new claim-ledger fields); every malformed-input case produces `{ invalid: true, reason }`, never a partial claim. |
| `tests/unit/claimLedger.spec.ts` | Claim ingest rules (§4.1's mapping table), reused fingerprint-matching behavior via direct import (confirm identical merge/split behavior to `objectionLedger.spec.ts`'s equivalent cases), `DISPUTED` band transitions (§4.3), severity floor/reject rules reused unchanged from 4B. |
| `tests/unit/evidence.spec.ts` | `Evidence` record creation/immutability, `EvidenceRef` resolution, the confidence update rule's three required invariants (§4.2: boundedness, symmetry, no-silent-overwrite) as explicit property-style tests (e.g. generate paired supporting/challenging evidence of equal strength on two otherwise-identical claims, assert equal-and-opposite confidence movement). |
| `tests/unit/decisionAgent.spec.ts` | `DecisionRecommendation` computation for each `RecommendationKind`, confirming it is pure (same input ledger → same output every time) and that it never mutates the ledger it's given. |
| `tests/unit/humanGate.spec.ts` | The `HumanGate` interface contract using a fake, scripted implementation; confirms a `REJECT` response without a `rationale` is rejected by the fake's own validation (mirroring the real terminal implementation's re-prompt behavior, §6.3) — this is the one test that specifically defends §8.2's non-negotiable rule. |
| `tests/unit/runAuditedReviewLoop.spec.ts` | Full-loop integration using fake in-memory `ConversationalSiteAdapter`s (4A/4B's pattern) **and** a fake, scripted `HumanGate` returning a pre-programmed sequence of `CONTINUE`/`ACCEPT`/`REJECT` responses — covering: a run that a human accepts on round 1 despite a computed `CONTINUE_RECOMMENDED` (override), a run a human rejects with a rationale, a run where the human continues past several rounds, and confirmation that **no outcome is ever set without a corresponding `HumanGateResponse` recorded in that round's `AuditedRoundRecord`**. |
| `tests/unit/claimsIsolation.spec.ts` | Mirrors 4B's isolation test (§9): asserts no file under `src/orchestration/convergence/` imports anything from `src/orchestration/claims/` or `humanGate/`, and that `claims/`/`humanGate/` themselves contain no `playwright` import or `Page` reference outside `runAuditedReviewLoop.ts`. |

### 12.2 Simulation tests (offline, multi-round scripted scenarios)

A step up from per-function unit tests: full scripted runs (still using fake adapters and
a fake gate, no browser) exercising realistic multi-round sequences end-to-end, analogous
to how 4B's `runConvergenceReviewLoop.spec.ts` already includes "the four explicit
state-machine sequence tests" (`MILESTONE4B_DESIGN.md` §15). New scenarios specific to
Milestone 5:

- A claim raised, challenged (moves to `DISPUTED`), evidence resolves it toward
  `RESOLVED` with a full audit trail reconstructable per §8.1's table — assert every
  lookup in that table actually resolves for this scripted run.
- A human overrides an `ACCEPT_RECOMMENDED` into `CONTINUE` three rounds running, then
  finally accepts — confirm the recommendation is logged every round even when overridden,
  so the audit trail shows the AI's advice was available and what the human chose instead.
- A `REJECT` mid-run — confirm the run stops immediately, no further Generator/Reviewer
  turns are sent afterward (reusing 4A/4B's "no duplicate/extra send" verification style),
  and the rejection rationale is present in the final `AuditedReviewResult`.
- A malformed Reviewer response followed by a human choosing to `CONTINUE` anyway (per
  §11's departure from 4B) — confirm the next round proceeds normally and the failed round
  is still visible in the audit trail as its own recorded event, not silently dropped.

### 12.3 Real browser tests (manual, not part of the automated suite)

A new `scripts/smoke-audited-review.ts` + `npm run smoke:audited-review`, mirroring
`scripts/smoke-convergence.ts`'s established safety pattern exactly: CDP-connect only
(`chromium.connectOverCDP`), discover existing ChatGPT/Claude tabs via
`discoverSitePages`, assert both are fresh/blank before proceeding, never launch/close/
navigate, print a clear pass/fail summary, never retry a send. The one genuinely new
requirement: **this script requires an actual human at the terminal to respond to the
gate at least once** — it is not runnable unattended, and that is the point (§6.4). It
must not be added to `npm test` or any CI-style automated command, exactly like
`smoke:convergence` and `smoke:multi-round` are excluded today.

### 12.4 Compatibility/regression checks (part of Milestone 5's own acceptance, not ongoing CI)

- `git diff --stat` against every file listed in §9's frozen list must show no output,
  exactly as already practiced when Milestone 4B's real-smoke closeout was verified.
- All existing `tests/unit/*.spec.ts` files (133 tests as of Milestone 4B's closeout) must
  still pass, unmodified, after Milestone 5's new files are added.
- `npm run build` and `npm test` must both pass with Milestone 5's new files present,
  exactly as required before every milestone closeout in this project's established
  practice (`DECISIONS.md` §11e, §11f).

---

## 13. Open questions (explicitly deferred, not decided here)

1. **Should the Evidence Agent ever be backed by real external retrieval** (web search, a
   documents connector, a citation-checking service) rather than model-elicited
   justification only? This would require new integration code (though not necessarily a
   new browser tab) and is deliberately out of scope for Milestone 5 (§1).
2. **Should the Decision Agent ever become LLM-backed** (a third model call synthesizing a
   recommendation in prose) rather than a deterministic function over ledger counts? Named
   in §7.4 as a future option; not built now, specifically because it would make Decision
   Agent behavior harder to audit — in tension with this milestone's own goal.
3. **Should a malformed Reviewer/Evidence response support a bounded, explicitly-logged
   re-elicitation** (a new logical turn kind, not a resend of the same turn — reusing 4B
   §9's own stated constraint on any future repair mechanism) rather than always falling
   through to the human gate? Left open; §11 point 2 describes the fallback behavior this
   design does implement, without ruling out a future refinement.
4. **Should Milestone 5 introduce actual persistence** (`runs/<run-id>/`, per
   `PHASE2_DESIGN.md` §7 and `MILESTONE4B_DESIGN.md` §12)? An auditable system arguably
   wants durability beyond one process's memory more urgently than 4B did — but adding a
   persistence layer is a substantial, separable concern with its own failure modes (partial
   writes, concurrent runs, schema versioning) that deserves its own design pass rather than
   being folded silently into this one. Recommendation for whoever scopes implementation:
   treat persistence as **Milestone 5's first immediate follow-up**, not part of Milestone 5
   itself, and reuse this document's JSON-serializable data model (§10) directly when it is
   built.
5. **Should the human gate ever support asynchronous approval** (a written-to-disk pending
   decision file, a Slack/email approval step) instead of a synchronous blocking terminal
   prompt? Deferred — §6.3 designs only the synchronous terminal gate, which is the
   minimal mechanism that satisfies "mandatory, cannot be bypassed" without any new
   external dependency.

---

## 14. File / module plan

**New files (none created by this design turn — design only, per the task's explicit
instruction):**

- `src/orchestration/claims/types.ts` (§10)
- `src/orchestration/claims/claimLedger.ts` (§4, §6.3-equivalent ingest rules extended with
  evidence/confidence bookkeeping)
- `src/orchestration/claims/evidence.ts` (§5 — evidence record creation, confidence update
  rule, `DISPUTED` band classification)
- `src/orchestration/claims/decisionAgent.ts` (§7.4)
- `src/orchestration/claims/claimPrompts.ts` (§5.3, §7.2 — Reviewer/Evidence Agent prompt
  builders, pure string functions like `convergencePrompts.ts`)
- `src/orchestration/claims/structuredClaimParser.ts` (§7.2, §5.3 — extends 4B's grammar)
- `src/orchestration/humanGate/humanGate.ts` (§6.2 — the `HumanGate` interface plus the
  real blocking-terminal implementation, §6.3)
- `src/orchestration/runAuditedReviewLoop.ts` (§3.2, §11 — the sole new file that touches
  `Page`/adapters/the gate)
- `scripts/smoke-audited-review.ts` + `npm run smoke:audited-review` (§12.3)
- `tests/unit/structuredClaimParser.spec.ts`, `claimLedger.spec.ts`, `evidence.spec.ts`,
  `decisionAgent.spec.ts`, `humanGate.spec.ts`, `runAuditedReviewLoop.spec.ts`,
  `claimsIsolation.spec.ts` (§12.1)

**Explicitly untouched (§9's full list, restated here for the file-plan's own
completeness):** every file under `src/orchestration/convergence/`,
`runFixedReviewLoop.ts`, `fixedReviewPrompts.ts`, every file under `src/sites/` and
`src/browser/`, `scripts/smoke-multi-round.ts`, `scripts/smoke-convergence.ts`,
`scripts/start-browser.ps1`, `src/config/loadConfig.ts`, `config/config.json`, and every
existing test file.

---

## 15. Revision history

**First draft (this document).** No prior Milestone 5 design existed to revise. Written
after inspecting the current repository structure, the full Milestone 4A/4B implementation
(all files under `src/orchestration/`), and `TODO.md`/`DECISIONS.md`/`REVIEW.md`'s recorded
Milestone 4B closeout. No implementation performed; this document is design-only, per the
task's explicit instruction.
