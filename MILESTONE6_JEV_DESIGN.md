# MILESTONE6_JEV_DESIGN.md — JEV Supervisor Layer

Design-only document for Phase 2A Milestone 6. **No production TypeScript is changed or
written by this document.** It builds on the frozen Milestone 4A fixed-round loop, the
frozen Milestone 4B convergence-driven loop, and the completed, frozen Milestone 5 audited
review system (`runAuditedReviewLoop.ts`, the Claim Ledger, the Decision Agent, the Human
Gate, and the full audit trail — `MILESTONE5_DESIGN_v5.md`, real-browser-verified per
`REVIEW.md`'s Milestone 5 closeout: `G0 → C1 → Human CONTINUE → G1 → C2 → Human ACCEPT`,
outcome `ACCEPTED`, `npm run build`/`npm test` — 189 tests — both passing).

**Milestone 5's design is not modified anywhere in this document.** Every Milestone 5 file
is treated as frozen with no exception (contrast Milestone 5's own single, narrowly-scoped
exception for `objectionLedger.ts` — Milestone 6 needs none).

---

## 0. Inspection summary and framing

Re-confirmed before drafting: Milestone 5 is complete and frozen (`TODO.md`'s Current
Phase banner, `REVIEW.md`'s Milestone 5 closeout, `DECISIONS.md`'s recorded history). The
current architecture, as built, is exactly:

```
GPT Generator ⇄ Claude Reviewer ⇄ Claim Ledger ⇄ Decision Agent ⇄ Human Gate ⇄ Audit Trail
```

realized as `runAuditedReviewLoop.ts` (the sole `Page`/adapter/gate caller) calling
`claims/claimLedger.ts`, `claims/decisionAgent.ts`, `claims/claimPrompts.ts`,
`claims/structuredClaimParser.ts`, and `humanGate/humanGate.ts`'s `HumanGate` interface +
`createTerminalHumanGate()`, producing an `AuditedReviewResult` per run.

**JEV's mandate, as given:** a Supervisor / meta-controller that receives *structured
system state* (not raw prompts or model text) and provides stagnation detection, decision
consistency checking, human escalation recommendation, and abnormal workflow detection.
**JEV must not replace** the GPT Generator, the Claude Reviewer, the Claim Ledger, the
Decision Agent, or the Human Gate. This single constraint shapes every architectural
choice below: JEV is purely observational and purely advisory, exactly one layer removed
from the Decision Agent's own "recommendation only, never a final action" role
(`MILESTONE5_DESIGN_v5.md` §7.4) — except JEV recommends at the *meta* level (is the whole
run behaving normally?) rather than the per-claim level (is this specific answer ready?).

---

## 1. Goal / Non-goals

**Goal:** add a Supervisor layer that observes the structured signals Milestone 5 already
produces every round (the Decision Agent's recommendation, the human's response, the
audit-event log) and, from a trailing window of that history, flags stagnation, decision
inconsistency, and abnormal workflow patterns — none of which the per-round Decision Agent
is positioned to see, since it only ever evaluates the *current* round's ledger state, not
*trends* across many rounds. JEV's only actionable output is a non-binding escalation
recommendation, surfaced to the human alongside (never instead of) the existing Human Gate
presentation, and recorded in a new, Milestone-6-owned audit wrapper.

**Non-goals (explicitly out of scope for Milestone 6):**

- **No changes to Milestone 4A, 4B, or 5.** Every file under `src/orchestration/`,
  `src/sites/`, `src/browser/` that any prior milestone introduced stays byte-for-byte
  untouched. Milestone 6 is a new, parallel orchestrator and a new, parallel module tree,
  exactly following the precedent 4B→5A itself set (`MILESTONE5_DESIGN_v5.md` §2: "a new,
  parallel orchestration module... does not extend or branch inside" the prior one).
- **No new browser/adapter code.** JEV's optional LLM-backed adapter (§5) reuses one of
  the two existing `ConversationalSiteAdapter`s (ChatGPT or Claude) — the exact same
  constraint Milestone 5's own deferred Evidence Agent (5B) was designed under. No third
  browser tab, no new CDP target, ever.
- **JEV never computes, overrides, or influences `legalOutcomes`, `hardSafetyOverride`,
  `recommendationAgreement`, the Decision Agent's `DecisionRecommendation`, or any Claim
  Ledger mutation.** These remain exclusively Milestone 5's concerns, reproduced (not
  edited) identically in Milestone 6's own orchestrator (§1's Non-goals list, restated
  precisely in §8).
- **No persistence.** Continuing 4B's and 5A's own repeated deferral
  (`MILESTONE4B_DESIGN.md` §12, `MILESTONE5_DESIGN_v5.md` §12.1), Milestone 6 does not
  write anything to disk. The new result type (§6) remains JSON-serializable and
  schema-versioned, matching the established discipline, but nothing is persisted yet.
