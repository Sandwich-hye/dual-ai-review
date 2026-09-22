# MILESTONE6_JEV_DESIGN_v2.md — JEV Supervisor Layer

Design-only document for Phase 2A Milestone 6. **No production TypeScript is changed or
written by this document.** This revision supersedes `MILESTONE6_JEV_DESIGN.md` after a
principal architect review found one BLOCKING and three MEDIUM issues (plus two LOW
items). It builds on the frozen Milestone 4A fixed-round loop, the frozen Milestone 4B
convergence-driven loop, and the completed, frozen Milestone 5 audited review system
(`runAuditedReviewLoop.ts`, the Claim Ledger, the Decision Agent, the Human Gate, and the
full audit trail — `MILESTONE5_DESIGN_v5.md`).

**Milestone 5's design is not modified anywhere in this document.** Every Milestone 5 file
is treated as frozen with no exception.

---

## Revision history

**v2 (this revision) — applied all six required changes from the principal architect
review of v1, before any implementation:**

1. **Supervisor failure isolation redefined to cover both assessment *and*
   presentation/rendering, with an explicit boundary.** v1's §9 wrapped only
   `supervisor.assess()`; the banner-rendering step inside `supervisedHumanGate.ts` had no
   described failure boundary at all, so a rendering bug there could propagate and block
   a round — a direct violation of the document's own non-negotiable rule. v2 defines two
   independent, nested try/catch layers (assessment, then rendering, then a
   last-resort fallback notice around the fallback itself) that together guarantee no
   exception originating from JEV's own code can ever reach the underlying review loop,
   while explicitly and deliberately leaving the real, delegated `inner.
   presentAndAwaitDecision()` call **unwrapped** — Milestone 5's own Human Gate failure
   modes remain exactly Milestone 5's concern, never silently absorbed or altered by
   Milestone 6 (§9). Closes BLOCKING #1.
2. **Orchestration-duplication disclosure corrected to state the true scope.** v1's §10.5
   named only two reproduced mechanisms (`hardMaxRounds` enforcement, `ledgerSnapshot`
   timing); the full stage-wrapped adapter-interaction pattern (`ready`/`capture`/`send`/
   `start`/`complete`/`extract`-style helpers, and the partial-result-carrying error class)
   is also unexported from `runAuditedReviewLoop.ts` and must be reproduced too. v2 states
   this precisely, names *why* (frozen boundaries prevent modifying
   `runAuditedReviewLoop.ts` to expose a hook), and specifies the required parity tests
   that make this reproduction verifiable rather than merely asserted (§10.5, §11).
   Closes MEDIUM #1.
3. **Supervisor input contract tightened to structured enum/numeric state only.** v1's
   `SupervisorRoundSignal` embedded the full `DecisionRecommendation` object, including its
   free-text `reason` and `invalidReview.reason` fields — a soft, convention-only boundary.
   v2 introduces a dedicated, stripped `SupervisorRecommendationSignal` projection that
   structurally excludes both free-text fields, built by a single, named, pure mapping
   function (§4.1). Closes MEDIUM #2.
4. **Testing strategy expanded with three explicitly-named tests**: a base-result parity
   test, a supervisor-independence-from-human-outcome test, and a supervisor-assessment-
   length-parity test across every terminal outcome type (§11.1). Closes MEDIUM #3.
5. **A worked numeric example added for `invalidReviewFlapCount`** (§6.4), the one rule in
   the document that previously lacked one, matching the project's established style.
6. **An explicit acknowledgment added** that JEV's recommendations are advisory only and
   may still influence a human's judgment even though they carry no code-level authority
   (§5.2) — named directly rather than left implicit.

**Explicitly preserved, re-verified in this revision:** JEV does not replace the Decision
Agent, the Claim Ledger, the Reviewer, or the Generator (§5); JEV cannot bypass the Human
Gate under any failure mode, including its own (§9, strengthened); Milestone 5 remains
completely untouched, with zero exceptions (§10); no production code is written anywhere
in this document.

Everything not named above is unchanged from v1's reasoning and is restated below so this
document remains self-contained.

---

## 0. Inspection summary and framing

Unchanged from v1 §0, plus the principal architect review of v1 itself, whose findings
are the direct input to this revision.

