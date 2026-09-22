# MILESTONE6_JEV_DESIGN_v3.md — JEV Supervisor Layer

Design-only document for Phase 2A Milestone 6. **No production TypeScript is changed or
written by this document.** This revision **replaces** the architecture in
`MILESTONE6_JEV_DESIGN.md`/`MILESTONE6_JEV_DESIGN_v2.md` after review found that the
prior design — a new, parallel `runSupervisedReviewLoop.ts` orchestrator reproducing
Milestone 5's round-loop control flow — was effectively a **post-hoc** supervisor rather
than a genuine real-time advisory: it necessarily re-derived Milestone 5's own decision
plumbing in a second, separate code path rather than observing the *actual, live* call
Milestone 5's orchestrator makes to its Human Gate. This revision fixes that by injecting
JEV as a **decorator around the `HumanGate` interface itself**, via the same dependency-
injection point `runAuditedReviewLoop.ts` already uses — requiring no new orchestrator, no
reproduction of Milestone 5's control flow, and no change to either frozen file.

---

## Revision history

**v3 (this revision) — replaces the entire architectural approach, not a patch:**

1. **The new parallel orchestrator (`runSupervisedReviewLoop.ts`) is dropped entirely.**
   It is **replaced**, not deprecated — no code implementing it was ever written (every
   prior revision of this document was explicitly design-only), so there is nothing to
   keep around as legacy. §12 states this disposition precisely.
2. **JEV is now injected as a decorator implementing Milestone 5's own `HumanGate`
   interface**, constructed *outside* both frozen files and passed to
   `runAuditedReviewLoop()`'s own, pre-existing `humanGate` input parameter — the same
   dependency-injection slot Milestone 5 already uses to swap `createTerminalHumanGate()`
   for a fake in tests (`MILESTONE5_DESIGN_v5.md` §6.6). `runAuditedReviewLoop()` itself is
   now **called directly, unmodified** — not re-implemented — which is what makes this a
   genuinely real-time advisory: JEV runs inside the actual, live call Milestone 5's own
   loop makes to open the gate, not a second, separately-derived copy of that moment (§3).
3. **The input contract is now self-contained**, computed entirely from the sequence of
   `HumanGatePresentation` objects and gate responses the wrapper itself observes over
   time — it needs no external feed of Milestone 5's internal `runAuditTrail`, because
   every signal JEV's rules need (including the two `RunAuditEventKind`-equivalent
   triggers) is either already present on `HumanGatePresentation` or independently,
   provably derivable from data the wrapper already has (§4, §6.4).
4. **Reproduced logic shrinks from "the entire round-loop control flow" (four named
   mechanisms in v2 §10.5) to two small, pure, independently-testable comparisons**
   (`recommendationAgreement` and a hard-ceiling-override inference), both of which are
   mathematically provable restatements of Milestone 5's own documented boolean
   conditions, not independent re-implementations of stateful logic (§3.3, §10).
5. **Testing strategy is correspondingly simplified**: the "base-result parity test"
   required by every prior revision — needed only because two independent orchestrators
   existed — is no longer meaningful, because there is now exactly one orchestrator,
   called directly. It is replaced by a true end-to-end integration test using the real,
   unmodified `runAuditedReviewLoop()` (§11).

**Explicitly preserved from every prior revision:** JEV does not replace the Decision
Agent, the Claim Ledger, the Reviewer, or the Generator (§5); JEV cannot bypass the Human
Gate, under any failure mode, including its own (§9); JEV's advisory-only nature, its
escalation-recommendation-may-influence-a-human acknowledgment (§5.2), the deterministic
rules and their worked example (§6), the tightened structured-state-only input contract
(§4), and the deferred, still-flagged 6B conversation-isolation concern for the optional
LLM adapter (§7) are all unchanged in substance.

---

## 0. Inspection summary and the one load-bearing assumption

Every fact from `MILESTONE5_DESIGN_v5.md` restated in prior revisions still holds. This
revision adds one new, critical piece of inspection that the entire design now depends on:

**Load-bearing assumption, stated explicitly so it is verified, not assumed away:**
`runAuditedReviewLoop.ts`'s exported entry point must accept its `HumanGate` instance as
an **injected input parameter** (mirroring exactly how `runConvergenceReviewLoop.ts`
injects its `chatgpt`/`claude` `ConversationalSiteAdapter`s, and how Milestone 5's own
`FakeHumanGate` isolation rules (`MILESTONE5_DESIGN_v5.md` §6.6) already depend on the
Human Gate being swappable at the call site, not hardcoded inside the orchestrator). This
is not a new requirement Milestone 6 is asking Milestone 5 to satisfy — it is a
description of a dependency-injection pattern **every prior milestone in this project
already establishes and relies on** for its own testing story. Confidence that this holds
is high, precisely because Milestone 5's own `tests/unit/humanGate.spec.ts` and
`runAuditedReviewLoop.spec.ts` (per `MILESTONE5_DESIGN_v5.md` §15.1) could not exist in
their described form otherwise. **It has not, however, been re-confirmed against the
actual frozen source as part of this review pass**, and the entire architecture below
depends on it. This is named as the first, mandatory verification step before any
Milestone 6 code is written (§13).

---

## 1. Goal / Non-goals

**Goal:** inject JEV's advisory assessment into the exact, real-time moment
`runAuditedReviewLoop.ts`'s own per-round logic opens the Human Gate — not a
retrospective analysis of a finished run, and not a second, separately-executed copy of
Milestone 5's decision plumbing. This is achieved by making JEV a decorator around the
`HumanGate` interface itself, constructed once by a thin entry point and handed to the
real, unmodified `runAuditedReviewLoop()` as its `humanGate` dependency.

**Non-goals (unchanged from v2, restated for self-containment):** no changes to Milestone
4A, 4B, or 5; no new browser/adapter code; JEV never computes, overrides, or influences
`legalOutcomes`, `hardSafetyOverride`, `recommendationAgreement`, the Decision Agent's
`DecisionRecommendation`, or any Claim Ledger mutation; no persistence; no LLM-backed
Supervisor by default (§7 remains an optional, deferred alternative implementation of the
same interface).

**Non-goal added in this revision:** Milestone 6 does not, and must not, need to
reconstruct or re-derive `AuditedReviewResult.runAuditTrail` or any other internal
Milestone 5 state that isn't already visible on `HumanGatePresentation` or in the gate's
own response — if a future rule genuinely needs something not derivable this way, that is
a signal the decorator approach has reached its natural limit and should be flagged as an
open question (§14), not solved by reaching into Milestone 5's internals.

---

## 2. Current state recap (frozen foundation)