- **No LLM-backed Supervisor by default.** Exactly mirroring Milestone 5's own Decision
  Agent precedent (`MILESTONE5_DESIGN_v5.md` §7.4, §1: "No LLM-backed Decision Agent"),
  the deterministic, rule-based Supervisor (§4) is the only implementation Milestone 6
  actually delivers; an LLM-backed adapter (§5) is designed as an optional, later,
  alternative implementation of the same interface — for the identical reason: a
  non-deterministic supervisor would itself be harder to audit, in direct tension with
  what a supervisor exists to provide.

---

## 2. Current state recap (frozen foundation, restated for self-containment)

```
runFixedReviewLoop.ts            — Milestone 4A, untouched
runConvergenceReviewLoop.ts      — Milestone 4B, untouched
  convergence/*                  — pure modules, untouched
runAuditedReviewLoop.ts          — Milestone 5A, untouched
  claims/types.ts                 — ClaimLedgerEntry, DecisionRecommendation, DecisionBranch,
                                     HumanGateOutcome, RecommendationAgreement, RunAuditEvent,
                                     RunAuditEventKind, AuditedRoundRecord, AuditedReviewResult, …
  claims/claimLedger.ts           — pure ingest (§4.7 of MILESTONE5_DESIGN_v5.md)
  claims/decisionAgent.ts         — pure decision function, 7-branch priority order,
                                     triggeredBranch authoritative (§8 of the same)
  claims/claimPrompts.ts          — pure prompt builders
  claims/structuredClaimParser.ts — pure text → StructuredClaimReview | Invalid
  humanGate/humanGate.ts          — HumanGate interface, HumanGateRawResponse,
                                     createTerminalHumanGate() (the ONLY production
                                     factory export)
shared/severityRules.ts          — pure severity arithmetic, shared by objectionLedger.ts
                                     and claimLedger.ts, untouched
```

Milestone 6 reuses every pure module above **by direct import**, exactly as Milestone 5
reused `convergence/fingerprint.ts`. It introduces a new, parallel orchestrator and a new,
parallel module tree — it does not call, wrap as a black box, or edit
`runAuditedReviewLoop.ts` itself (§8 explains precisely why, and names the one accepted
trade-off this implies).

---

## 3. Architecture placement

### 3.1 Where JEV sits

```
                 ┌─────────────────────────────────────┐
 originalTask →  │  runSupervisedReviewLoop.ts (NEW)     │ → SupervisedReviewResult
                 │  (Milestone 6's own orchestrator;     │    { schemaVersion, base:
                 │   reuses claims/*, humanGate/*        │      AuditedReviewResult,
                 │   BY IMPORT; does not call or edit     │      supervisorAssessments }
                 │   runAuditedReviewLoop.ts)            │
                 └──┬───────────────┬──────────────┬────┘
                    │ calls         │ calls         │ calls
     ┌──────────────┴───┐  ┌────────┴─────────┐  ┌──┴────────────────────────┐
     │ claims/* (5A,     │  │ supervisor/*      │  │ humanGate/* (5A, REUSED,  │
     │ REUSED, unchanged)│  │ (NEW — pure       │  │ unchanged) + supervisor/  │
     │ decisionAgent.ts, │  │ deterministic      │  │ supervisedHumanGate.ts    │
     │ claimLedger.ts,   │  │ rules by default;  │  │ (NEW — WRAPS              │
     │ claimPrompts.ts,  │  │ optional LLM       │  │ createTerminalHumanGate() │
     │ structuredClaim-  │  │ adapter, §5)       │  │ by composition, never by  │
     │ Parser.ts         │  │                    │  │ subclassing/editing it)   │
     └───────────────────┘  └────────────────────┘  └───────────────────────────┘
     ChatGPT tab (Generator)  ⇄  Claude tab (Reviewer)
     — same two adapters, same ConversationalSiteAdapter contract, NO new browser code —
     — Supervisor (JEV) reads structured round history ONLY — never Page/DOM, never raw
       Generator/Reviewer text — and can NEVER fail the review loop itself (§7)
```

### 3.2 The central placement decision, stated explicitly

JEV is inserted into the per-round lifecycle **after** the Decision Agent computes its
`DecisionRecommendation` and **before** the Human Gate opens — the same point in the
round where a human would naturally want *all* available advisory context, both the
per-round recommendation and any cross-round pattern JEV has detected. Concretely:

1. Milestone 6's orchestrator builds a `SupervisorInput` (§4.1) from the round history
   accumulated *so far* (never from raw prompts/responses — see §4.1's scoping rationale).
2. It calls `supervisor.assess(input)`, which never throws by contract (§7) and always
   resolves to either a `SupervisorAssessment` or an explicit `SupervisorUnavailable`
   marker.
3. It calls `supervisedHumanGate.presentAndAwaitDecisionWithAssessment(presentation,
   assessment)` — a **new**, Milestone-6-only interface (§3.3) that is *not* a drop-in
   replacement for Milestone 5's `HumanGate`; it wraps one.
4. Every later step (hardMaxRounds Layer 2 enforcement, `HumanDecisionRecord`
   construction, `ledgerSnapshot` capture at the true end of round processing) is
   **reproduced from `MILESTONE5_DESIGN_v5.md` §14 verbatim** inside
   `runSupervisedReviewLoop.ts` — not called by reference into
   `runAuditedReviewLoop.ts`, and not altered in any way. §8 names this duplication
   explicitly as the one accepted cost of the "never modify Milestone 5" constraint.

### 3.3 Why JEV wraps the Human Gate by composition, not by extending its data types

An earlier draft of this design considered widening `HumanGatePresentation` with an
optional `supervisorAssessment` field (relying on TypeScript's structural typing to keep
it backward-compatible). That approach was rejected in favor of something even more
conservative and unambiguous: Milestone 6 defines its **own** interface,

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
  const inner = createTerminalHumanGate();   // Milestone 5's real gate — reused BY IMPORT
  return {
    async presentAndAwaitDecisionWithAssessment(presentation, assessment) {
      if (!("unavailable" in assessment) && assessment.flags.length > 0) {
        printSupervisorBanner(assessment);   // a NEW, separate terminal print step —
                                               // Milestone 5's own rendering inside
                                               // `inner` is never touched or reached into
      }
      return inner.presentAndAwaitDecision(presentation);   // delegates entirely; the
                                                              // exact same input-validation,
                                                              // legalOutcomes enforcement,
                                                              // and REJECT-rationale
                                                              // requirement Milestone 5
                                                              // already built are reused,
                                                              // not reimplemented
    },
  };
}
```

This is the strongest possible form of "does not replace the Human Gate": Milestone 6
never even sees `HumanGatePresentation`'s internals change shape, never subclasses
`createTerminalHumanGate()`'s implementation, and cannot accidentally suppress or alter any
of Milestone 5's own input handling — it can only print an *additional* banner before
handing control to the unmodified, imported gate.

---

## 4. Input/output contracts

### 4.1 Input — a deliberately minimal, structured projection, never raw text

```ts
// design sketch — src/orchestration/supervisor/types.ts (new module)
import type {
  DecisionRecommendation, RecommendationAgreement, HumanGateOutcome, RunAuditEventKind,
} from "../claims/types";   // reused BY IMPORT — never redefined, never duplicated

export interface SupervisorRoundSignal {
  roundNumber: number;
  recommendation: DecisionRecommendation;    // includes triggeredBranch (authoritative,
                                               // MILESTONE5_DESIGN_v5.md §8.6) and every
                                               // ledger-derived count already computed
                                               // that round — JEV never recomputes these
  recommendationAgreement: RecommendationAgreement;
  outcome: HumanGateOutcome;                  // the ACTED-ON outcome that round (from
                                               // that round's HumanDecisionRecord)
}

export interface SupervisorAuditEventSignal {
  round: number;
  kind: RunAuditEventKind;                    // kind + round ONLY — no free-text detail;
                                               // JEV's rules never need to read prose
}

export interface SupervisorInput {
  rounds: SupervisorRoundSignal[];             // every round so far, in order; JEV computes
                                                 // its own trailing windows internally — the
                                                 // caller never pre-slices this (§6)
  auditEvents: SupervisorAuditEventSignal[];
  hardMaxRounds: number;
  recommendedMaxRounds: number;
  invalidReviewRejectThreshold: number;
  reopenRejectThreshold: number;
}
```

**Why this is deliberately minimal, stated as an explicit design rule, not an oversight:**
JEV never receives the full `ClaimLedgerEntry[]`, raw Reviewer/Generator text, or
`Evidence` records. Everything JEV's rules need (§6) is already computed, numeric, and
present on `DecisionRecommendation` — `openHighCount`, `openMediumCount`, `disputedCount`,
`averageConfidence`, `lowConfidenceResolutionCount`, `invalidReviewStreak`,
`triggeredBranch`. Restricting JEV's input to this projection guarantees, structurally,
that a Supervisor implementation *cannot* second-guess the Claim Ledger's own severity/
resolution judgments or duplicate the Decision Agent's own per-round logic — it can only
reason about *trends across rounds*, which is the one thing neither of those two already
does.

### 4.2 Output — advisory only, never a final action

```ts
export type SupervisorFlagKind =
  | "STAGNATION" | "DECISION_INCONSISTENCY" | "ABNORMAL_WORKFLOW";

export interface SupervisorFlagDetail {
  flag: SupervisorFlagKind;
  detail: string;
  evidenceRounds: number[];      // which rounds contributed to this flag firing —
                                   // always non-empty, always a subset of rounds already
                                   // present in the input, never a claim about a round
                                   // JEV wasn't given
}

export interface SupervisorAssessment {
  round: number;
  flags: SupervisorFlagDetail[];         // empty array = nothing flagged this round
  escalationRecommended: boolean;        // := flags.length > 0 (§3, no partial-credit
                                          // "flagged but not escalation-worthy" tier in
                                          // Milestone 6 — see §13 open question 1)
  escalationReason?: string;             // present iff escalationRecommended; a single,
                                          // human-readable summary of all flags.detail
}

export interface SupervisorUnavailable {
  unavailable: true;
  round: number;
  reason: string;
}