---

## 1. Goal / Non-goals

Unchanged from v1 §1.

---

## 2. Current state recap (frozen foundation)

Unchanged from v1 §2.

---

## 3. Architecture placement

### 3.1 Where JEV sits (unchanged from v1 §3.1)

### 3.2 The central placement decision (unchanged from v1 §3.2)

### 3.3 Why JEV wraps the Human Gate by composition, not by extending its data types (updated: precise, layered failure isolation)

```ts
// design sketch — src/orchestration/supervisor/supervisedHumanGate.ts (new module)
export interface SupervisedHumanGate {
  presentAndAwaitDecisionWithAssessment(
    presentation: HumanGatePresentation,               // Milestone 5's own type, imported,
                                                          // never widened or edited
    assessment: SupervisorAssessment | SupervisorUnavailable,
  ): Promise<HumanGateRawResponse>;                     // Milestone 5's own return type,
                                                          // imported, unchanged
}

export function createSupervisedTerminalHumanGate(): SupervisedHumanGate {
  const inner = createTerminalHumanGate();   // Milestone 5's real gate — reused BY IMPORT,
                                               // never subclassed, never edited
  return {
    async presentAndAwaitDecisionWithAssessment(presentation, assessment) {
      // ═══ JEV FAILURE ISOLATION BOUNDARY (§9) — covers ONLY the code this module itself
      // introduces (rendering the banner). It deliberately does NOT wrap the delegated
      // call to `inner` below — that is Milestone 5's own, unmodified Human Gate, and its
      // failure modes remain exactly Milestone 5's concern, never silently absorbed or
      // altered here. ═══
      try {
        if (!("unavailable" in assessment) && assessment.flags.length > 0) {
          printSupervisorBanner(assessment);
        }
      } catch (renderError) {
        // A bug in JEV's OWN rendering code must never reach the human's ability to
        // decide. Best-effort: attempt a minimal fallback notice so the failure is at
        // least visible, but wrap even that attempt — nothing JEV-authored is allowed to
        // escape this block under any circumstance.
        try { printSupervisorRenderingFailureNotice(renderError); } catch { /* no-op */ }
      }
      return inner.presentAndAwaitDecision(presentation);   // NEVER wrapped in a
                                                              // JEV-authored try/catch —
                                                              // see §9 for the precise
                                                              // invariant this guarantees
    },
  };
}
```

Everything else about this design (Milestone 5's own `HumanGatePresentation` and
`HumanGateRawResponse` types reused unchanged, `createTerminalHumanGate()` reused
unmodified, no structural widening of any Milestone 5 type) is unchanged from v1.

---

## 4. Input/output contracts

### 4.1 Input — tightened to structured enum/numeric state only (mandatory change 3, MEDIUM #2 fix)

```ts
// design sketch — src/orchestration/supervisor/types.ts (new module)
import type {
  DecisionRecommendation, DecisionBranch, RecommendationAgreement, HumanGateOutcome,
  RunAuditEventKind,
} from "../claims/types";   // reused BY IMPORT — never redefined, never duplicated

// The ONLY numeric/enum fields JEV's rules (§6) ever need. Deliberately excludes
// DecisionRecommendation's free-text `reason` and `invalidReview?.reason` — the specific
// leakage the architect review identified. `triggeredBranch` alone already subsumes
// `DecisionRecommendation.kind` (each of the seven branches maps to exactly one `kind`,
// per MILESTONE5_DESIGN_v5.md §8.4), so `kind` is not duplicated here either.
export interface SupervisorRecommendationSignal {
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

// The single, pure, named mapping function every caller must use to build the signal —
// never an ad hoc inline projection at each call site. This is what makes "JEV receives
// only structured state" a checkable, one-function property rather than a convention
// scattered across the codebase.
export function toSupervisorRecommendationSignal(
  recommendation: DecisionRecommendation,
): SupervisorRecommendationSignal {
  const {
    round, triggeredBranch, cleanStreak, openHighCount, openMediumCount, disputedCount,
    averageConfidence, lowConfidenceResolutionCount, invalidReviewStreak,
  } = recommendation;
  return {
    round, triggeredBranch, cleanStreak, openHighCount, openMediumCount, disputedCount,
    averageConfidence, lowConfidenceResolutionCount, invalidReviewStreak,
  };
  // Note what this destructuring/reconstruction explicitly leaves behind: `reason` and
  // `invalidReview` never appear on the right-hand side, so a future field added to
  // DecisionRecommendation is excluded by default unless this function is deliberately
  // updated to include it — the safer direction for a "no leakage" boundary to fail in.
}

export interface SupervisorRoundSignal {
  roundNumber: number;
  recommendation: SupervisorRecommendationSignal;   // the STRIPPED projection, never the
                                                       // raw DecisionRecommendation
  recommendationAgreement: RecommendationAgreement;
  outcome: HumanGateOutcome;
}

export interface SupervisorAuditEventSignal {
  round: number;
  kind: RunAuditEventKind;                    // kind + round ONLY — no free-text detail
}

export interface SupervisorInput {
  rounds: SupervisorRoundSignal[];
  auditEvents: SupervisorAuditEventSignal[];
  hardMaxRounds: number;
  recommendedMaxRounds: number;
  invalidReviewRejectThreshold: number;
  reopenRejectThreshold: number;
}
```

