# MILESTONE7A_DUAL_AI_CONVERSATION_ENGINE_DESIGN.md — Dual AI Conversation Engine

Design-only document. **No production code is written by this document.** Grounded in the
actual repository, not just prior design docs: `src/orchestration/runAuditedReviewLoop.ts`,
`src/orchestration/claims/claimPrompts.ts`, and the 6A/6B supervisor stack were all read
directly before writing this. Milestone 7.1 (CLI, README, Ollama compatibility bridge) is
treated as shipped and unaffected — this milestone reuses its CLI, does not replace it.

---

## 0. What this milestone actually is

Every piece this milestone needs — a GPT Generator, a Claude Reviewer, a deterministic Claim
Ledger, a deterministic Decision Agent, a Human Gate, an advisory JEV Supervisor (deterministic
6A, optionally LLM-audit-augmented 6B), and a full audit trail — **already exists and already
works together**, exercised today by `scripts/smoke-supervised-review.ts` and
`scripts/smoke-augmented-review.ts`. Milestone 7A is not a new orchestration engine. It is:

1. **A name and a formal shape** for the flow those scripts already exercise ad hoc, so the
   product has one documented, reusable "Dual AI Conversation Engine" entry point instead of
   five parallel smoke scripts a user has to compare (Milestone 7's own §1 finding).
2. **A product-facing state projection** (`ConversationState`) so the CLI can show live
   round-by-round progress, not just a final report.
3. **A formal schema for JEV's existing output** (`JevConvergenceSignal`), so "JEV-controlled
   convergence" is realized precisely: JEV's cross-round pattern flags become a first-class,
   always-visible signal at every decision point — **never a new decision authority.**

That last point is stated explicitly because it resolves a real tension in how this milestone
was framed. §1's constraint list requires keeping the Human Gate, Decision Agent, and existing
orchestration boundaries exactly as they are — and every prior design/review round in this
project (six revisions, across Milestones 6A and 6B) established, as a hard invariant, that
JEV is advisory-only and can never gate an outcome. "JEV-controlled convergence" is therefore
designed here as *JEV's signal becoming integral to how convergence is judged and displayed*,
not as JEV acquiring authority over CONTINUE/ACCEPT/REJECT. Where those two readings could be
confused, this document states explicitly which one applies.

---

## 1. Architecture diagram

```
                     CLI  (src/cli/index.ts — Milestone 7.1, unchanged)
                                    |
                                    v
        Dual AI Conversation Engine  (NEW — src/orchestration/conversationEngine.ts,
                                       a thin composition facade, not a new control flow)
                                    |
        ------------------------------------------------------------------------
        |                    |                    |                            |
   GPT Generator        Claude Reviewer      Claim Ledger              Decision Agent
   (EXISTING adapter,   (EXISTING adapter,   (EXISTING, frozen,        (EXISTING, frozen,
    chatgptSite.ts)      claudeSite.ts)       claimLedger.ts)           decisionAgent.ts)
        |                    |                    |                            |
        ------------------------------------------------------------------------
                                    |
                     runAuditedReviewLoop  (EXISTING, frozen — the actual
                                    |        per-round control flow; Milestone 5)
                                    v
              JEV Supervisor  (EXISTING, frozen — 6A deterministic, optionally
                    |           6B LLM-audit-augmented; wraps the Human Gate;
                    |           real-time advisory assessment BEFORE each decision)
                    v
          Supervised Human Gate  ──────────────►  Human  (terminal, via CLI)
                    |
                    v
        AuditedReviewResult + (if 6B enabled) AugmentedSupervisedReviewResult
                    |
                    v
      ConversationState projection  (NEW — src/orchestration/conversationState.ts,
                                      a pure, read-only snapshot; not a second source
                                      of truth) ──► CLI live progress rendering
```

**Nothing inside the two "EXISTING, frozen" boxes changes.** The entire new surface is the
top box (a composition facade) and the bottom box (a read-only projection for rendering).

---

## 2. Data structures

### 2.1 `ConversationState` — the conversation state model

A pure, derived snapshot, recomputable at any point from data the existing pieces already
produce — never itself a source of truth the engine reads back from.

```ts
// design sketch — src/orchestration/conversationState.ts (new)
export interface ConversationState {
  task: string;
  round: number;
  hardMaxRounds: number;
  currentAnswer: string;
  claimSummary: { openHigh: number; openMedium: number; openLow: number; disputed: number };
  latestRecommendation?: DecisionRecommendation;   // reused by reference, never redefined
  latestJevSignal?: JevConvergenceSignal;          // §2.2
  status: "in_progress" | "awaiting_human" | "complete";
  finalOutcome?: HumanGateOutcome;                 // set only when status === "complete"
}

export function deriveConversationState(
  base: Pick<AuditedReviewResult, "originalTask" | "rounds" | "outcome"> & { hardMaxRounds: number },
  latestJevSignal: JevConvergenceSignal | undefined,
): ConversationState {
  // Pure function: reads the last AuditedRoundRecord's claimLedgerDelta/recommendation and
  // the ledger's own open-claim counts (already computed by the Decision Agent — never
  // recomputed here), and the current answer. No new judgment is introduced.
}
```

### 2.2 `JevConvergenceSignal` — the JEV decision schema

A formal, documented, rendering-facing projection of the *existing* `SupervisorAssessment` /
`SupervisorUnavailable` types (`src/orchestration/supervisor/types.ts`, frozen, read by
import only):

```ts
// design sketch — src/orchestration/conversationState.ts (new)
export type JevRiskLevel = "none" | "advisory" | "elevated";

export type JevConvergenceSignal =
  | { available: true; flags: SupervisorFlagKind[]; riskLevel: JevRiskLevel; detail: string[] }
  | { available: false; reason: string };

export function toJevConvergenceSignal(
  assessment: SupervisorAssessment | SupervisorUnavailable,
): JevConvergenceSignal {
  if ("unavailable" in assessment) return { available: false, reason: assessment.reason };
  const riskLevel: JevRiskLevel =
    assessment.escalationRecommended ? "elevated"
    : assessment.flags.length > 0 ? "advisory"
    : "none";
  return {
    available: true,
    flags: assessment.flags.map((f) => f.flag),
    riskLevel,
    detail: assessment.flags.map((f) => f.detail),
  };
}
```

`riskLevel` is a **pure, deterministic relabeling** of fields `SupervisorAssessment` already
carries — `toJevConvergenceSignal` introduces no new judgment, no new threshold, and no new
data source. This is what makes it safe to call "JEV's decision schema" without contradicting
JEV's advisory-only status: it is a *presentation* schema over an existing advisory output.

### 2.3 Round Controller input/output — thin wrappers, not new contracts

```ts
// design sketch — src/orchestration/conversationEngine.ts (new)
export interface ConversationEngineInput {
  originalTask: string;
  chatgpt: AuditedReviewLoopSite;      // reused type, unchanged
  claude: AuditedReviewLoopSite;       // reused type, unchanged
  humanGate: HumanGate;                // reused type, unchanged — e.g. the CLI's terminal gate
  options?: AuditedReviewLoopOptions;  // reused type, unchanged
  jev?: { mode: "deterministic" } | { mode: "llm-audit"; /* 6B config, §6 */ };
  onStateChange?: (state: ConversationState) => void;   // optional, for live CLI rendering
}

export type ConversationEngineResult = SupervisedReviewResult | AugmentedSupervisedReviewResult;

export function runDualAiConversation(input: ConversationEngineInput): Promise<ConversationEngineResult>;
```

`runDualAiConversation` does exactly what `smoke-supervised-review.ts`/
`smoke-augmented-review.ts` already do by hand: construct
`createDeterministicSupervisor()` (or the 6B augmented stack), wrap `input.humanGate` with
`createSupervisedHumanGate(...)`, call the real, unmodified `runAuditedReviewLoop(...)`, and
assemble the result — with an added `onStateChange` hook invoked once per round via
`deriveConversationState`. It contains no round-loop logic of its own.

---

## 3. Execution sequence

Grounded directly in `claimPrompts.ts`/`runAuditedReviewLoop.ts` — this is the actual,
existing flow, formalized, not a new one:

1. **Round 0 (initial).** Generator (GPT) produces the initial answer to `originalTask`. No
   claims exist yet.
2. **Round N (N = 1, 2, …), per round:**
   1. **Reviewer (Claude)** receives the task, the latest answer, and the current claim
      ledger (empty on round 1). It classifies claims only — resolved, still-open, reopened,
      new, each with severity and rationale — in a strict structured format. It never makes a
      convergence, accept, or reject judgment itself.
   2. **Claim Ledger** deterministically ingests the structured review: updates status,
      confidence (fixed steps per evidence strength), `DISPUTED` detection on conflicting
      evidence, full history — no judgment calls, purely mechanical state transitions.
   3. **Decision Agent** deterministically evaluates the updated ledger and round counters
      (seven fixed-priority branches) and produces a `DecisionRecommendation`
      (CONTINUE / ACCEPT / REJECT recommended), with disputed claims, ledger delta, and legal
      outcomes for this round.
   4. **JEV Supervisor** assesses the accumulated cross-round pattern (this round's
      recommendation plus prior rounds' human outcomes) — `STAGNATION`,
      `DECISION_INCONSISTENCY`, `ABNORMAL_WORKFLOW` — **before** the human sees the gate (the
      as-built 6A behavior). Its `JevConvergenceSignal` projection (§2.2) is computed and
      passed to `onStateChange` alongside the recommendation.
   5. **Human Gate** presents the recommendation, disputed claims, ledger delta, relevant
      evidence, legal outcomes, and JEV's advisory banner. The human decides CONTINUE / ACCEPT
      / REJECT (REJECT requires a rationale), optionally attaching evidence. **This is the
      only point in the entire sequence with authority over the outcome.**
   6. **If CONTINUE:** Generator (GPT) revises its **complete** answer addressing every
      blocking (HIGH/MEDIUM/DISPUTED) claim, given the reviewer's raw response and the
      specific evidence — explicitly instructed not to make its own convergence/accept/reject
      judgment. Round increments; loop to step 1.
   7. **If ACCEPT, REJECT, or a hard-ceiling/invalid-review-streak forced termination:** the
      loop ends. `AuditedReviewResult` is finalized with its full audit trail; if 6B is
      enabled, its audit-only records are assembled alongside `base` — never altering it.
3. `deriveConversationState` runs after every round (status `"in_progress"` mid-loop,
   `"awaiting_human"` while the gate is open, `"complete"` once terminated), feeding
   `onStateChange` for live CLI rendering.

### Responsibilities, stated as a boundary table

| Role | Produces | Never does |
|---|---|---|
| Generator (GPT) | Initial answer; per-round complete revisions addressing blocking claims | Classify claims, judge convergence, accept/reject |
| Reviewer (Claude) | Structured claim classifications with severity + rationale | Free-form critique outside the schema, revise the answer, accept/reject |
| Claim Ledger | Deterministic claim/evidence/confidence bookkeeping | Any judgment call — purely mechanical |
| Decision Agent | Deterministic CONTINUE/ACCEPT/REJECT recommendation | Anything non-deterministic; never consults an LLM |
| JEV Supervisor | Advisory cross-round pattern flags + the `JevConvergenceSignal` labeling | Modify the recommendation, the ledger, or the outcome; gate anything |
| Human | The final ACCEPT/REJECT/CONTINUE decision, every round | — final authority, structurally cannot be bypassed |

### Human intervention points

1. **Every round's Human Gate presentation** — the primary, existing intervention point:
   ACCEPT, REJECT (with rationale), or CONTINUE, with optional evidence attachment.
2. **Process-level abort between rounds** (Ctrl+C) — already works today with no new code,
   since nothing currently traps process termination. Documented here as the accepted
   "outside-the-schema" intervention rather than building new pause/resume state, per
   Milestone 7's own conservatism about avoiding unnecessary complexity.
3. **Explicitly deferred:** a formal `PAUSE` outcome or mid-round abort. Not part of this
   milestone's minimal plan — a candidate for a later milestone only if real usage shows the
   two points above are insufficient.

---

## 4. Risks

- **A sixth entry point, if not handled carefully.** Milestone 7's own §1 flagged five
  parallel orchestration entry points as technical debt. Adding `runDualAiConversation`
  without retiring the ad hoc wiring in `smoke-supervised-review.ts`/
  `smoke-augmented-review.ts` as the *documented* path would make this worse, not better.
  Mitigation: the CLI (§6) calls `runDualAiConversation` exclusively; the smoke scripts remain
  as regression-test fixtures for 6A/6B, not as user-facing documentation.
- **`ConversationState` drifting into a second source of truth.** If `onStateChange` state is
  ever cached and read back into a decision instead of purely rendered, the single-authority
  guarantee weakens. Mitigation: `deriveConversationState` must stay a pure projection
  function with no persisted, mutable copy the engine itself consults.
- **Perception risk on `JevConvergenceSignal`.** Labeling JEV's output with a `riskLevel`
  makes it more visible and more product-facing — which is the goal — but also more likely to
  be misread over time as "JEV's real decision" rather than an advisory label. Mitigation: the
  CLI rendering must visually mark it `[advisory]` wherever shown, matching the discipline
  already established for 6B's LLM-sourced flags.
- **Demo-length risk.** `runAuditedReviewLoop`'s existing defaults (`hardMaxRounds: 10`) were
  tuned for thoroughness, not for a short, convincing product demo. Not a design change — a
  configuration choice to revisit during implementation.
- **Provider scope.** Provider expansion is explicitly postponed; JEV (6A/6B) has only ever
  been built and tested against the browser adapters. `runDualAiConversation` should be scoped
  to the browser provider for this milestone; the CLI's existing `--provider ollama` path
  (Milestone 7.1) is unaffected and continues to bypass the conversation engine until a later
  milestone revisits provider-JEV integration.

---

## 5. Frozen list — nothing below this line changes

`src/orchestration/runAuditedReviewLoop.ts`, `src/orchestration/humanGate/humanGate.ts`,
every file under `src/orchestration/claims/` (`claimLedger.ts`, `decisionAgent.ts`,
`claimPrompts.ts`, `structuredClaimParser.ts`, `types.ts`), every file under
`src/orchestration/supervisor/` including the 6B `llm/` module, `src/sites/claudeSite.ts`,
`src/sites/chatgptSite.ts`, `src/config/loadConfig.ts`, the Milestone 7.1 CLI's existing
provider/argument-parsing code. This milestone only adds two new files (§2.1, §2.3) and wires
the CLI to call the new facade instead of assembling the pieces by hand.

---

## 6. Minimal implementation plan

**Phase 7A.1 — Round Controller facade + state projection (pure composition, zero new
orchestration logic):**
- New: `src/orchestration/conversationEngine.ts` (§2.3) — composes existing
  `createDeterministicSupervisor`/`createAugmentedSupervisor` + `createSupervisedHumanGate` +
  the real, unmodified `runAuditedReviewLoop`, exactly as the existing smoke scripts already
  do, as a reusable, documented function.
- New: `src/orchestration/conversationState.ts` (§2.1, §2.2).
- Acceptance: a unit test constructing `runDualAiConversation` with fake adapters/gate
  produces byte-identical `base`/`supervisorAssessments` output to calling
  `runAuditedReviewLoop` + `createSupervisedHumanGate` directly — proving the facade adds
  nothing, changes nothing.

**Phase 7A.2 — CLI integration:**
- Wire `src/cli/index.ts` (Milestone 7.1) to call `runDualAiConversation` for the browser
  provider, with `jev: { mode: "deterministic" }` enabled by default.
- Extend the terminal renderer to show `latestJevSignal` alongside the recommendation, marked
  `[advisory]`.
- Acceptance: `npm run review -- --provider browser` shows JEV's advisory signal at every
  round without changing what decision the human is asked to make.

**Phase 7A.3 — Live progress polish (optional, only if 7A.1/7A.2 land cleanly):**
- Stream `ConversationState` to the terminal as each round completes, via `onStateChange`,
  instead of only at final-report time.
- Acceptance: a running review shows round-by-round progress lines, not just a final dump.