export interface Supervisor {
  assess(input: SupervisorInput): Promise<SupervisorAssessment | SupervisorUnavailable>;
  // NEVER throws in normal operation (§7); Promise-returning uniformly so both the
  // deterministic (§4, resolves immediately) and optional LLM-backed (§5, genuinely
  // async) implementations share one interface, exactly mirroring how
  // ConversationalSiteAdapter and HumanGate are both async for the same reason.
}
```

---

## 5. Supervisor decision model

### 5.1 Where JEV sits in the advisory hierarchy (extends `MILESTONE5_DESIGN_v5.md` §7.5's role table)

| Role | AI-backed? | Bound to | Can finalize an outcome? |
|---|---|---|---|
| Generator | Yes (ChatGPT) | Existing adapter | No |
| Reviewer | Yes (Claude) | Existing adapter | No |
| Decision Agent | No (deterministic) | Pure function | No — recommendation only |
| **Supervisor (JEV)** | **No by default (§4); optionally yes (§5)** | **Pure function, or an existing adapter (optional)** | **No — escalation recommendation only, and only surfaced as an extra banner, never a gate outcome** |
| **Human Gate** | No — a real person | `HumanGate` interface (Milestone 5, reused unchanged) | **Yes — the only role that can, unchanged from Milestone 5** |

### 5.2 The one new invariant Milestone 6 adds

**JEV's entire causal influence on the system is exactly two things: an additional
terminal banner printed before the human answers, and an additional entry in the audit
trail (§6).** It cannot change `legalOutcomes`. It cannot set `hardSafetyOverride`. It
cannot alter `recommendationAgreement`. It cannot touch a `ClaimLedgerEntry`. It cannot
send a prompt to the Generator or Reviewer on its own initiative (an LLM-backed JEV, §5,
only ever *reads* a structured summary and returns a structured assessment — it is never
positioned as a third participant in the review conversation itself). If a Supervisor
implementation is buggy, malicious, or simply absent, the review's actual outcome —
`ACCEPTED` or `REJECTED`, and why — is byte-for-byte identical to what Milestone 5 alone
would have produced (§7 makes this a tested, enforced guarantee, not just an intention).

---

## 6. Deterministic rules (the default, required Supervisor implementation)

All three flags are computed over **trailing windows** of `SupervisorInput.rounds`/
`auditEvents` — this is precisely the capability neither the Decision Agent (single-round
view) nor a human reading one round at a time can easily hold in their head across a long
run.

### 6.1 Default thresholds

| Option | Default | Meaning |
|---|---|---|
| `stagnationWindowRounds` | 4 | trailing window size for stagnation detection |
| `decisionInconsistencyWindowRounds` | 3 | trailing window size for override-streak detection |
| `invalidReviewFlapThreshold` | 2 | number of "almost-chronic" invalid-review cycles before flagging abnormal workflow |

### 6.2 Stagnation detection

```
blockingLoad(r) := recommendation(r).openHighCount + recommendation(r).openMediumCount
                    + recommendation(r).disputedCount

isStagnant(r) := r >= stagnationWindowRounds
                 AND blockingLoad(r) >= blockingLoad(r - stagnationWindowRounds + 1)
```

i.e., across the whole trailing window, the total blocking load (open HIGH + open MEDIUM
+ disputed claims) has not decreased at all — flat or worse — despite
`stagnationWindowRounds` rounds of Generator revisions and Reviewer re-evaluations. A run
that is genuinely making progress will show `blockingLoad` trending down over any window
of this size; one that isn't gets flagged, regardless of whether any single round's
`DecisionRecommendation` looked unremarkable in isolation.

**Deliberately not flagged as stagnation:** a run where `blockingLoad` is oscillating but
trending down overall (e.g., 5, 3, 4, 2) — the formula above only compares the window's
endpoints, which is intentional: a single round's temporary uptick (a new MEDIUM
surfacing while an old HIGH resolves) is normal review behavior, not stagnation. Genuine
stagnation is "no net progress over the whole window," not "no monotonic decrease every
single round."

### 6.3 Decision consistency checking

```
isDecisionInconsistent(r) := r >= decisionInconsistencyWindowRounds
                             AND every round in the trailing
                                 decisionInconsistencyWindowRounds-round window has
                                 recommendationAgreement === "OVERRODE"
```

i.e., the human has disagreed with the Decision Agent's recommendation on *every* round in
the window. This is explicitly **not** a claim that either party is wrong — a human who
consistently judges LOW-severity disputes as acceptable to proceed past, against the
engine's own conservative default, may simply be exercising good judgment the thresholds
don't capture. It is a signal worth surfacing precisely because persistent disagreement
between the AI's model of "what's acceptable" and the human's own judgment is exactly the
kind of drift a supervisor should make visible rather than let accumulate silently across
a long run.

### 6.4 Abnormal workflow detection

```
isAbnormalWorkflow(r) :=
     any auditEvents entry up to round r has kind ∈
         { "HARD_MAX_ROUNDS_OVERRIDE", "INVALID_REVIEW_STREAK_THRESHOLD_REACHED" }
  OR invalidReviewFlapCount(r) >= invalidReviewFlapThreshold