**Why this is now a hard, not soft, boundary:** every field on `SupervisorInput` is either
a number, a member of a small closed enum (`DecisionBranch`, `RecommendationAgreement`,
`HumanGateOutcome`, `RunAuditEventKind`), or an array of records built exclusively from
those two kinds of values. There is no field anywhere in this contract whose type is an
unconstrained `string` carrying prose — the closest thing, `DecisionBranch`/
`RunAuditEventKind`, are string *literal unions* (finite, closed, enumerable), not free
text. A Supervisor implementation — deterministic or LLM-backed (§7) — structurally cannot
read Reviewer/Generator reasoning, engine-authored diagnostic prose, or any other
unconstrained text, because none is present in what it's given.

### 4.2 Output (unchanged from v1 §4.2)

---

## 5. Supervisor decision model

### 5.1 Where JEV sits in the advisory hierarchy (unchanged from v1 §5.1)

### 5.2 The one new invariant Milestone 6 adds (updated: explicit advisory-influence acknowledgment, mandatory change 6)

Unchanged core claim from v1: JEV's entire causal influence on the system is exactly two
things — an additional terminal banner printed before the human answers, and an
additional entry in the audit trail (§8). It cannot change `legalOutcomes`, set
`hardSafetyOverride`, alter `recommendationAgreement`, touch a `ClaimLedgerEntry`, or send
a prompt to the Generator/Reviewer on its own initiative.

**Explicit acknowledgment, added in this revision:** "cannot change the outcome
structurally" is not the same claim as "cannot influence the outcome at all." A banner
that says `ABNORMAL_WORKFLOW_DETECTED` is, by design, meant to be persuasive — that is the
entire point of an escalation recommendation. A human who reads it may reasonably choose
`REJECT` where they would otherwise have chosen `CONTINUE`, purely because JEV said
something worth noticing. **This is intended, not a defect** — it is the same kind of
advisory influence the Decision Agent's own per-round recommendation already exercises
over every human decision in Milestone 5, and it is bounded by the same two guarantees
that already apply to that recommendation: the human is always free to disregard it
(`recommendationAgreement === "OVERRODE"` is a fully supported, ordinary outcome, never an
error), and every instance of it is permanently recorded for audit (§8), so influence is
always visible after the fact, never hidden. What Milestone 6 guarantees is narrower and
more precise than "JEV has no effect on the human": it guarantees JEV has **no effect
that bypasses the human** — every actual outcome-relevant value (`legalOutcomes`,
`hardSafetyOverride`, `recommendationAgreement`, the final `outcome`) is computed
identically whether or not JEV ever ran, or what it said (§11's new independence test
makes this a checked property, not just an assertion).

---

## 6. Deterministic rules (the default, required Supervisor implementation)

### 6.1 Default thresholds (unchanged from v1 §6.1)

### 6.2 Stagnation detection (unchanged from v1 §6.2, `blockingLoad` now read from `SupervisorRecommendationSignal` instead of the raw `DecisionRecommendation` — no formula change, only the field's type narrows)