Unchanged from prior revisions (`MILESTONE5_DESIGN_v5.md`'s full architecture). One
detail now matters more than it did before and is restated precisely:

```ts
// Milestone 5's own, frozen, unmodified interface (src/orchestration/humanGate/humanGate.ts)
export interface HumanGate {
  presentAndAwaitDecision(presentation: HumanGatePresentation): Promise<HumanGateRawResponse>;
}
export function createTerminalHumanGate(): HumanGate { /* frozen, unmodified */ }
```

`HumanGatePresentation` (§4 recaps its shape) already carries, per round: `round`,
`currentAnswer`, `recommendation: DecisionRecommendation` (including `triggeredBranch`
and every ledger-derived count), `disputedClaims`, `claimLedgerDelta`, `relevantEvidence`,
and `legalOutcomes`. This single object, observed once per round as it flows through the
gate, turns out to be sufficient for everything JEV's rules need (§4, §6.4) — this is the
key realization this revision is built on.

---

## 3. Architecture — decorator around the Human Gate, injected at Milestone 5's own DI point

### 3.1 Diagram (as specified in the review)

```
Decision Agent               (runAuditedReviewLoop.ts, unmodified — computes
      |                       DecisionRecommendation exactly as it always has)
      v
JEV Supervisor                (NEW — src/orchestration/supervisor/deterministicSupervisor.ts,
      |                        called from inside the wrapper below, real-time, per round)
      v
Supervised Human Gate Wrapper  (NEW — src/orchestration/supervisor/supervisedHumanGate.ts,
      |                         a `HumanGate` implementation, nothing more, nothing less)
      v
Original Human Gate            (createTerminalHumanGate(), Milestone 5, unmodified,
                                 invoked by direct delegation — never subclassed, never
                                 reimplemented)
```

### 3.2 The decorator, precisely

```ts
// design sketch — src/orchestration/supervisor/supervisedHumanGate.ts (new module)
export function createSupervisedHumanGate(
  inner: HumanGate,                         // dependency-injected: createTerminalHumanGate()
                                              // in production, a fake in tests — the SAME
                                              // swap point Milestone 5's own tests already use
  supervisor: Supervisor,                    // JEV — deterministic by default (§6), or the
                                              // optional LLM adapter (§7)
  options: { invalidReviewRejectThreshold: number; reopenRejectThreshold: number },
                                              // MUST match the values passed to
                                              // runAuditedReviewLoop()'s own options —
                                              // see §10's configuration-consistency note
): HumanGate & { getAccumulatedAssessments(): SupervisorAssessmentRecord[] } {
  const rounds: SupervisorRoundSignal[] = [];        // built up ONE ENTRY PER REAL CALL,
                                                       // in the exact order
                                                       // runAuditedReviewLoop.ts makes them
  const assessmentRecords: SupervisorAssessmentRecord[] = [];

  return {
    async presentAndAwaitDecision(presentation: HumanGatePresentation): Promise<HumanGateRawResponse> {
      // ── 1. Call the real gate and read its response FIRST. This is what lets the
      //       wrapper infer recommendationAgreement/hardSafetyOverrideInferred (§3.3)
      //       purely from data it already has — no reach into Milestone 5's internals. ──
      const rawResponse = await inner.presentAndAwaitDecision(presentation);

      // ── 2. Build this round's signal from `presentation` + `rawResponse` (§4). ──
      const signal = toSupervisorRoundSignal(presentation, rawResponse);   // pure function
      rounds.push(signal);

      // ── 3. Boundary 1 — assessment (§9.1, unchanged in substance from v2). ──
      let assessment: SupervisorAssessment | SupervisorUnavailable;
      try {
        assessment = await supervisor.assess({ rounds, ...options });
      } catch (error) {
        assessment = { unavailable: true, round: signal.roundNumber, reason: describeError(error) };
      }

      // ── 4. Boundary 2 — rendering (§9.2, unchanged in substance from v2), now recording
      //       a renderingFailure marker directly into the audit record. ──
      let renderingFailure: { reason: string } | undefined;
      try {
        if (!("unavailable" in assessment) && assessment.flags.length > 0) {
          printSupervisorBanner(assessment);
        }
      } catch (renderError) {
        renderingFailure = { reason: describeError(renderError) };
        try { printSupervisorRenderingFailureNotice(renderError); } catch { /* no-op */ }
      }
      assessmentRecords.push({ ...assessment, ...(renderingFailure ? { renderingFailure } : {}) });

      // ── 5. Return exactly what the real gate returned. The wrapper never alters,
      //       delays, or re-derives the human's own actual response. ──
      return rawResponse;
    },
    getAccumulatedAssessments() {
      return assessmentRecords;   // an EXTRA method beyond the HumanGate interface's own
                                   // single method — runAuditedReviewLoop.ts, which only
                                   // knows about `HumanGate`, never calls or needs to know
                                   // this exists; the Milestone 6 entry point (§8) retrieves
                                   // it after the real loop finishes
    },
  };
}
```

**Why the banner is now printed *after* the human has already answered, not before:**
this is a deliberate, important refinement over v1/v2's design, made possible — and
necessary — by the decorator approach. The wrapper does not get to choose *when* the gate
opens or *what* Milestone 5 shows the human; it can only observe the presentation and the
response around a single delegated call. Printing the assessment before delegating would
require either (a) somehow showing it before `inner`'s own presentation is rendered
(impossible without reordering `inner`'s own internal terminal output, which would mean
touching Milestone 5's gate implementation), or (b) deriving the assessment from a
*different* round's data than the one the human is looking at (misleading). Printing it
immediately after the human answers — as a real-time summary of *this exact decision
they just made*, cross-referenced against JEV's cross-round pattern view — is both
architecturally clean (delegate first, observe second) and arguably more useful in
practice: it tells the human "here's what the pattern looked like as of the decision you
just made," available *before the next round begins*, which is still fully real-time
supervision, not a post-hoc report generated after the whole run concludes. §14 names the
alternative (showing it *before* the human decides, which would require Milestone 5 to
expose a pre-gate hook it currently doesn't) as an open question, not solved here.

### 3.3 How `recommendationAgreement` and the hard-ceiling-override signal are derived — without touching Milestone 5's internals

Two small, pure comparisons, each provably equivalent to a boolean expression
`MILESTONE5_DESIGN_v5.md` already documents as Milestone 5's own internal logic — not
independent guesses at what that logic does:

```ts
// design sketch — src/orchestration/supervisor/inference.ts (new, tiny, isolated module)
export function inferRecommendationAgreement(
  recommendationKind: DecisionRecommendation["kind"],
  requestedOutcome: HumanGateOutcome,
): RecommendationAgreement {
  const mapped: HumanGateOutcome =
    recommendationKind === "ACCEPT_RECOMMENDED" ? "ACCEPT"
    : recommendationKind === "REJECT_RECOMMENDED" ? "REJECT"
    : "CONTINUE";
  return requestedOutcome === mapped ? "AGREED" : "OVERRODE";
  // Identical to the mapping MILESTONE5_DESIGN_v5.md §6.5/§7.6 already documents as the
  // orchestrator's own recommendationAgreement computation — restated here, not guessed.
}

export function inferHardSafetyOverride(
  requestedOutcome: HumanGateOutcome,
  legalOutcomes: HumanGateOutcome[],
): boolean {
  return requestedOutcome === "CONTINUE" && !legalOutcomes.includes("CONTINUE");
  // legalOutcomes excludes "CONTINUE" if and only if round >= hardMaxRounds
  // (MILESTONE5_DESIGN_v5.md §6.5) — which is exactly the orchestrator's own Layer-2
  // override trigger condition. This is not a heuristic: by Milestone 5's own documented
  // construction, these two conditions are the same boolean, so this function can never
  // diverge from what the real orchestrator does, short of Milestone 5's own frozen logic
  // itself changing (which it cannot, by definition, since it is frozen).
}
```

Both functions are pure, take only values already present on `presentation`/`rawResponse`,
and are unit-tested directly and in isolation (§11.1) — this is the entirety of the
"duplicated logic" this design requires, a dramatic reduction from every prior revision's
disclosure (§10.1).

---

## 4. Input/output contracts

### 4.1 Input — self-contained, derived entirely from observed gate traffic

```ts
// design sketch — src/orchestration/supervisor/types.ts (new module)
import type {
  DecisionBranch, RecommendationAgreement, HumanGateOutcome,
} from "../claims/types";   // reused BY IMPORT — never redefined

export interface SupervisorRecommendationSignal {   // unchanged from v2 §4.1 — still
                                                       // structurally excludes `reason`
                                                       // and `invalidReview.reason`
  round: number;
  triggeredBranch: DecisionBranch;
  cleanStreak: number;
  openHighCount: number;
  openMediumCount: number;
  disputedCount: number;
  averageConfidence: number;
  lowConfidenceResolutionCount: number;
  invalidReviewStreak: number;
}

export interface SupervisorRoundSignal {
  roundNumber: number;
  recommendation: SupervisorRecommendationSignal;
  recommendationAgreement: RecommendationAgreement;   // wrapper-inferred (§3.3), not fed
                                                        // in externally
  hardSafetyOverrideInferred: boolean;                 // NEW — wrapper-inferred (§3.3);
                                                        // replaces the external
                                                        // `auditEvents` feed v2 required
  outcome: HumanGateOutcome;                           // the actual requestedOutcome the
                                                        // real gate returned this round —
                                                        // now genuinely load-bearing (it is
                                                        // the direct input to both
                                                        // inference functions above),
                                                        // resolving the "unused field" LOW
                                                        // finding from the prior review
}

export function toSupervisorRoundSignal(
  presentation: HumanGatePresentation,
  rawResponse: HumanGateRawResponse,
): SupervisorRoundSignal {
  const recommendation = toSupervisorRecommendationSignal(presentation.recommendation);  // §4.1
                                                                                            // of v2,
                                                                                            // unchanged
  return {
    roundNumber: presentation.round,
    recommendation,
    recommendationAgreement: inferRecommendationAgreement(presentation.recommendation.kind, rawResponse.requestedOutcome),
    hardSafetyOverrideInferred: inferHardSafetyOverride(rawResponse.requestedOutcome, presentation.legalOutcomes),
    outcome: rawResponse.requestedOutcome,
  };
}

export interface SupervisorInput {
  rounds: SupervisorRoundSignal[];    // every round observed so far, in order — no
                                        // separate auditEvents field; §6.4's two
                                        // RunAuditEventKind-equivalent triggers are now
                                        // derived directly from this array (§6.4)
  invalidReviewRejectThreshold: number;
  reopenRejectThreshold: number;
}
```

**Why this is still, and now more robustly, a hard boundary:** every field remains a
number or a member of a small closed enum. Nothing here is fed in from Milestone 5's
internal `runAuditTrail`, `ClaimLedgerEntry[]`, or raw Reviewer/Generator text — not
because Milestone 6 chose to filter it out at the boundary (as in v2), but because the
decorator **structurally cannot see** any of that in the first place; it only ever
receives one `HumanGatePresentation` and one `HumanGateRawResponse` per call, exactly the
same inputs and outputs Milestone 5's own Human Gate contract already exposes.

### 4.2 Output (unchanged from v2 §4.2, plus the recorded rendering-failure marker)

```ts
export type SupervisorAssessmentRecord =
  (SupervisorAssessment | SupervisorUnavailable) & { renderingFailure?: { reason: string } };
```

`renderingFailure` is populated by the wrapper itself (§3.2 step 4) when Boundary 2 fails
— directly closing the audit-completeness gap the prior review found (a rendering failure
is now a first-class, recorded fact, not silently visible only in a terminal print).

---

## 5. Supervisor decision model

### 5.1 Where JEV sits (unchanged from v2 §5.1 — the role table, restated: Generator/Reviewer/Decision Agent unaffected; Supervisor advisory-only; Human Gate the only role that can finalize an outcome)

### 5.2 The one new invariant Milestone 6 adds (unchanged from v2 §5.2, including the explicit advisory-influence acknowledgment)

---

## 6. Deterministic rules (the default, required Supervisor implementation)

### 6.1 Default thresholds (unchanged from v2 §6.1)

### 6.2 Stagnation detection (unchanged from v2 §6.2 — reads `SupervisorRecommendationSignal`, unaffected by this revision)

### 6.3 Decision consistency checking (unchanged formula from v2 §6.3 — now reads the wrapper-inferred `recommendationAgreement` rather than an externally-supplied one; no behavioral difference, since the value is provably identical either way, §3.3)

### 6.4 Abnormal workflow detection — updated: both triggers now self-derived, no external audit-event feed

```
isAbnormalWorkflow(r) :=
     any round i <= r has rounds[i].hardSafetyOverrideInferred === true
  OR any round i <= r (i >= 2) has
       rounds[i].recommendation.triggeredBranch === "INVALID_REVIEW_STREAK"
       AND rounds[i-1].recommendation.triggeredBranch !== "INVALID_REVIEW_STREAK"
                                                          // rising-edge check, computed
                                                          // by JEV directly against its
                                                          // own accumulated `rounds` array
                                                          // — mirroring, not duplicating,
                                                          // MILESTONE5_DESIGN_v5.md §10's
                                                          // own rising-edge logging rule
OR invalidReviewFlapCount(r) >= invalidReviewFlapThreshold
```

`CHRONIC_CLAIM` is not an independent abnormal-workflow trigger. It remains visible
through the structured recommendation signal, but abnormal-workflow escalation is
limited to the three predicates above.

The worked numeric example from v2 §6.4 is unchanged in every respect (the streak
sequence, the cycle-counting logic, the mutual exclusivity of the two disjuncts for any
single cycle) — only the *source* of the first disjunct's trigger has changed, from an
externally-fed `auditEvents` list to a locally-derivable rising-edge check over data the
wrapper already accumulates. The example's numeric trace and conclusions are identical.

### 6.5 Composition (unchanged from v2 §6.5)

---

## 7. Optional LLM-based JEV adapter (Milestone 6B, unchanged from v2 §7)

Unchanged in every respect, including the still-open, still-deferred conversation-
isolation concern the prior review flagged (an LLM-backed adapter reusing an existing
ChatGPT/Claude tab exposes the assessing model to prior raw conversation content, even
though `SupervisorInput` itself remains fully structured). Explicitly out of scope for
Phase 6A.

---

## 8. Audit requirements

### 8.1 Assembly, now performed by a thin entry point after a real run completes

```ts
// design sketch — the Milestone 6 entry point (a new script or small function; not part
// of runAuditedReviewLoop.ts or humanGate.ts)
const supervisedGate = createSupervisedHumanGate(
  createTerminalHumanGate(),   // Milestone 5's real, unmodified factory
  createDeterministicSupervisor(),   // §6, default
  { invalidReviewRejectThreshold, reopenRejectThreshold },   // MUST match the values
                                                               // given to
                                                               // runAuditedReviewLoop
                                                               // below — §10
);

const base: AuditedReviewResult = await runAuditedReviewLoop({
  ...,   // task, adapters, timeouts, options — exactly as any Milestone 5 caller supplies
  humanGate: supervisedGate,   // the ONLY change from an unsupervised call: which
                                // HumanGate implementation is injected
});

const result: SupervisedReviewResult = {
  schemaVersion: SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION,
  base,                                              // Milestone 5's own result, untouched
  supervisorAssessments: supervisedGate.getAccumulatedAssessments(),
};
```

`runAuditedReviewLoop()` is called **directly** — the exact same exported function
Milestone 5 itself exports, with no wrapper, no re-implementation, no second copy of its
control flow. `SupervisedReviewResult`'s shape (`schemaVersion`, `base`,
`supervisorAssessments`) is unchanged from v2 §8.1; only *how* `base` and
`supervisorAssessments` come to exist has changed — `base` is now the literal, unmodified
return value of a real call, and `supervisorAssessments` is read off the wrapper's own
accumulated state after that call resolves.

**`supervisorAssessments.length === base.rounds.length` is now guaranteed by
construction, not by careful test coverage of a duplicated loop:** since the wrapper
pushes exactly one record per real call to `presentAndAwaitDecision`, and
`runAuditedReviewLoop.ts` — by its own, already-tested design — calls its injected
`HumanGate` exactly once per round, this invariant is inherited directly from Milestone
5's own correctness, not re-proven by Milestone 6.

### 8.2 `schemaVersion` design (unchanged from v2 §8.2)

### 8.3 Reconstructing "why JEV escalated" (unchanged from v2 §8.3, `renderingFailure` now directly answerable per §4.2)

---

## 9. Failure handling

Unchanged in substance from v2 §9 (two independent, nested boundaries; the delegated call
to the real gate is deliberately never wrapped). One structural simplification: both
boundaries now live in the **same** function (`presentAndAwaitDecision` on the returned
decorator, §3.2), rather than split across an orchestrator and a separate gate-wrapper
module — there is only one place JEV's own code runs per round, so there is only one
place its failure isolation needs to be defined and tested.

**The resulting, testable invariant, restated precisely for the new architecture:** any
exception that propagates out of `createSupervisedHumanGate(...).presentAndAwaitDecision()`
can only have originated from `inner.presentAndAwaitDecision()` itself — Milestone 5's own
Human Gate — never from `supervisor.assess()` or the banner-rendering step, both of which
are unconditionally caught. §11.1 tests this directly.

---

## 10. Backward compatibility with Milestone 5

### 10.1 Frozen list — zero exceptions (unchanged from v2 §10.1)

### 10.2 New, additive-only files — dramatically smaller than v2's plan

- `src/orchestration/supervisor/types.ts`
- `src/orchestration/supervisor/deterministicSupervisor.ts`
- `src/orchestration/supervisor/inference.ts` (new in this revision — the two small,
  isolated comparison functions, §3.3)
- `src/orchestration/supervisor/supervisedHumanGate.ts` (the decorator, §3.2 — this file
  now does the work `runSupervisedReviewLoop.ts` would have done, in a fraction of the
  code, with none of the duplicated control flow)
- `src/orchestration/supervisor/llmSupervisorAdapter.ts`, `supervisorPrompts.ts` (§7, 6B)
- A thin entry point (a script or small function, §8.1) — **not** a new orchestrator file;
  it contains no round-loop logic of its own, only construction and a single call to the
  real `runAuditedReviewLoop()`

**`runSupervisedReviewLoop.ts` no longer appears anywhere in this plan.** It is not
deprecated (nothing was ever built); it is simply not part of this design going forward.

### 10.3 Isolation test — updated

`tests/unit/supervisorIsolation.spec.ts` — unchanged intent (no file under
`src/orchestration/claims/`, `humanGate/`, `convergence/`, or any Milestone 4A/4B/5 file
imports anything from `src/orchestration/supervisor/`), plus a new, much simpler
assertion this architecture makes possible: **no file under `src/orchestration/supervisor/`
duplicates any function name or logic block that also appears in
`runAuditedReviewLoop.ts`** — checkable now because so little is duplicated (§10.4) that a
simple source-level check is meaningful, where it would not have been meaningful against
v2's much larger reproduced surface.

### 10.4 Duplication disclosure — corrected to reflect the new, much smaller surface

**This section replaces v2 §10.5's disclosure of a four-mechanism, whole-control-flow
reproduction.** Under this revision, the *only* logic Milestone 6 independently
re-expresses (never blindly re-implements — see §3.3's "provable restatement" framing) is:

1. `inferRecommendationAgreement` — a 4-line mapping, directly restating
   `MILESTONE5_DESIGN_v5.md` §6.5/§7.6's documented rule.
2. `inferHardSafetyOverride` — a 1-line boolean, directly restating
   `MILESTONE5_DESIGN_v5.md` §6.5's documented rule (`legalOutcomes` excludes `"CONTINUE"`
   if and only if the override would apply).

Neither touches Claim Ledger ingest, severity arithmetic, confidence computation,
`DISPUTED` classification, or the Decision Engine's seven-branch priority order — all of
that remains **entirely** inside Milestone 5, entirely unreproduced, entirely
un-duplicated. This is the direct, structural fix for the "post-hoc/duplicated"
architectural problem this revision exists to resolve.

**Configuration-consistency risk, named explicitly (a real, if narrow, MEDIUM risk — see
final review section):** `invalidReviewRejectThreshold` and `reopenRejectThreshold` are
passed to *both* `runAuditedReviewLoop`'s own options and `createSupervisedHumanGate`'s
options (§8.1's sketch). If a caller passes mismatched values, JEV's cross-round inference
(specifically, the exclusion rule in `invalidReviewFlapCount`, which needs to know the
*same* threshold Milestone 5 itself is enforcing to correctly distinguish a "flap" from a
"already-caught-by-the-real-engine" cycle) could silently diverge from what Milestone 5
is actually doing. Recommended mitigation: the entry point constructs **one** shared
options value and passes it to both call sites, never two independently-typed literals.

**Required test, replacing every prior revision's "base-result parity test":** because
there is now exactly one orchestrator, called directly, in both the "with JEV" and
"without JEV" cases (the only difference being which `HumanGate` is injected), a parity
test comparing two independent implementations is no longer a meaningful test to write —
there is nothing to diverge. It is replaced by a single, simpler, more convincing test:
**an end-to-end integration test that calls the real `runAuditedReviewLoop()` with
`createSupervisedHumanGate(fakeInnerGate, fakeSupervisor, options)` injected, using
Milestone 5's own established fake-adapter test pattern, and asserts the returned `base`
result is a fully valid `AuditedReviewResult` indistinguishable in shape and content from
what any other Milestone 5 test produces** (§11.1).

---

## 11. Testing strategy

### 11.1 Unit tests (offline, pure functions, no Playwright) — significantly simplified from v2

| Test file | Covers |
|---|---|
| `tests/unit/inference.spec.ts` (**new**) | Direct, isolated tests of `inferRecommendationAgreement`/`inferHardSafetyOverride` (§3.3) against every `DecisionRecommendation.kind` × `HumanGateOutcome` × `legalOutcomes` combination — small, exhaustive, and the entire "duplicated logic" surface this revision leaves. |
| `tests/unit/deterministicSupervisor.spec.ts` | Unchanged from v2 — one test per §6 rule, including the worked `invalidReviewFlapCount` example, now exercised via the self-derived rising-edge trigger (§6.4) rather than an externally-fed audit-event list. |
| `tests/unit/supervisedHumanGate.spec.ts` (**replaces `supervisorFailureHandling.spec.ts` and `runSupervisedReviewLoop.spec.ts`**) | Using a fake `inner: HumanGate` and a fake `Supervisor`: confirms delegation returns exactly `inner`'s response, unaltered; confirms `getAccumulatedAssessments()` accumulates one record per call, in order; confirms a throwing `supervisor.assess()` produces a `SupervisorUnavailable` record and the round still completes; confirms a throwing banner-renderer produces a `renderingFailure`-annotated record and the round still completes; confirms a throwing `inner.presentAndAwaitDecision()` propagates uncaught (§9's boundary-3 test, proving the real gate's own failures are never absorbed). |
| `tests/unit/supervisorIsolation.spec.ts` | §10.3, updated. |
| **`tests/unit/supervisedRunAuditedReviewLoop.spec.ts` (new — the replacement for the parity test)** | The end-to-end integration test named in §10.4: calls the real, unmodified `runAuditedReviewLoop()` with fake adapters and `createSupervisedHumanGate(fakeGate, fakeSupervisor, options)` injected as `humanGate`; asserts the returned `base` is well-formed; asserts `supervisorAssessments.length === base.rounds.length` across at least three scripted terminal-outcome scenarios (clean accept, human reject, hard-ceiling-forced) — directly closing the length-parity requirement from the prior review, now proven against the real orchestrator rather than a reproduced one. |

### 11.2 Simulation tests (unchanged scope from v2 §11.2)

### 11.3 Real browser tests (unchanged from v2 §11.3, `scripts/smoke-supervised-review.ts` now constructs the decorator + calls `runAuditedReviewLoop()` directly, per §8.1's sketch, rather than a new orchestrator)

### 11.4 Compatibility/regression checks (unchanged from v2 §11.4 — `git diff --stat` against every Milestone 4A/4B/5 file must show no output; all existing tests must pass unmodified)

---

## 12. Disposition of the prior `runSupervisedReviewLoop.ts` design

**Replaced, not deprecated.** No implementation of `runSupervisedReviewLoop.ts` was ever
written — every revision of `MILESTONE6_JEV_DESIGN*.md` has been explicitly design-only,
per the task's own repeated instruction. "Deprecation" implies retiring existing code
while preserving it for compatibility; there is no such code here. The correct action is
simply: this file no longer appears in the file/module plan (§10.2), and any future
reader of the design history should understand it as a rejected architectural approach,
superseded by the decorator design in §3, not as a shipped feature being sunset.

---

## 13. Implementation phases

**Step 0 (mandatory, before any other Milestone 6 work): verify the load-bearing
assumption named in §0** — confirm `runAuditedReviewLoop.ts`'s exported entry point
accepts `humanGate: HumanGate` as an injected parameter. This is expected to be a
five-minute source read, not a design task, given how consistently this project already
uses dependency injection for every swappable collaborator.

**Milestone 6A (deterministic Supervisor, required delivery):**
- `src/orchestration/supervisor/types.ts` (§4)
- `src/orchestration/supervisor/inference.ts` (§3.3)
- `src/orchestration/supervisor/deterministicSupervisor.ts` (§6)
- `src/orchestration/supervisor/supervisedHumanGate.ts` (§3.2, §9)
- A thin entry point (§8.1) — no new orchestrator
- Full unit + simulation test suite (§11.1, §11.2), including the new end-to-end
  integration test
- `tests/unit/supervisorIsolation.spec.ts` (§10.3)

**Milestone 6B (optional LLM-backed adapter, deferred — unchanged from v2)**

**Milestone 6C (real-browser smoke verification, deferred — unchanged from v2, §11.3's
updated entry-point construction)**

---

## 14. Open questions

1. **Should JEV's banner ever be shown *before* the human answers, rather than
   immediately after (§3.2's note)?** This would require Milestone 5 to expose a pre-gate
   hook it does not currently have, which conflicts with "do not modify
   `runAuditedReviewLoop.ts`/`humanGate.ts`." Deferred — the current design's "shown
   immediately after this round's decision, informing the next one" framing is judged
   sufficient for real-time supervision without requiring any such hook.
2. Unchanged from v2 §13: whether a flag should ever fire without recommending
   escalation; whether the LLM-backed adapter should ever bind to a third, dedicated
   participant; whether `SupervisedReviewResult` should ever be persisted to disk.
3. **(Superseded, no longer open)** v2's open question about whether
   `runAuditedReviewLoop.ts` should eventually expose a formal per-round extension hook is
   no longer necessary to revisit for Milestone 6's own purposes — the decorator approach
   already achieves real-time injection through the existing `HumanGate` DI point, without
   needing any new hook. It remains a fair question for some *other* future extension that
   genuinely cannot be expressed as a `HumanGate` decorator, but is no longer live for JEV.

---

## 15. File / module plan

**New files (none created by this design turn — design only):**

- `src/orchestration/supervisor/types.ts` (§4)
- `src/orchestration/supervisor/inference.ts` (§3.3)
- `src/orchestration/supervisor/deterministicSupervisor.ts` (§6)
- `src/orchestration/supervisor/supervisedHumanGate.ts` (§3.2, §9)
- `src/orchestration/supervisor/llmSupervisorAdapter.ts`, `supervisorPrompts.ts` (§7, 6B)
- A thin entry point / `scripts/smoke-supervised-review.ts` + `npm run
  smoke:supervised-review` (§8.1, §11.3, 6C)
- `tests/unit/inference.spec.ts`, `deterministicSupervisor.spec.ts`,
  `supervisedHumanGate.spec.ts`, `supervisorIsolation.spec.ts`,
  `supervisedRunAuditedReviewLoop.spec.ts`

**No longer part of this plan:** `runSupervisedReviewLoop.ts` and its associated spec
file (§12).

**Explicitly untouched:** every file under `src/orchestration/convergence/`,
`src/orchestration/claims/`, `src/orchestration/humanGate/`, `src/orchestration/shared/`,
`runFixedReviewLoop.ts`, `fixedReviewPrompts.ts`, `runConvergenceReviewLoop.ts`,
`runAuditedReviewLoop.ts`, every file under `src/sites/` and `src/browser/`, every
existing script, `src/config/loadConfig.ts`, `config/config.json`, and every existing
test file.