invalidReviewFlapCount(r) := the number of times, up to round r, that
     recommendation(i).invalidReviewStreak rose above 0 and later returned to 0
     WITHOUT ever reaching invalidReviewRejectThreshold — i.e., the Reviewer repeatedly
     fails to parse for a round or two, recovers, and repeats, never quite triggering
     the Decision Agent's own chronic-invalid-review branch (MILESTONE5_DESIGN_v5.md
     §8.3a) even though the aggregate pattern across the whole run is exactly as
     concerning as a single long streak would have been
```

The first disjunct is a direct, zero-ambiguity trigger: either of those two
`RunAuditEventKind`s occurring even once means something already required special-case
handling inside Milestone 5's own orchestrator (a human tried to exceed `hardMaxRounds`, or
the Reviewer's chronic-parse-failure threshold fired) — JEV surfaces this as a
run-level flag regardless of how many rounds have since passed, so it is never buried by
later, unremarkable rounds. The second disjunct is JEV's genuinely new contribution: a
pattern the per-round Decision Agent structurally cannot see, because it only tracks the
*current* streak, never how many times a streak has built up and reset without crossing
threshold — a Reviewer that is unreliable in exactly this "almost, but not quite chronic"
way would otherwise never be flagged by anything in the system.

### 6.5 Composition

```
flags := []
if isStagnant(r): flags.push({ flag: "STAGNATION", detail, evidenceRounds: the window })
if isDecisionInconsistent(r): flags.push({ flag: "DECISION_INCONSISTENCY", detail, evidenceRounds: the window })
if isAbnormalWorkflow(r): flags.push({ flag: "ABNORMAL_WORKFLOW", detail, evidenceRounds: [...] })
escalationRecommended := flags.length > 0
```

All three checks are independent and can co-fire in the same round; `flags` is an array,
never a single enum, precisely so co-occurring patterns are each individually visible in
the audit trail rather than collapsed into one ambiguous value.

---

## 7. Optional LLM-based JEV adapter (Milestone 6B, not required for Milestone 6A's delivery)

An alternative `Supervisor` implementation, named and designed here, not built in
Milestone 6's initial phase (§10) — mirroring the Decision Agent's own deferred LLM-backed
option (`MILESTONE5_DESIGN_v5.md` §7.4, §13.2 open question).

```ts
// design sketch — src/orchestration/supervisor/llmSupervisorAdapter.ts (Milestone 6B)
export function createLlmSupervisor(
  adapter: ConversationalSiteAdapter,   // one of the two EXISTING adapters — reused, no
                                          // new browser code, exactly 5B's own constraint
): Supervisor {
  return {
    async assess(input) {
      const prompt = buildSupervisorAssessmentPrompt(input);   // pure string builder,
                                                                 // supervisor/supervisorPrompts.ts
                                                                 // — built ONLY from the same
                                                                 // structured SupervisorInput
                                                                 // (§4.1), never from raw
                                                                 // Generator/Reviewer text
      // send/wait/extract via the adapter's existing ConversationalSiteAdapter contract —
      // no new send/wait/extract mechanism, reusing exactly what 4A/4B/5A already proved
      const rawResponse = /* adapter.sendPrompt / waitForGenerationStart / … / getLatestAssistantResponse */;
      const parsed = parseSupervisorAssessmentResponse(rawResponse);   // sentinel-JSON
                                                                         // grammar, identical
                                                                         // pattern to 4B's/5A's
                                                                         // BEGIN_X_RESPONSE /
                                                                         // END_X_RESPONSE
      if ("invalid" in parsed) return { unavailable: true, round: input.rounds.at(-1)!.roundNumber,
                                          reason: parsed.reason };
      return parsed;   // a fully-formed SupervisorAssessment — same contract as §4.2,
                        // regardless of which Supervisor implementation produced it
    },
  };
}
```

**Prompt/parse grammar, sketched (design only):**

```
BEGIN_SUPERVISOR_ASSESSMENT
{
  "flags": [
    { "flag": "STAGNATION" | "DECISION_INCONSISTENCY" | "ABNORMAL_WORKFLOW",
      "detail": "<one line>", "evidenceRounds": [<int>, ...] }
  ],
  "escalationRecommended": true or false,
  "escalationReason": "<optional>"
}
END_SUPERVISOR_ASSESSMENT
```

Parsed with the same strict, fail-safe discipline `structuredClaimParser.ts` and 4B's
`structuredReviewParser.ts` already established: malformed input never produces anything
assessment-shaped — only a valid `SupervisorAssessment` or an explicit
`SupervisorUnavailable`, with no partial/best-effort middle ground
(`MILESTONE4B_DESIGN.md` §7.1's rule, reused verbatim in spirit).

**Why this stays optional, not the default (restated from §1):** an LLM call is
non-deterministic, adds a real browser turn (and its own timeout/failure surface) to every
round, and — most importantly — would make the Supervisor's *own* behavior harder to
audit than the thing it exists to audit. The deterministic implementation (§6) is
sufficient to deliver every capability named in the mandate (stagnation, consistency,
abnormal-workflow, escalation) without any of those costs; the LLM-backed adapter exists
for a future case where a more nuanced, language-level judgment (e.g., "does the
Reviewer's *wording* sound like it's stalling even though the numbers look fine yet") is
wanted, which is explicitly out of Milestone 6A's scope (§10, §13).

---

## 8. Audit requirements

### 8.1 A new, wrapping result type — never an edit to `AuditedReviewResult`

```ts
// design sketch — src/orchestration/supervisor/types.ts
export const SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION = 1;