### 6.3 Decision consistency checking (unchanged from v1 §6.3)

### 6.4 Abnormal workflow detection (updated: worked example added, mandatory change 5)

Formula unchanged from v1 §6.4:

```
isAbnormalWorkflow(r) :=
     any auditEvents entry up to round r has kind ∈
         { "HARD_MAX_ROUNDS_OVERRIDE", "INVALID_REVIEW_STREAK_THRESHOLD_REACHED" }
  OR invalidReviewFlapCount(r) >= invalidReviewFlapThreshold

invalidReviewFlapCount(r) := the number of times, up to round r, that
     recommendation(i).invalidReviewStreak rose above 0 and later returned to 0
     WITHOUT ever reaching invalidReviewRejectThreshold
```

**Worked example (new).** `invalidReviewRejectThreshold = 3`, `invalidReviewFlapThreshold
= 2`, and the run's `invalidReviewStreak` sequence across ten rounds is:

| Round | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| `invalidReviewStreak` | 0 | 1 | 2 | 0 | 1 | 0 | 1 | 2 | 3 | 0 |
| Cycle | — | A | A | *(A ends)* | B | *(B ends)* | C | C | C | *(C ends)* |

- **Cycle A** (rounds 2–3): streak rises to a peak of `2`, then returns to `0` at round 4
  without ever reaching `invalidReviewRejectThreshold = 3`. This is a completed
  sub-threshold cycle — **counts as 1 flap.**
- **Cycle B** (round 5 only): streak rises to `1`, returns to `0` at round 6, again never
  reaching `3` — **counts as a 2nd flap.** At this exact point,
  `invalidReviewFlapCount(6) = 2 >= invalidReviewFlapThreshold (= 2)`, so
  `isAbnormalWorkflow(6)` becomes `true` **at round 6** — this is the first round the flag
  fires, even though every individual round up to and including round 6 looked
  unremarkable in isolation (no round's own `DecisionRecommendation.triggeredBranch` was
  ever `"INVALID_REVIEW_STREAK"` — the per-round Decision Agent has no way to see this
  pattern; only JEV's cross-round view does).
- **Cycle C** (rounds 7–9): streak rises to `1`, `2`, then `3` at round 9 —
  `invalidReviewStreak` **reaches** `invalidReviewRejectThreshold`. Per the formula's
  explicit exclusion ("without ever reaching..."), this cycle is **not** counted as a
  flap — it is instead caught directly by the first disjunct of `isAbnormalWorkflow`
  (round 9's `auditEvents` would already contain an `"INVALID_REVIEW_STREAK_THRESHOLD_
  REACHED"` entry, per `MILESTONE5_DESIGN_v5.md` §10's rising-edge logging rule). The two
  disjuncts are mutually exclusive by construction for any single cycle — a cycle either
  crosses the reject threshold (caught by disjunct 1) or it doesn't (eligible to count
  toward disjunct 2's flap total) — so no cycle is ever double-counted or double-flagged.

---

## 7. Optional LLM-based JEV adapter (Milestone 6B, not required for Milestone 6A's delivery)

Unchanged from v1 §5 (renumbered §7 for this revision's section ordering — see §8 below
for the shift), except: `buildSupervisorAssessmentPrompt(input)` now builds its prompt from
the *tightened* `SupervisorInput` (§4.1) — the LLM-backed adapter, exactly like the
deterministic one, structurally cannot leak Reviewer/Generator reasoning into its own
prompt, since none is present in what it's given.

---

## 8. Audit requirements

Unchanged from v1 §6 (renumbered §8 for this revision) — `SupervisedReviewResult`,
`schemaVersion` placement, and the "reconstructing why JEV escalated" lookup table are all
unchanged in content.

---

## 9. Failure handling (rewritten: precise, layered isolation boundary, mandatory change 1, BLOCKING #1 fix)

**The one non-negotiable rule, restated more precisely than v1: no exception that
originates from code Milestone 6 itself introduces — the Supervisor's `assess()` call, or
the banner-rendering step inside `supervisedHumanGate.ts` — may ever propagate far enough
to stop, block, degrade, or alter the underlying Milestone 5 review loop.** This is now
enforced by two independent, nested boundaries, not one:

### 9.1 Boundary 1 — assessment computation (orchestrator-level, unchanged mechanism from v1)

```
try {
  assessment := await supervisor.assess(input)
} catch (error) {
  assessment := { unavailable: true, round: r, reason: describeError(error) }
}
supervisorAssessments.push(assessment)
```

### 9.2 Boundary 2 — presentation/rendering (gate-wrapper-level, new in this revision)

```
try {
  if (assessment has flags): printSupervisorBanner(assessment)
} catch (renderError) {
  try { printSupervisorRenderingFailureNotice(renderError) } catch { /* no-op */ }
}
```

This lives inside `supervisedHumanGate.ts` itself (§3.3), not in the orchestrator, because
rendering happens at gate-open time, structurally later than assessment computation — a
single boundary in the orchestrator could not have covered it.

### 9.3 What is deliberately *not* wrapped, and why

**The delegated call to `inner.presentAndAwaitDecision(presentation)` is never wrapped in
a JEV-authored try/catch.** This is deliberate, not an oversight symmetric with the bug
found in v1: `inner` is Milestone 5's own, completely unmodified `createTerminalHumanGate()`
instance. Its failure modes (a closed stdin, a malformed terminal state, any bug in
Milestone 5's own input-validation loop) are exactly Milestone 5's own concern, entirely
independent of whether Milestone 6 exists at all. Wrapping this call would mean Milestone
6 silently changes Milestone 5's own error behavior — precisely the kind of hidden
coupling `MILESTONE5_DESIGN_v5.md`'s own frozen-boundary discipline exists to prevent, now
applied one level up.

### 9.4 The resulting, testable invariant

**Any exception that propagates out of
`supervisedHumanGate.presentAndAwaitDecisionWithAssessment()` can only have originated
from `inner.presentAndAwaitDecision()` — i.e., from Milestone 5's own Human Gate — never
from JEV's own assessment or rendering code.** §11.1 adds a direct test for this: a fake
`Supervisor` and a fake banner-renderer that both always throw, run through the full
lifecycle, asserting the round still completes normally, the human is still asked to
decide, and no exception escapes the wrapper. Deterministic fallback (`SupervisorUnavailable`,
skip-banner) is unconditional and content-independent — it never varies based on *why* a
failure occurred, only *that* one did.

---

## 10. Backward compatibility with Milestone 5

### 10.1 Frozen list (unchanged from v1 §10.1 — zero exceptions)

### 10.2 New, additive-only (unchanged from v1 §10.2)

### 10.3 Isolation test required (unchanged from v1 §10.3)

### 10.4 `severityRules` extraction — unaffected (unchanged from v1 §10.4)

### 10.5 Acknowledged trade-off: bounded round-loop duplication — corrected disclosure (mandatory change 2, MEDIUM #1 fix)

**v1 understated this trade-off's true scope; this section corrects that.** Because
`runAuditedReviewLoop.ts` is frozen with no exception (§10.1), and Milestone 6 needs to
insert JEV's step *inside* that function's own per-round loop, `runSupervisedReviewLoop.ts`
necessarily reproduces — not just the two mechanisms v1 named, but the **full set** of
round-loop control-flow patterns that are private to `runAuditedReviewLoop.ts` and
therefore not importable:

1. **The `hardMaxRounds` two-layer enforcement pattern** (`MILESTONE5_DESIGN_v5.md` §6.5)
   — unchanged from v1's disclosure.
2. **The corrected `ledgerSnapshot`-capture-at-round-end timing** (`MILESTONE5_DESIGN_v5.md`
   §14) — unchanged from v1's disclosure.
3. **The stage-wrapped adapter-interaction pattern** — `runAuditedReviewLoop.ts`'s private
   `ready`/`capture`/`send`/`start`/`complete`/`extract`-style helper functions (the same
   family of helpers `MILESTONE5_DESIGN_v5.md` inherited from `runConvergenceReviewLoop.ts`'s
   own stage-tagged error wrapping) are unexported. Milestone 6 must re-derive equivalent
   wrappers for its own Generator/Reviewer turn sequencing.
4. **The partial-result-carrying error class** — Milestone 5's own error type (analogous
   to 4B's `ConvergenceReviewLoopError`, carrying a stage tag and a partial result) is
   likewise private to `runAuditedReviewLoop.ts`. Milestone 6 needs its own equivalent so
   that a mid-run failure in `runSupervisedReviewLoop.ts` produces an equally rich,
   equally debuggable partial result — not a bare, undiagnosable exception.

**Why this is still the right call, not a reason to abandon the design:** everything
*stateful and easy to get subtly wrong* — Claim Ledger ingest, severity floor arithmetic,
confidence computation, `DISPUTED` classification, the Decision Engine's seven-branch
priority order — remains **reused by direct import** from `claims/*`, completely
unduplicated. What gets reproduced is comparatively mechanical *sequencing* code (turn
order, error tagging, timeout wiring) — real work, correctly disclosed now as real work,
but not the kind of logic where a subtle bug would silently corrupt a decision the way a
duplicated severity-floor implementation could.

**Required parity tests, specified precisely (also satisfies §11.1's expanded list):**

- **Base-result parity test:** run the identical fake-adapter script (same scripted
  Reviewer/Generator responses, same fake `HumanGate` response sequence) through both
  `runAuditedReviewLoop()` (unmodified, Milestone 5) and `runSupervisedReviewLoop()`
  (Milestone 6, with a Supervisor that never flags anything), and assert
  `deepEqual(supervisedResult.base, unsupervisedResult)` — every field, not a spot check.
  This is the one test that makes "Milestone 6 changes nothing about Milestone 5's own
  behavior" a checked property rather than an assertion in prose.
- Error-path parity (recommended, not required for 6A): a fake adapter that fails
  mid-round should produce a `runSupervisedReviewLoop.ts` partial result structurally
  comparable (same stage-tagging shape, even if the concrete error type differs) to what
  `runAuditedReviewLoop.ts` would have produced for the identical failure.

**Open question, restated from v1 §13.2, now sharpened:** whether
`runAuditedReviewLoop.ts` should eventually be refactored to expose a formal per-round
extension hook, precisely so a future third supervisor-style layer (and, in hindsight,
Milestone 6 itself) would not need to reproduce this much control flow. Still named, still
not decided or built now, but the corrected disclosure above makes the cost this open
question would eliminate explicit rather than understated.

---

## 11. Testing strategy

### 11.1 Unit tests (offline, pure functions, no Playwright) — updated: three explicitly-named new tests (mandatory change 4)

| Test file | Covers |
|---|---|
| `tests/unit/deterministicSupervisor.spec.ts` | Unchanged from v1 — one test per §6 rule, now including the worked `invalidReviewFlapCount` example from §6.4 as a direct, literal test case. |
| `tests/unit/supervisorFailureHandling.spec.ts` (**expanded**) | v1's throwing-Supervisor test, **plus (new):** a fake banner-renderer that always throws — assert `printSupervisorRenderingFailureNotice` is invoked, the round still completes, and the human is still asked to decide (§9.2's boundary); **plus (new):** confirm the one exception path that *is* allowed to propagate — a throwing `inner.presentAndAwaitDecision()` — does propagate uncaught out of `presentAndAwaitDecisionWithAssessment()`, proving §9.3's "deliberately not wrapped" boundary is real, not accidentally also swallowed. |
| `tests/unit/supervisedHumanGate.spec.ts` | Unchanged from v1. |
| `tests/unit/supervisorIsolation.spec.ts` | Unchanged from v1 (§10.3). |
| `tests/unit/runSupervisedReviewLoop.spec.ts` (**expanded — the three new tests required by this revision**) | **New — base-result parity test:** the exact test specified in §10.5, run against at least three distinct scripted scenarios (a clean `ACCEPTED` run, a `REJECTED`-by-human run, and a `hardMaxRounds`-forced run), asserting `deepEqual(supervised.base, unsupervised)` in every case. **New — supervisor independence from human outcome test:** for a fixed round/`hardMaxRounds`/fake-gate-response script, run the loop multiple times varying only the fake `Supervisor`'s returned `SupervisorAssessment` (empty flags, all three flags, an always-`SupervisorUnavailable` implementation) and assert `legalOutcomes`, `hardSafetyOverride`, `recommendationAgreement`, and the final `outcome` are byte-identical across every variant — directly testing §5.2's central claim. **New — supervisor assessment length parity test:** across every terminal outcome type (`ACCEPTED`, human-`REJECTED`, and `hardMaxRounds`-forced `REJECTED`), assert `supervisorAssessments.length === base.rounds.length` exactly, including the forced-stop case where the final round's assessment must still be present even though the human's own requested outcome was overridden. |

### 11.2 Simulation tests (unchanged scope from v1 §11.2, `invalidReviewFlapCount`'s scenario now matches §6.4's worked example exactly)

### 11.3 Real browser tests (unchanged from v1 §11.3)

### 11.4 Compatibility/regression checks (unchanged from v1 §11.4)

---

## 12. Implementation phases (unchanged from v1 §12, section number shifted)

**Milestone 6A (deterministic Supervisor, required delivery):**
- `src/orchestration/supervisor/types.ts` (§4, §8)
- `src/orchestration/supervisor/deterministicSupervisor.ts` (§6)
- `src/orchestration/supervisor/supervisedHumanGate.ts` (§3.3, §9)
- `src/orchestration/runSupervisedReviewLoop.ts` (§3.2, §10.5 — including its own
  stage-wrapped error-handling equivalent, now correctly scoped per §10.5)
- Full unit + simulation test suite (§11.1, §11.2), including the three newly-required
  parity/independence tests
- `tests/unit/supervisorIsolation.spec.ts` (§10.3)

**Milestone 6B (optional LLM-backed adapter, deferred — unchanged from v1)**

**Milestone 6C (real-browser smoke verification, deferred — unchanged from v1)**

---

## 13. Open questions (unchanged from v1 §13, with §10.5's cost now explicit rather than understated)

1. Should a flag ever fire without recommending escalation (a lower-priority tier)?
   Deferred, unchanged from v1.
2. **Should `runAuditedReviewLoop.ts` eventually expose a formal per-round extension
   hook?** Sharpened in this revision (§10.5) — the cost this would eliminate is now
   precisely named (the full stage-wrapped pattern, not just two mechanisms), making the
   trade-off easier to weigh when this question is revisited.
3. Should the LLM-backed Supervisor adapter ever bind to a third, dedicated participant?
   Deferred, unchanged from v1 — would require new browser code, out of scope.
4. Should `SupervisedReviewResult` ever be persisted to disk? Deferred, unchanged from v1.

---

## 14. File / module plan (unchanged from v1 §14, section number shifted)

**New files (none created by this design turn — design only):**

- `src/orchestration/supervisor/types.ts` (§4, §8) — now including
  `SupervisorRecommendationSignal` and `toSupervisorRecommendationSignal` (§4.1)
- `src/orchestration/supervisor/deterministicSupervisor.ts` (§6)
- `src/orchestration/supervisor/supervisedHumanGate.ts` (§3.3, §9 — now including the
  two-layer failure-isolation boundary and the rendering-failure-notice fallback)
- `src/orchestration/supervisor/llmSupervisorAdapter.ts`, `supervisorPrompts.ts` (§7, 6B)
- `src/orchestration/runSupervisedReviewLoop.ts` (§3.2, §10.5 — now scoped to include its
  own stage-wrapped error-handling equivalent)
- `scripts/smoke-supervised-review.ts` + `npm run smoke:supervised-review` (§11.3, 6C)
- `tests/unit/deterministicSupervisor.spec.ts`, `supervisorFailureHandling.spec.ts`
  (expanded), `supervisedHumanGate.spec.ts`, `supervisorIsolation.spec.ts`,
  `runSupervisedReviewLoop.spec.ts` (expanded with the three new required tests)

**Explicitly untouched:** unchanged from v1 §14 — every file under
`src/orchestration/convergence/`, `src/orchestration/claims/`,
`src/orchestration/humanGate/`, `src/orchestration/shared/`, `runFixedReviewLoop.ts`,
`fixedReviewPrompts.ts`, `runConvergenceReviewLoop.ts`, `runAuditedReviewLoop.ts`, every
file under `src/sites/` and `src/browser/`, every existing script,
`src/config/loadConfig.ts`, `config/config.json`, and every existing test file.