export interface SupervisedReviewResult {
  schemaVersion: number;
  base: AuditedReviewResult;                                 // Milestone 5's own result
                                                                 type, embedded verbatim —
                                                                 its own internal shape is
                                                                 completely unchanged
  supervisorAssessments: (SupervisorAssessment | SupervisorUnavailable)[];
                                                                // one entry per round,
                                                                 index-aligned with
                                                                 base.rounds — always the
                                                                 same length as base.rounds,
                                                                 even when the Supervisor
                                                                 was unavailable that round
}
```

A reader who only ever consumes `result.base` gets *exactly* the Milestone 5 experience,
byte-for-byte — this is what makes "JEV must not replace anything" a structural property
of the result type, not just a design intention: nothing about `AuditedReviewResult`'s own
shape, fields, or semantics is touched, extended, or reinterpreted.

### 8.2 `schemaVersion` placement (extends `MILESTONE5_DESIGN_v5.md` §12.1's rule, same criterion applied)

| Type | Versioned? | Why |
|---|---|---|
| `SupervisedReviewResult` | Yes | New top-level unit — the only new independently-persistable artifact Milestone 6 introduces. |
| `SupervisorAssessment`, `SupervisorUnavailable` | No | Each only ever travels inside `SupervisedReviewResult.supervisorAssessments`, an already-versioned container — identical reasoning to why `ClaimLedgerEntry`/`Evidence` aren't independently versioned in Milestone 5. |

### 8.3 Reconstructing "why JEV escalated," mechanically

| Question | How it's answered |
|---|---|
| Did JEV flag anything at round N, and why? | `result.supervisorAssessments[N-1]` — if it's a `SupervisorAssessment`, read `.flags` (each with `.detail` and `.evidenceRounds`) directly; if `.escalationRecommended`, read `.escalationReason`. |
| Was JEV even running at round N? | If `result.supervisorAssessments[N-1]` is a `SupervisorUnavailable`, JEV did not produce an assessment that round (§7) — the review nonetheless proceeded exactly as Milestone 5 alone would have. |
| Did JEV's escalation recommendation influence the human's actual decision that round? | Cross-reference `result.base.rounds[N-1].humanDecision.recommendationAgreement`/`.outcome` — JEV's assessment is never itself part of that computation (§5.2), so this is always an independent, separately-recorded comparison, never a derived/redundant field. |

---

## 9. Failure handling

**The one non-negotiable rule: a Supervisor failure must never stop, block, degrade, or
alter the underlying Milestone 5 review loop's behavior.**

```
try {
  assessment := await supervisor.assess(input)
} catch (error) {
  assessment := { unavailable: true, round: r, reason: describeError(error) }
}
supervisorAssessments.push(assessment)
// proceed to the Human Gate exactly as if this line never executed a Supervisor call at all
```

This applies uniformly whether the Supervisor implementation is the deterministic default
(§6 — which, being pure synchronous-equivalent logic over already-validated numeric
input, should essentially never throw, but the catch exists regardless, defensively) or
the optional LLM-backed adapter (§5 — which genuinely can time out, hit a malformed
response, or encounter an adapter-level failure exactly like any other browser turn). In
either case, the *content* of the failure (a timeout, a parse failure, an unexpected
exception) is captured in `SupervisorUnavailable.reason` for audit purposes, and the round
proceeds to `supervisedHumanGate.presentAndAwaitDecisionWithAssessment(presentation,
{ unavailable: true, ... })` — which (per §3.3's implementation) simply skips printing a
banner and delegates to Milestone 5's real gate exactly as it always does. **No round is
ever skipped, retried, or altered because JEV failed.**

---

## 10. Backward compatibility with Milestone 5

### 10.1 Frozen list — no exception this time

Every file introduced by Milestone 4A, 4B, or 5 remains untouched, with **zero** exceptions
(contrast Milestone 5's own single, narrowly-scoped `objectionLedger.ts` migration) —
Milestone 6 needs no internal edit to any prior-milestone file, because every extension
point it needs (the `HumanGate` interface, the pure `claims/*` modules, `DecisionRecommendation`'s
already-rich shape) already existed before Milestone 6 was designed.

### 10.2 New, additive-only

- New top-level directory `src/orchestration/supervisor/` — never inside `claims/`,
  `humanGate/`, or `convergence/`.
- A new `src/orchestration/runSupervisedReviewLoop.ts`, parallel to (never replacing)
  `runAuditedReviewLoop.ts`.
- `package.json` may gain new script entries (e.g. `"smoke:supervised-review"`); existing
  lines byte-identical.

### 10.3 Isolation test required

`tests/unit/supervisorIsolation.spec.ts` — asserts no file under `src/orchestration/
claims/`, `src/orchestration/humanGate/`, `src/orchestration/convergence/`, or any
Milestone 4A/4B/5 file imports anything from `src/orchestration/supervisor/`. The
dependency arrow points exactly one way (Milestone 6 depends on Milestone 5's exports;
nothing in Milestone 5 depends on Milestone 6), mirroring every prior milestone's own
isolation-test precedent.

### 10.4 `severityRules` extraction — unaffected, re-confirmed safe

Milestone 6 does not touch the Claim Ledger's ingest logic, the Decision Agent, or
`shared/severityRules.ts` in any way — it only *reads* their already-computed output
(`DecisionRecommendation`). Nothing about the pure/local severity-arithmetic boundary
established in `MILESTONE5_DESIGN_v5.md` §9.1 is affected, exercised differently, or put
at any new risk by this design.

### 10.5 Acknowledged trade-off: bounded round-loop duplication (named openly, not hidden)

Because `runAuditedReviewLoop.ts` is frozen with no exception (§10.1), and because JEV's
insertion point (§3.2) sits *inside* that function's own per-round loop, Milestone 6's
`runSupervisedReviewLoop.ts` necessarily reproduces a bounded amount of Milestone 5's own
round-loop control flow — specifically, the `hardMaxRounds` two-layer enforcement pattern
and the corrected `ledgerSnapshot`-capture-at-round-end timing
(`MILESTONE5_DESIGN_v5.md` §14) — rather than calling into `runAuditedReviewLoop.ts` and
injecting a hook. This is an accepted, bounded cost, not an oversight: the duplicated
logic is small (a few lines of control flow, not any of the actual decision/ingest logic,
which stays fully reused by import), and Milestone 5's own test suite continues to guard
the *original*, unsupervised loop against any regression, completely independently of
Milestone 6. If a future milestone adds a third supervisor-style layer, retrofitting a
formal extension hook into `runAuditedReviewLoop.ts` should be reconsidered at that point
— named here as an open question (§13), not solved now, consistent with this project's
established discipline of not building for a second use case before one actually exists.

---

## 11. Testing strategy

### 11.1 Unit tests (offline, pure functions, no Playwright)

| Test file | Covers |
|---|---|
| `tests/unit/deterministicSupervisor.spec.ts` | One test per §6 rule: stagnation fires exactly at the window boundary and not one round earlier; a trending-down-but-oscillating `blockingLoad` does *not* flag stagnation (§6.2's explicit non-trigger case); decision-inconsistency fires only when *every* round in the window is `"OVERRODE"`, not a majority; abnormal-workflow fires immediately on either `RunAuditEventKind` trigger and correctly counts flap cycles without needing them to reach `invalidReviewRejectThreshold`; multiple flags co-firing in one assessment. |
| `tests/unit/supervisorFailureHandling.spec.ts` | A Supervisor implementation that throws — assert `SupervisorUnavailable` is recorded, the round proceeds identically to a round with no flags, and no exception escapes `runSupervisedReviewLoop.ts`. |
| `tests/unit/supervisedHumanGate.spec.ts` | Confirms `createSupervisedTerminalHumanGate()` delegates all input validation/`legalOutcomes` enforcement/`REJECT`-rationale requirements to the *unmodified* `createTerminalHumanGate()` — i.e., behavior is identical to Milestone 5's gate whenever no flags are present, and differs *only* in the additional banner print when flags exist. |
| `tests/unit/supervisorIsolation.spec.ts` | §10.3's dependency-graph check. |
| `tests/unit/runSupervisedReviewLoop.spec.ts` | Full-loop integration using fake `ConversationalSiteAdapter`s, a fake `Supervisor` (scripted flag sequences), and a fake `SupervisedHumanGate` — covering: a run where JEV never flags anything (result identical in every `base`-scoped field to what an equivalent Milestone-5-only run would produce); a run where JEV flags stagnation but the human continues anyway (escalation is advisory, never forced); a run reaching `hardMaxRounds` with JEV's abnormal-workflow flag correctly co-occurring with the forced `HARD_SAFETY_OVERRIDE` outcome. |

### 11.2 Simulation tests

Scripted multi-round scenarios (fake adapters, fake gate, no browser) specifically
exercising: a genuinely stagnant run (blocking load flat for `stagnationWindowRounds`
rounds) correctly flags at exactly the window boundary; a persistently-overridden
recommendation sequence flags decision inconsistency; a Reviewer that flaps between 1–2
invalid reviews and recovery, never reaching `invalidReviewRejectThreshold`, still
triggers `ABNORMAL_WORKFLOW` once `invalidReviewFlapThreshold` cycles have occurred.

### 11.3 Real browser tests (manual, not part of the automated suite — Milestone 6C, §12)

`scripts/smoke-supervised-review.ts` + `npm run smoke:supervised-review`, mirroring
`scripts/smoke-audited-review.ts`'s established CDP-attach-only safety pattern exactly
(no launch/close/navigate, single send per logical turn, requires an actual human at the
gate) — the one new manual-verification requirement: deliberately drive a short scripted
scenario (e.g. a small `stagnationWindowRounds`/`invalidReviewFlapThreshold` for the smoke
run's own defaults) so at least one JEV flag is actually exercisable and visible in a
short manual session, exactly matching how Milestone 5's own smoke script recommended a
low `hardMaxRounds` for the same reason (`MILESTONE5_DESIGN_v5.md` §15.3).

### 11.4 Compatibility/regression checks

- `git diff --stat` against every Milestone 4A/4B/5 file must show no output.
- All existing tests (189 as of Milestone 5's closeout) must still pass, unmodified.
- `npm run build` and `npm test` must both pass with Milestone 6's new files present.

---

## 12. Implementation phases

**Milestone 6A (deterministic Supervisor, required delivery):**
- `src/orchestration/supervisor/types.ts` (§4, §8.1)
- `src/orchestration/supervisor/deterministicSupervisor.ts` (§6)
- `src/orchestration/supervisor/supervisedHumanGate.ts` (§3.3)
- `src/orchestration/runSupervisedReviewLoop.ts` (§3.2, reproducing the bounded round-loop
  control flow named in §10.5)
- Full unit + simulation test suite (§11.1, §11.2)
- `tests/unit/supervisorIsolation.spec.ts` (§10.3)

**Milestone 6B (optional LLM-backed adapter, deferred, not required for 6A's acceptance):**
- `src/orchestration/supervisor/llmSupervisorAdapter.ts`, `supervisorPrompts.ts` (§5)
- Additional unit tests for the sentinel-JSON grammar's fail-safe parsing (mirroring
  `structuredClaimParser.spec.ts`'s own test matrix style)

**Milestone 6C (real-browser smoke verification, deferred until 6A is implemented):**
- `scripts/smoke-supervised-review.ts` + `npm run smoke:supervised-review` (§11.3)
- Manual real-site verification and closeout recorded in `DECISIONS.md`/`REVIEW.md`,
  following the exact precedent Milestones 4A/4B/5 each already established

No phase in this plan requires touching any Milestone 4A/4B/5 file. 6A alone delivers
every capability named in the original mandate (stagnation detection, decision
consistency checking, human escalation recommendation, abnormal workflow detection); 6B
and 6C are named, scoped extensions, not prerequisites.

---

## 13. Open questions (explicitly deferred, not decided here)

1. **Should a flag ever fire without recommending escalation** (a lower-priority "FYI, no
   action needed" tier)? Deferred — §6.5's current rule (`escalationRecommended :=
   flags.length > 0`) is the simplest rule that satisfies the mandate; a graduated
   severity model for flags themselves is a natural but unbuilt future refinement.
2. **Should `runAuditedReviewLoop.ts` eventually be refactored to expose a formal
   per-round extension hook**, so a future third supervisor-style layer doesn't need to
   duplicate round-loop control flow the way Milestone 6 necessarily does (§10.5)? Named
   as a future reconsideration point, not decided or built now.
3. **Should the LLM-backed Supervisor adapter (§5) ever be bound to a third, dedicated
   review participant** rather than reusing one of the two existing adapters? Explicitly
   out of scope — would require new browser code, which every milestone to date,
   including this one, has avoided.
4. **Should `SupervisedReviewResult` ever be persisted to disk** (`runs/<run-id>/
   supervisor.json`, alongside the `ledger.json`/`round-NN-*.json` layout named but never
   built in `MILESTONE4B_DESIGN.md` §12 and `MILESTONE5_DESIGN_v5.md` §12.1)? Deferred,
   for the same reason persistence has been deferred at every prior milestone: it is a
   substantial, separable concern deserving its own design pass, not something to fold
   silently into this one.

---

## 14. File / module plan

**New files (none created by this design turn — design only):**

- `src/orchestration/supervisor/types.ts` (§4, §8.1)
- `src/orchestration/supervisor/deterministicSupervisor.ts` (§6)
- `src/orchestration/supervisor/supervisedHumanGate.ts` (§3.3)
- `src/orchestration/supervisor/llmSupervisorAdapter.ts`, `supervisorPrompts.ts` (§5, 6B)
- `src/orchestration/runSupervisedReviewLoop.ts` (§3.2)
- `scripts/smoke-supervised-review.ts` + `npm run smoke:supervised-review` (§11.3, 6C)
- `tests/unit/deterministicSupervisor.spec.ts`, `supervisorFailureHandling.spec.ts`,
  `supervisedHumanGate.spec.ts`, `supervisorIsolation.spec.ts`,
  `runSupervisedReviewLoop.spec.ts`

**Explicitly untouched:** every file under `src/orchestration/convergence/`,
`src/orchestration/claims/`, `src/orchestration/humanGate/`, `src/orchestration/shared/`,
`runFixedReviewLoop.ts`, `fixedReviewPrompts.ts`, `runConvergenceReviewLoop.ts`,
`runAuditedReviewLoop.ts`, every file under `src/sites/` and `src/browser/`, every
existing script, `src/config/loadConfig.ts`, `config/config.json`, and every existing
test file.
