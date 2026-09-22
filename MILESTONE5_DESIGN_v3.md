# MILESTONE5_DESIGN_v3.md — Auditable multi-agent review system (Claim Ledger + Human Gate)

Design-only document for Phase 2A Milestone 5. **No production TypeScript is changed by
this document.** This revision supersedes `MILESTONE5_DESIGN_v2.md` after a principal
architect review identified three BLOCKING and four MEDIUM issues in v2. It builds on the
frozen Milestone 4A fixed-round loop and the frozen (behaviorally/contract-frozen, §9.1)
Milestone 4B convergence-driven loop.

---

## Revision history

**v3 (this revision) — applied all eight mandatory changes from the principal architect
review of v2, before any implementation:**

1. **All decision paths now flow through one Decision Engine; the parse-failure hardcoded
   bypass is removed.** v2's round lifecycle (§14) hardcoded `CONTINUE_RECOMMENDED` on a
   parse failure without ever consulting §8's priority-ordered rule — regressing the
   exact two-decision-point anti-pattern `MILESTONE4B_DESIGN.md`'s own revision history
   already fixed once. v3's Decision Engine (§8) now takes an explicit
   `invalidReviewThisRound` input and evaluates it as one more branch in the *same*
   priority order, after `hardMaxRounds`/chronic-claim checks and before the accept check
   — never as a separate code path. Closes BLOCKING #1.
2. **Outcome origin is now a three-way, explicit discriminator**, distinguishing a human
   agreeing with the recommendation, a human overriding it, and a hard safety override
   the human never actually chose (§7.6, §12.2). Closes BLOCKING #3 (the part concerning
   inability to distinguish these cases).
3. **A new run-level audit event log (`RunAuditEvent`/`runAuditTrail`)** gives every forced
   system decision (hardMaxRounds override, invalid-review encounters, human overrides of
   a recommendation) a concrete, queryable home — the "distinguishing history event" §6.5
   promised in v2 but had nowhere to store. Closes the remainder of BLOCKING #3.
4. **`schemaVersion` design corrected to use versioned wrappers/snapshots.** v2 excluded
   `ClaimLedgerEntry`/the ledger array and `AuditedRoundRecord` from versioning under a
   criterion that contradicted the persistence layout (`ledger.json`, `round-NN-*.json`)
   this document and `MILESTONE4B_DESIGN.md` §12 both anticipate. v3 gives
   `AuditedRoundRecord` its own `schemaVersion` directly and introduces a new
   `ClaimLedgerSnapshot` wrapper (versioned) as the unit a future persistence layer would
   actually write to `ledger.json` (§12.1). Closes BLOCKING #2.
5. **Claim vs Objection semantics clarified explicitly, by definition, not by adding a
   discriminator.** v3 states plainly: **in Milestone 5A, every Claim is an
   objection-shaped review issue** — the same lifecycle 4B's objections had, extended with
   evidence/confidence, and nothing more general. A broader claim taxonomy (Generator-
   origin assertions, etc.) is named as an explicit, deferred future extension, not built
   speculatively now (§4.6). Closes MEDIUM #1.
6. **Evidence lifecycle semantics are now explicitly defined**, closing the "can an
   individual objection be resolved independently of its claim" ambiguity: Evidence is
   immutable and has **no independent status** by deliberate design; a specific piece of
   evidence is only ever "addressed" implicitly (via its parent claim resolving) or
   explicitly (via a new, superseding Evidence record) — never via an in-place status
   change (§5.5). Closes MEDIUM #2.
7. **Severity-rule extraction now precisely specifies the pure/local boundary.** v3 gives
   the exact call-site-level pseudocode showing that `shared/severityRules.ts` contains
   *only* arithmetic (no mutation, no history, no knowledge of `status`/`lastSeenRound`),
   while every ledger module (`objectionLedger.ts`, `claims/claimLedger.ts`) keeps 100% of
   the mutation/history-push responsibility locally (§9.1). Closes MEDIUM #3.
8. **`severityRank` naming collision resolved.** The shared module's lookup table is
   renamed `SEVERITY_ORDER` (a `Record`, not a function), with a separate `rankOf()`
   helper function — neither name collides with `objectionLedger.ts`'s already-exported
   `severityRank` function, which becomes a one-line delegating wrapper with its existing
   signature and behavior fully preserved (§9.1, §9.4). Closes MEDIUM #4.

Everything not named above (overall goal, 5A/5B phasing, the two-adapter/no-new-browser-
code principle, most field names) is unchanged from v2's reasoning and is restated below
so this document remains self-contained.

---

## 0. Inspection summary

Same repository inspection as v1/v2, plus the principal architect review of v2 itself,
whose findings are the direct input to every change listed above. All facts re-confirmed
in v2 §0 still hold, including the precise, re-verified fact that `objectionLedger.ts`
exports only `createEmptyLedger`, `cloneLedger`, `countsForLedger`, `ingestReview`,
`ingestStructuredReview`, `severityRank`, and `InvalidLedgerIngestError` — its `adjust`/
`reopen` helpers remain private and unexported, which is exactly why §9.1's migration plan
needs the precision this revision adds.

---

## 1. Goal / Non-goals

Unchanged from v2 (see `MILESTONE5_DESIGN_v2.md` §1): Milestone 5A delivers Claim Ledger +
Decision Engine + Human Gate, with evidence as a data layer only (no live LLM elicitation
— that is 5B, §5.4/§6.4 below). All of v2's non-goals stand.

**One clarification added in v3, directly from mandatory change 5:** the goal statement's
phrase "a richer Claim Ledger" is now explicitly scoped — see §4.6. Milestone 5A does not
introduce a general-purpose claim taxonomy; it introduces an **evidence- and confidence-
bearing objection ledger**, renamed "Claim Ledger" for continuity with the task's own
vocabulary, not a structurally new kind of assertion-tracking.

---

## 2. Current state recap (frozen foundation)

Unchanged from v2.

---

## 3. Architecture evolution

Unchanged from v2 (§3.1, §3.2), with one addition to the §3.2 diagram: the `shared/
severityRules.ts` box is now annotated "pure arithmetic only — no mutation, no history"
to reflect §9.1's corrected boundary.

---

## 4. Claim Ledger enhancement

### 4.1 Field-by-field evolution table

Unchanged from v2 §4.1, with the severity-rule reuse row's wording tightened to match
§9.1's precise pure/local split (arithmetic only is shared; mutation/history stays local
to each ledger module — previously stated less precisely as "computed by the shared
function").

### 4.2 Confidence (unchanged from v1/v2)

### 4.3 The `DISPUTED` status band (unchanged from v1/v2)

### 4.4 Resolution history (unchanged from v1/v2)

### 4.5 Severity rules — pure calculation shared, mutation/history stays local

See §9.1 for the full, corrected design (mandatory changes 7 and 8). The one-sentence
summary: `claimLedger.ts` calls `shared/severityRules.ts`'s pure functions to compute
*what the new severity should be*, then — exactly like `objectionLedger.ts` — performs its
own mutation of `severity`/`highestSeveritySeen`/`status`/`lastSeenRound` and its own
`history` push, using its own local event vocabulary (`ClaimHistoryEventKind`, not
`ObjectionHistoryEvent`'s kind union). No history-shaped or mutation-shaped code lives in
`shared/`.

### 4.6 Claim vs Objection — explicit definition (mandatory change 5, MEDIUM #1 fix)

**Milestone 5A's `ClaimLedgerEntry` is, by deliberate and explicit design choice, an
objection-shaped review issue — nothing more general.** A "claim" in this document means
exactly what an "objection" meant in `MILESTONE4B_DESIGN.md`: a Reviewer-raised assertion
that something about the current answer is deficient, now carrying evidence references and
a confidence score in addition to severity and status. It is:

- **Raised only by the Reviewer Agent** (§7.2) — never by the Generator, never
  spontaneously by the engine.
- **Lifecycle-identical to 4B's objections** — `OPEN`/`DISPUTED`/`RESOLVED`/`REJECTED`,
  severity blocking acceptance exactly as `MILESTONE4B_DESIGN.md` §6 specified.

**What this explicitly is not, and why that's fine for 5A:** a general-purpose assertion
type that could represent, e.g., a factual claim embedded in the Generator's own answer
(independently trackable, independently challengeable) is **not** built here. Adding such a
type now, with no concrete consumer in 5A's own scope, would be exactly the kind of
speculative generalization this project's own established discipline avoids (see how 4B
deferred semantic paraphrase detection, and how 5A itself defers the Evidence Agent to 5B
rather than building it "just in case"). If a future milestone needs a genuinely broader
claim taxonomy, it should add a `claimType` discriminator **then**, informed by an actual
second use case — not speculatively now.

**Renaming rationale restated, now precise:** the type is called `ClaimLedgerEntry`, not
`ObjectionLedgerEntry`, purely because it carries evidence/confidence fields 4B's
objections never had — the name change reflects *richer bookkeeping on the same concept*,
not *a different, more general concept*. Every place this document (or its future
implementation) uses the word "claim," a reader should mentally substitute "objection,
now evidence-and-confidence-bearing" — they are the same thing.

---

## 5. Evidence tracking system (5A scope: data layer only)

### 5.1 `Evidence` (unchanged shape from v1/v2, §5.1)

### 5.2 What each claim supports (unchanged mapping from v1/v2, §5.2)

### 5.3 Evidence sources in 5A (unchanged from v2 §5.3: structural resolution evidence + human-supplied evidence at the gate)

### 5.4 Evidence Agent (5B — unchanged from v2 §5.4, still deferred)

### 5.5 Evidence lifecycle semantics (mandatory change 6, MEDIUM #2 fix)

**Evidence has exactly one state: created.** There is no `EvidenceStatus` type and none is
added. This is a deliberate, explicit design decision, stated here rather than left
ambiguous:

- An `Evidence` record, once created, **never changes** and is **never individually
  marked addressed, resolved, or withdrawn.**
- A specific piece of `CHALLENGING` evidence is considered "dealt with" only in one of two
  ways, both already fully supported by the existing schema:
  1. **Implicitly**, when its parent claim's `status` moves to `RESOLVED` or `REJECTED` —
     at that point *all* evidence attached to the claim, supporting and challenging alike,
     is understood to have been weighed and the claim's terminal status is the answer.
  2. **Explicitly**, when a *new* `Evidence` record is created that specifically rebuts an
     earlier one, using the existing optional `supersedesEvidenceId` field (§5.1) to link
     it — e.g. a `SUPPORTING` record whose `text` explains why an earlier `CHALLENGING`
     record no longer applies. The earlier record is **not** deleted, edited, or flagged;
     both remain visible in `evidenceLog`, preserving the full back-and-forth for audit.
- **Why not give Evidence its own independent lifecycle** (e.g. an `ADDRESSED` status a
  human or Reviewer could set on one specific piece of evidence without touching the whole
  claim)? Because 5A's claims are objection-shaped (§4.6) and objections resolve as a
  whole — 4B never needed to track "this specific sentence of the objection's `reason` was
  addressed, but not that other sentence." Introducing per-evidence resolution now would
  be new state-machine complexity with no scoped 5A consumer. If practice shows bulk-only
  resolution is insufficient (e.g. a claim has five independent challenging points and a
  Generator addresses three), this is named here as the natural place to extend the
  design later — **not solved by silently avoiding the question**, which is what v1/v2
  did.

This closes the ambiguity the architect review identified: "how should objections attach
to claims" now has a precise answer — a challenging or supporting piece of evidence
attaches to exactly one claim via `claimId`, is immutable, and is never independently
resolved; only the claim it belongs to carries resolvable status.

---

## 6. Human decision gate

### 6.1 Placement in the lifecycle (unchanged shape from v2 §6.1)

### 6.2 Gate contract (updated: outcome-origin fields)

```ts
// design sketch — src/orchestration/humanGate/humanGate.ts (new module)
export type HumanGateOutcome = "CONTINUE" | "ACCEPT" | "REJECT";
export type RecommendationAgreement = "AGREED" | "OVERRODE";

export interface HumanGatePresentation {
  round: number; currentAnswer: string;
  recommendation: DecisionRecommendation;         // §8
  disputedClaims: ClaimLedgerEntry[];
  claimLedgerDelta: ClaimLedgerEntry[];
  relevantEvidence: Evidence[];
  legalOutcomes: HumanGateOutcome[];
}

export interface HumanGateResponse {
  schemaVersion: number;
  requestedOutcome: HumanGateOutcome;          // what the human/gate actually returned
  outcome: HumanGateOutcome;                   // what was actually acted on — differs
                                                 // from requestedOutcome ONLY under a
                                                 // hard safety override (§6.5, §7.6)
  recommendationAgreement: RecommendationAgreement;  // requestedOutcome vs. this round's
                                                       // recommendation.kind (§7.6)
  hardSafetyOverride?: { reason: string };     // present only when outcome !== requestedOutcome
  rationale?: string;                          // REQUIRED when requestedOutcome === "REJECT"
  decidedAt: string;
}

export interface HumanGate {
  presentAndAwaitDecision(presentation: HumanGatePresentation): Promise<HumanGateResponse>;
}
```

`recommendationAgreement` and `hardSafetyOverride` are computed by the **orchestrator**,
never by the `HumanGate` implementation itself (real or fake) — a `HumanGate`
implementation only ever fills in `requestedOutcome`, optional `rationale`, and
`decidedAt`; `runAuditedReviewLoop.ts` derives everything else after receiving the raw
response (§7.6).

### 6.3 Production implementation: blocking terminal prompt (unchanged from v2 §6.3)

### 6.4 Evidence attachment at the gate (unchanged from v2 §6.4)

### 6.5 hardMaxRounds enforcement — two independent layers (updated: wires into run-level audit events)

Unchanged mechanism from v2 §6.5 (gate-level input restriction + independent orchestrator-
level validation), with one addition: when Layer 2 fires (the orchestrator overrides a
`CONTINUE` request into a forced `REJECTED`), it now:

1. Sets `HumanGateResponse.outcome := "REJECTED"` while preserving
   `requestedOutcome := "CONTINUE"` (the human's/gate's actual input, never erased).
2. Sets `hardSafetyOverride := { reason: "hardMaxRounds (<n>) reached; a CONTINUE request
   past the ceiling was not honored" }`.
3. Appends a `RunAuditEvent` of kind `"HARD_MAX_ROUNDS_OVERRIDE"` to
   `AuditedReviewResult.runAuditTrail` (§7.6, §12.2) — this is the concrete home for the
   "distinguishing history event" v2's §6.5 promised but never gave a type to hold.

### 6.6 `FakeHumanGate` isolation rules (unchanged from v2 §6.6)

---

## 7. Multi-agent roles

### 7.1 Generator Agent (unchanged) / 7.2 Reviewer Agent (unchanged) / 7.3 Evidence Agent — 5B (unchanged) / 7.4 Decision Engine (see §8, now unified)

### 7.5 Role summary table (unchanged from v2)

### 7.6 Outcome origin — three-way discriminator (mandatory change 2, BLOCKING #3 fix)

The architect review's finding was precise: three semantically distinct events were
previously collapsed into one boolean-shaped `"ACCEPTED"|"REJECTED"` outcome. v3 makes all
three representable and mechanically derivable, never asserted redundantly:

```ts
export type TerminalOutcomeOrigin =
  | "HUMAN_AGREED_WITH_RECOMMENDATION"
  | "HUMAN_OVERRODE_RECOMMENDATION"
  | "HARD_SAFETY_OVERRIDE";
```

**Derivation rule, computed once at the terminal round, never independently asserted:**

```
terminalRound := rounds[rounds.length - 1]
response := terminalRound.humanGateResponse

outcomeOrigin :=
  if response.hardSafetyOverride is present:           "HARD_SAFETY_OVERRIDE"
  else if response.recommendationAgreement === "AGREED": "HUMAN_AGREED_WITH_RECOMMENDATION"
  else:                                                  "HUMAN_OVERRODE_RECOMMENDATION"
```

`recommendationAgreement` itself is computed **every round** (not only the terminal one),
by the orchestrator, immediately after receiving a `HumanGateResponse`:

```
mapping: CONTINUE_RECOMMENDED ↔ "CONTINUE", ACCEPT_RECOMMENDED ↔ "ACCEPT",
         REJECT_RECOMMENDED   ↔ "REJECT"

recommendationAgreement :=
  requestedOutcome matches the mapped recommendation.kind for this round ? "AGREED" : "OVERRODE"
```

Recording this every round (not only at the end) is deliberate: a human who overrides an
`ACCEPT_RECOMMENDED` into `CONTINUE` three times before finally accepting (one of v2's own
§12.2 simulation scenarios) now has each of those three overrides individually visible in
the audit trail, not just the final round's classification — directly serving §10's "every
decision must be explainable" goal, at every point along the run, not only at its end.

`AuditedReviewResult.outcomeOrigin` (§12.2) stores the terminal round's derived value as a
convenience field for readers who only care about the final outcome, exactly mirroring how
4B's `ConvergedReviewResult` surfaces top-level fields (`stopReason`, `finalAnswer`) that
are themselves fully derivable from `rounds`.

---

## 8. Decision Engine specification (updated: unifies the parse-failure path, mandatory change 1, BLOCKING #1 fix)

### 8.1 Inputs (updated — one new input added)

All inputs from v2 §8.1 (`openHighCount`, `openMediumCount`, `disputedCount`,
`chronicClaims`, `lowConfidenceResolutions`, `averageConfidence`, `cleanStreak`, `round`,
`hardMaxRounds`, `recommendedMaxRounds`), **plus:**

- `invalidReviewThisRound: { reason: string } | null` — non-null exactly when this round's
  Reviewer response failed to parse (§structuredClaimParser). When non-null, every
  ledger-derived count above (`openHighCount` etc.) is computed from the ledger **as it
  stood at the end of the previous round** — an invalid review never contributes new
  ledger state, exactly matching 4B's `INVALID_REVIEW` handling
  (`MILESTONE4B_DESIGN.md` §8.3: "cleanStreak and the ledger are left exactly as they were
  at the end of round r-1").

### 8.2 Clean round definition (unchanged from v2 §8.2)

```
isCleanRound(r) :=  openHighCount(r) === 0 AND openMediumCount(r) === 0
                AND disputedCount(r) === 0 AND lowConfidenceResolutions(r) === 0
cleanStreak(r)  :=  isCleanRound(r) ? cleanStreak(r-1) + 1 : 0
```

An invalid review round is, by construction, evaluated with round `r`'s counts identical
to round `r-1`'s — so `isCleanRound(r)` trivially equals `isCleanRound(r-1)`, and
`cleanStreak` is carried forward unchanged rather than incremented or reset. This is a
direct consequence of §8.1's carried-forward-counts rule, not a separate special case.

### 8.3 Chronic-claim reject trigger (unchanged from v2 §8.3)

### 8.4 Decision priority order — corrected: single function, single priority order, no external bypass

**This is the direct fix for mandatory change 1.** Every decision path — a normally-parsed
review, a parse failure, `hardMaxRounds` proximity, a chronic claim — is evaluated by
exactly this one function, in exactly this priority order. No caller (§14's round lifecycle
included) is permitted to compute or hardcode a `DecisionRecommendation.kind` outside this
function.

```
1. if round >= hardMaxRounds:
      kind := REJECT_RECOMMENDED
      reason := "hardMaxRounds (<n>) reached"

2. else if any claim in the ledger isChronic (§8.3):
      kind := REJECT_RECOMMENDED
      reason := "claim <id> reopened >= reopenRejectThreshold times"

3. else if invalidReviewThisRound is not null:                                   // NEW
      kind := CONTINUE_RECOMMENDED
      reason := "reviewer response could not be parsed this round: <reason>;
                 ledger unchanged from round <r-1>"
      // Never ACCEPT here: an unparseable round cannot be treated as validating
      // anything new. If cleanStreak already reached the stability window as of
      // round r-1, that should already have produced an ACCEPT_RECOMMENDED on round
      // r-1 itself — this round's failure does not retroactively grant it.

4. else if round > recommendedMaxRounds:
      kind := CONTINUE_RECOMMENDED
      reason := "round budget (recommendedMaxRounds=<n>) exceeded; consider REJECT or a
                 manual ACCEPT override if remaining claims are judged immaterial"

5. else if isCleanRound(r) AND cleanStreak(r) >= stabilityWindowRounds:
      kind := ACCEPT_RECOMMENDED
      reason := "<cleanStreak> consecutive clean rounds, no open HIGH/MEDIUM, no disputed
                 claims, no low-confidence resolutions"

6. else:
      kind := CONTINUE_RECOMMENDED
      reason := "<openHighCount> open HIGH, <openMediumCount> open MEDIUM,
                 <disputedCount> disputed, <lowConfidenceResolutions> low-confidence
                 resolution(s) remaining"
```

Branch 3's position — **after** `hardMaxRounds`/chronic-claim, **before** the soft-budget
and accept checks — is deliberate and is the exact fix for the architect review's finding:
`hardMaxRounds`/chronic-claim conditions must still take precedence even when this round's
review failed to parse (a run that's already exhausted its hard ceiling doesn't get a
free pass just because the final round's response happened to be malformed), while a mere
parse failure must never itself manufacture an `ACCEPT_RECOMMENDED`.

### 8.5 Default thresholds (unchanged from v2 §8.5)

### 8.6 Updated `DecisionRecommendation` shape (one new optional field)

```ts
export interface DecisionRecommendation {
  kind: "CONTINUE_RECOMMENDED" | "ACCEPT_RECOMMENDED" | "REJECT_RECOMMENDED";
  round: number; reason: string; cleanStreak: number;
  openHighCount: number; openMediumCount: number; disputedCount: number;
  averageConfidence: number; lowConfidenceResolutionCount: number;
  invalidReview?: { reason: string };   // NEW — present iff this round's recommendation
                                          // came from §8.4 branch 3, so a reader of the
                                          // recommendation alone (without cross-referencing
                                          // the round record) can see it was parse-failure-
                                          // driven, not a normal ledger evaluation
}
```

### 8.7 Worked consequences (updated: one new bullet)

All of v2 §8.7's consequences hold, plus:

- **A parse failure never bypasses `hardMaxRounds` or the chronic-claim check** — both
  are evaluated first, using the ledger state carried forward from the previous round,
  exactly as they would be for a normally-parsed round. A run that fails to parse on its
  very last permitted round still correctly recommends `REJECT` (branch 1), not
  `CONTINUE` (which v2's hardcoded bypass would have incorrectly produced).

---

## 9. Backward compatibility

### 9.1 What "frozen" precisely means in v3 (corrected: precise pure/local boundary + renamed symbol)

Unchanged core rule from v2 §9.1 (behavioral/contract freeze, verified by the unmodified
133-test suite, with exactly one permitted internal-only migration in
`objectionLedger.ts`). **v3 corrects the migration's design to specify the pure/local
boundary precisely (mandatory change 7) and removes the naming collision (mandatory
change 8):**

```ts
// design sketch — src/orchestration/shared/severityRules.ts (new module)
// PURE ARITHMETIC ONLY. No mutation. No knowledge of `status`, `lastSeenRound`, or
// `history`. Operates on the minimal structural shape both ledger entry types satisfy.

export const SEVERITY_ORDER: Record<ReviewSeverity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
export const rankOf = (s: ReviewSeverity): number => SEVERITY_ORDER[s];
//            ^^^^^^ deliberately NOT named `severityRank` — objectionLedger.ts already
//            exports a function of that name with a different shape's-worth of callers
//            depending on it; reusing the name here would create a same-name,
//            different-module, different-call-convention collision (mandatory change 8).

export type SeverityAdjustEvent = "ESCALATED" | "DOWNGRADE_REJECTED" | "UNCHANGED";
export interface SeverityAdjustResult {
  newSeverity: ReviewSeverity;
  newHighestSeveritySeen: ReviewSeverity;
  event: SeverityAdjustEvent;
}
export function computeAdjustedSeverity(
  currentSeverity: ReviewSeverity,
  currentHighestSeveritySeen: ReviewSeverity,
  proposedSeverity: ReviewSeverity,
): SeverityAdjustResult { /* escalate-applies / downgrade-rejects, pure */ }

export interface SeverityReopenResult {
  newSeverity: ReviewSeverity;
  newHighestSeveritySeen: ReviewSeverity;
  floored: boolean;   // true iff the floor rule changed the requested/prior severity upward
}
export function computeReopenSeverity(
  severityAtResolution: ReviewSeverity,
  highestSeveritySeen: ReviewSeverity,
  override: ReviewSeverity | undefined,
): SeverityReopenResult { /* floors at historical peak, pure */ }
```

**Exact call-site reconciliation in `objectionLedger.ts` (the one permitted internal
edit — mutation and history-push stay 100% local, exactly as today):**

```ts
// objectionLedger.ts — private, unexported, UNCHANGED in signature/behavior from today
function adjust(e: ObjectionLedgerEntry, proposed: ReviewSeverity, r: number): void {
  const result = computeAdjustedSeverity(e.severity, e.highestSeveritySeen, proposed);
  if (result.event === "UNCHANGED") return;
  const old = e.severity;
  e.severity = result.newSeverity;                       // mutation — stays local
  e.highestSeveritySeen = result.newHighestSeveritySeen;  // mutation — stays local
  if (result.event === "ESCALATED") add(e, r, "SEVERITY_CHANGED", old + " -> " + result.newSeverity);
  else add(e, r, "SEVERITY_DOWNGRADE_REJECTED", old + " -> " + proposed);  // history — stays local
}

function reopen(e: ObjectionLedgerEntry, override: ReviewSeverity | undefined, r: number, note: string): void {
  const result = computeReopenSeverity(e.severity, e.highestSeveritySeen, override);
  const old = e.severity;
  e.status = "OPEN";                                       // mutation — stays local
  e.severity = result.newSeverity;                          // mutation — stays local
  e.highestSeveritySeen = result.newHighestSeveritySeen;    // mutation — stays local
  if (old !== result.newSeverity) add(e, r, "SEVERITY_CHANGED", old + " -> " + result.newSeverity + " (reopen floor)");
  add(e, r, "REOPENED", note);                              // history — stays local
  e.lastSeenRound = r;                                       // mutation — stays local
}

export const severityRank = (x: ReviewSeverity): number => rankOf(x);  // thin delegating
//           ^^^^^^^^^^^^ existing exported name/signature UNCHANGED — every external
//           caller of objectionLedger.ts's severityRank keeps working identically;
//           only its internal implementation now delegates to shared/severityRules.ts
```

`claims/claimLedger.ts` performs the exact same reconciliation pattern against its own
`ClaimLedgerEntry` shape and its own `ClaimHistoryEventKind` vocabulary — calling
`computeAdjustedSeverity`/`computeReopenSeverity`, then doing its own local mutation and
`ClaimHistoryEvent` push. Neither ledger module ever imports the other; both depend only
on `shared/severityRules.ts` (§9.4's isolation test enforces the one-directional
dependency).

**Acceptance gate, unchanged from v2:** this migration lands as its own isolated change,
`objectionLedger.spec.ts` passing unmodified at 133/133, before any `claims/` code is
written against `shared/severityRules.ts`.

### 9.2 Frozen list (unchanged from v2 §9.2, with the one exception restated per §9.1's corrected precision)

### 9.3 New, additive-only (unchanged from v2 §9.3)

### 9.4 Isolation tests required (unchanged from v2 §9.4)

---

## 10. Audit trail — now grounded in a concrete run-level event log (mandatory change 3, remainder of BLOCKING #3)

**Every decision must be explainable** (unchanged goal from v1/v2). What's new in v3: the
mechanism for run-level (non-claim-scoped) explanations now has a concrete type, not just
a prose promise.

```ts
export type RunAuditEventKind =
  | "HARD_MAX_ROUNDS_OVERRIDE"          // §6.5 Layer 2 fired
  | "INVALID_REVIEW_ENCOUNTERED"        // §8.4 branch 3 fired
  | "RECOMMENDATION_OVERRIDDEN_BY_HUMAN" // recommendationAgreement === "OVERRODE" (§7.6)
  | "HUMAN_EVIDENCE_ATTACHED";          // §6.4

export interface RunAuditEvent {
  round: number;
  kind: RunAuditEventKind;
  detail: string;
  recordedAt: string;
}
```

`AuditedReviewResult.runAuditTrail: RunAuditEvent[]` (§12.2) is a flat, append-only,
filterable-by-round log — symmetric with how `evidenceLog` already works (flat, not
nested per round). This is the concrete home for every "the engine did X instead of what
was asked" and "a human disagreed with the AI here" moment, closing the exact gap the
architect review identified: §6.5's prose promise of "a distinguishing history event" now
has a real type to populate.

### 10.1 Reconstructing "why," updated

All of v2 §8.1's (renumbered here) lookup table still holds; add one more row:

| Question | How it's answered |
|---|---|
| Why did the run's final outcome differ from what the human actually asked for? | `outcomeOrigin === "HARD_SAFETY_OVERRIDE"` (§7.6) points directly to the matching `RunAuditEvent` of kind `"HARD_MAX_ROUNDS_OVERRIDE"` in `runAuditTrail`, whose `detail` gives the full reason — no need to infer this from comparing fields across two different records. |

---

## 11. (reserved — see §8 for the Decision Engine; §7.6 for outcome origin)

---

## 12. Data model (consolidated design sketch — updated: schemaVersion wrappers, outcome-origin types, run audit events)

### 12.1 `schemaVersion` design — corrected (mandatory change 4, BLOCKING #2 fix)

**Corrected rule:** a `schemaVersion` belongs on every type that is, or plausibly will be,
**an independently-persistable unit** — judged against the persistence layout this
document and `MILESTONE4B_DESIGN.md` §12 both name (`runs/<run-id>/rounds/round-NN-*.json`,
a top-level `ledger.json`), not against a vaguer "does it ever travel alone" heuristic
(v2's mistake).

| Type | Versioned? | Why |
|---|---|---|
| `AuditedReviewResult` | **Yes** — top-level unit | Always the outermost persisted container. |
| `AuditedRoundRecord` | **Yes (added in v3)** | Directly maps to the anticipated `round-NN-*.json` per-round file (`MILESTONE4B_DESIGN.md` §12) — an independently-persistable unit by the design's own stated precedent, contrary to v2's exclusion. |
| `ClaimLedgerSnapshot` (**new wrapper type, v3**) | **Yes** | The unit that maps to the anticipated `ledger.json` file. Raw `ClaimLedgerEntry[]` has no field to carry a version (arrays don't have fields) — a wrapper is exactly what "use versioned persisted wrappers/snapshots" (mandatory change 4) calls for. |
| `HumanGateResponse` | **Yes** (unchanged from v2) | Plausible unit of a future independent, append-only decision log. |
| `ClaimLedgerEntry`, `Evidence`, `DecisionRecommendation`, `HumanGatePresentation`, `ConfidenceChangeEvent`, `ClaimHistoryEvent`, `RunAuditEvent` | No | Each only ever travels inside an already-versioned container (`AuditedReviewResult`, `AuditedRoundRecord`, or `ClaimLedgerSnapshot`) — never read or serialized independently of one. |

```ts
export const AUDITED_REVIEW_SCHEMA_VERSION = 1;
export const AUDITED_ROUND_SCHEMA_VERSION = 1;
export const CLAIM_LEDGER_SNAPSHOT_SCHEMA_VERSION = 1;
export const HUMAN_GATE_RESPONSE_SCHEMA_VERSION = 1;

export interface ClaimLedgerSnapshot {     // NEW — the unit a future persistence layer
                                             // writes to ledger.json; not used internally
                                             // during a run (AuditedReviewResult.claimLedger
                                             // stays a plain array, already covered by its
                                             // own top-level version, §12.2)
  schemaVersion: number;
  round: number;              // the round as of which this snapshot was taken
  entries: ClaimLedgerEntry[];
}
```

A future persistence layer would call a (not-yet-implemented, named-only)
`snapshotClaimLedger(entries, round): ClaimLedgerSnapshot` whenever it writes `ledger.json`
— named here so the eventual persistence design has an obvious, already-agreed-upon
target shape, without 5A itself writing anything to disk (§1's non-goals, unchanged).

### 12.2 Full sketch (updated)

```ts
// design sketch — src/orchestration/claims/types.ts (new module; does not edit
// src/orchestration/convergence/types.ts)

export type ReviewSeverity = "HIGH" | "MEDIUM" | "LOW";
export type ClaimStatus = "OPEN" | "DISPUTED" | "RESOLVED" | "REJECTED";
export type EvidenceKind = "SUPPORTING" | "CHALLENGING" | "RESOLUTION";
export type EvidenceStrength = "STRONG" | "MODERATE" | "WEAK";
export type EvidenceSourceRole = "GENERATOR" | "REVIEWER" | "EVIDENCE_AGENT" | "HUMAN"; // EVIDENCE_AGENT unused until 5B

export interface Evidence {          // §5.5 — immutable, no independent status, ever
  id: string; claimId: string; kind: EvidenceKind; strength: EvidenceStrength;
  sourceRole: EvidenceSourceRole; text: string; round: number; submittedAt: string;
  supersedesEvidenceId?: string;
}

export interface ConfidenceChangeEvent {
  round: number; previousConfidence: number; newConfidence: number; causeEvidenceId: string;
}

export type ClaimHistoryEventKind =
  | "RAISED" | "REPEATED" | "PARAPHRASED" | "RESOLVED" | "REJECTED" | "REOPENED"
  | "IMPLICITLY_CARRIED_OPEN" | "SEVERITY_CHANGED" | "SEVERITY_DOWNGRADE_REJECTED"
  | "DUPLICATE_COLLAPSED" | "EVIDENCE_ADDED" | "CONFIDENCE_CHANGED" | "DISPUTED"
  | "UNDISPUTED" | "HUMAN_DECISION_RECORDED";

export interface ClaimHistoryEvent {
  round: number; kind: ClaimHistoryEventKind; detail?: string;
  resolutionEvidenceRef?: string;
}

export interface ClaimLedgerEntry {   // §4.6 — an objection-shaped review issue, by definition
  id: string; claim: { statement: string; rationale: string };
  severity: ReviewSeverity; highestSeveritySeen: ReviewSeverity;
  confidence: number; status: ClaimStatus;
  evidenceFor: string[]; evidenceAgainst: string[];
  confidenceHistory: ConfidenceChangeEvent[];
  firstSeenRound: number; lastSeenRound: number;
  normalizedFingerprint: string[];
  history: ClaimHistoryEvent[];
}

export interface ClaimLedgerSnapshot {   // §12.1 — NEW, versioned, future ledger.json unit
  schemaVersion: number; round: number; entries: ClaimLedgerEntry[];
}

export interface DecisionRecommendation {   // §8.6
  kind: "CONTINUE_RECOMMENDED" | "ACCEPT_RECOMMENDED" | "REJECT_RECOMMENDED";
  round: number; reason: string; cleanStreak: number;
  openHighCount: number; openMediumCount: number; disputedCount: number;
  averageConfidence: number; lowConfidenceResolutionCount: number;
  invalidReview?: { reason: string };
}

export type HumanGateOutcome = "CONTINUE" | "ACCEPT" | "REJECT";
export type RecommendationAgreement = "AGREED" | "OVERRODE";

export interface HumanGatePresentation {    // §6.2
  round: number; currentAnswer: string;
  recommendation: DecisionRecommendation;
  disputedClaims: ClaimLedgerEntry[]; claimLedgerDelta: ClaimLedgerEntry[];
  relevantEvidence: Evidence[]; legalOutcomes: HumanGateOutcome[];
}

export interface HumanGateResponse {         // §6.2, §7.6
  schemaVersion: number;
  requestedOutcome: HumanGateOutcome; outcome: HumanGateOutcome;
  recommendationAgreement: RecommendationAgreement;
  hardSafetyOverride?: { reason: string };
  rationale?: string; decidedAt: string;
}

export type RunAuditEventKind =              // §10
  | "HARD_MAX_ROUNDS_OVERRIDE" | "INVALID_REVIEW_ENCOUNTERED"
  | "RECOMMENDATION_OVERRIDDEN_BY_HUMAN" | "HUMAN_EVIDENCE_ATTACHED";
export interface RunAuditEvent {
  round: number; kind: RunAuditEventKind; detail: string; recordedAt: string;
}

export interface AuditedRoundRecord {
  schemaVersion: number;                    // NEW (§12.1)
  roundNumber: number;
  reviewerPrompt: string; reviewerRawResponse: string;
  recommendation: DecisionRecommendation;
  humanGateResponse: HumanGateResponse;
  humanSuppliedEvidence?: Evidence[];
  generatorPrompt?: string; generatorResponse?: string;
}

export type TerminalOutcomeOrigin =          // §7.6
  | "HUMAN_AGREED_WITH_RECOMMENDATION" | "HUMAN_OVERRODE_RECOMMENDATION" | "HARD_SAFETY_OVERRIDE";

export interface AuditedReviewResult {
  schemaVersion: number;                    // = AUDITED_REVIEW_SCHEMA_VERSION
  originalTask: string;
  outcome: "ACCEPTED" | "REJECTED";
  outcomeOrigin: TerminalOutcomeOrigin;      // NEW (§7.6) — derived from the terminal round
  finalAnswer: string;
  initial: { prompt: string; response: string; startedAt: string; completedAt: string };
  rounds: AuditedRoundRecord[];
  claimLedger: ClaimLedgerEntry[];
  evidenceLog: Evidence[];
  runAuditTrail: RunAuditEvent[];            // NEW (§10)
  hardMaxRounds: number; recommendedMaxRounds: number;
  invalidReview?: { round: number; rawText: string; reason: string };
}
```

Every field remains plain, JSON-serializable data.

---

## 13. Prompt design

### 13.1 Generator revision-prompt adaptation (unchanged from v2 §13.1)

### 13.2 Reviewer / Evidence prompts (unchanged from v2 §13.2)

---

## 14. Round lifecycle (design, corrected: parse failure now routes through §8, hardSafetyOverride/runAuditTrail wired in)

```
state: INITIAL_GENERATOR
  → send task to Generator → wait → extract → G0
  → currentAnswer = G0; round = 1

state: ROUND(r)
  → build Reviewer prompt from (task, currentAnswer, OPEN+DISPUTED claim ledger summary)
  → send to Reviewer → wait → extract → rawReview
  → parse rawReview (claims/structuredClaimParser.ts)
  → invalidReviewThisRound := parse succeeded ? null : { reason: <parse failure detail> }
  → if invalidReviewThisRound is null: ingest parsed claims into the Claim Ledger,
        including structural resolution evidence (§5.3)
    else: claim ledger untouched this round; append a RunAuditEvent of kind
        "INVALID_REVIEW_ENCOUNTERED" to runAuditTrail                              [§10]
  → Decision Engine computes a DecisionRecommendation (§8), given
        (ledger-derived counts as of end of round r or r-1 per §8.1, round r,
         hardMaxRounds, recommendedMaxRounds, invalidReviewThisRound)
        — this is the ONLY place a DecisionRecommendation.kind is ever produced;
        no other branch in this lifecycle computes or hardcodes one                [§8.4]
  → orchestrator computes legalOutcomes := round >= hardMaxRounds
        ? ["ACCEPT","REJECT"] : ["CONTINUE","ACCEPT","REJECT"]                      [§6.5]
  → ════ HUMAN GATE (§6) — always fires ════
        present: claim ledger delta, disputed claims, relevantEvidence, recommendation +
                 reason, currentAnswer, legalOutcomes
        human optionally attaches evidence (§6.4); orchestrator ingests it, appends a
                 RunAuditEvent of kind "HUMAN_EVIDENCE_ATTACHED" if any was attached
        human responds with requestedOutcome ∈ legalOutcomes (+ mandatory rationale on REJECT)
  → orchestrator computes recommendationAgreement (requestedOutcome vs. this round's
        recommendation.kind, §7.6); if "OVERRODE", append a RunAuditEvent of kind
        "RECOMMENDATION_OVERRIDDEN_BY_HUMAN"
  → orchestrator validates requestedOutcome against legalOutcomes independently (§6.5
        Layer 2): if requestedOutcome === "CONTINUE" AND round >= hardMaxRounds:
              outcome := "REJECTED" (requestedOutcome preserved, unmodified)
              hardSafetyOverride := { reason: "hardMaxRounds reached; CONTINUE not honored" }
              append a RunAuditEvent of kind "HARD_MAX_ROUNDS_OVERRIDE"
        else:
              outcome := requestedOutcome
  → act on `outcome`:
        ACCEPT   → STOP, result.outcome = "ACCEPTED",
                   result.outcomeOrigin := derive per §7.6, finalAnswer = currentAnswer
        REJECT   → STOP, result.outcome = "REJECTED",
                   result.outcomeOrigin := derive per §7.6, finalAnswer = currentAnswer
        CONTINUE → build Generator revision prompt (§13.1)
                   → send to Generator → wait → extract → Gr
                   → currentAnswer = Gr; round = r + 1; repeat
```

**The structural guarantee this corrects, stated explicitly:** there is now exactly **one**
call site that produces a `DecisionRecommendation.kind` (the Decision Engine, §8.4), and
exactly **one** call site that produces a `TerminalOutcomeOrigin` (the derivation rule,
§7.6) — no branch in this lifecycle pseudocode computes or hardcodes either value
independently. This is the direct structural fix for mandatory change 1.

---

## 15. Testing strategy (updated: new tests for the unified decision path and outcome-origin tracking)

### 15.1 Unit tests — new/updated entries beyond v2 §15.1

| Test file | Covers |
|---|---|
| `tests/unit/decisionAgent.spec.ts` (**further expanded**) | **New:** a parse-failure case at `round < hardMaxRounds` produces `CONTINUE_RECOMMENDED` with `invalidReview` populated and ledger counts identical to the prior round's; **new:** a parse-failure case at `round === hardMaxRounds` still produces `REJECT_RECOMMENDED` (branch 1 precedence over branch 3) — this is the regression test for the exact bug the architect review found; **new:** a parse-failure case where a claim is already chronic still produces `REJECT_RECOMMENDED` (branch 2 precedence over branch 3). |
| `tests/unit/severityRules.spec.ts` | Direct tests of `computeAdjustedSeverity`/`computeReopenSeverity` as pure functions (no ledger, no history) — escalation, downgrade-rejection, reopen-floor, using the corrected `SEVERITY_ORDER`/`rankOf` names; **new:** a test asserting `objectionLedger.ts`'s exported `severityRank` and `shared/severityRules.ts`'s `rankOf` agree on every `ReviewSeverity` value, confirming the delegation is exact. |
| `tests/unit/runAuditedReviewLoop.spec.ts` (**further expanded**) | **New:** a run where the human overrides an `ACCEPT_RECOMMENDED` into `CONTINUE` — assert `recommendationAgreement === "OVERRODE"` that round and a matching `RunAuditEvent` of kind `"RECOMMENDATION_OVERRIDDEN_BY_HUMAN"` is present; **new:** a run forced to stop at `hardMaxRounds` — assert `outcomeOrigin === "HARD_SAFETY_OVERRIDE"`, `requestedOutcome === "CONTINUE"` and `outcome === "REJECTED"` on the terminal round, and a matching `"HARD_MAX_ROUNDS_OVERRIDE"` `RunAuditEvent`; **new:** a run where the human's final decision matches the recommendation — assert `outcomeOrigin === "HUMAN_AGREED_WITH_RECOMMENDATION"`. |
| `tests/unit/claimVsObjectionSemantics.spec.ts` (**new, small**) | A documentation-level test (mirroring how 4B's isolation tests assert structural properties): every `ClaimLedgerEntry` produced by `claimLedger.ts`'s ingest is only ever created from a Reviewer-sourced input (never a Generator-sourced or spontaneous entry) — a direct, checkable assertion of §4.6's definition, so a future change can't silently widen claim origin without this test forcing an explicit decision. |
| `tests/unit/evidenceLifecycle.spec.ts` (**new, small**) | Confirms `Evidence` records are never mutated after creation (a structural/immutability check) and that `supersedesEvidenceId` links resolve correctly without altering the superseded record — the direct test for §5.5's defined lifecycle. |

### 15.2 Simulation tests — one new scenario beyond v2 §15.2

- **Parse failure immediately before `hardMaxRounds`:** a scripted run where the final
  permitted round's Reviewer response is deliberately malformed — confirm the
  recommendation is still `REJECT_RECOMMENDED` (not `CONTINUE_RECOMMENDED`), and that the
  human is only offered `["ACCEPT","REJECT"]` at the gate for that round, exactly as if
  the review had parsed normally.

### 15.3 Real browser tests (unchanged from v2 §15.3)

### 15.4 Compatibility/regression checks (unchanged from v2 §15.4, plus: the new `severityRank`/`rankOf` agreement test above must pass)

---

## 16. Open questions (unchanged from v2 §16 — nothing in this revision reopens or resolves any of them)

---

## 17. File / module plan (updated: new types/tests added by this revision)

**Prerequisite (unchanged ordering from v2 §17):** `src/orchestration/shared/
severityRules.ts` (now exporting `SEVERITY_ORDER`/`rankOf`/`computeAdjustedSeverity`/
`computeReopenSeverity`, §9.1), the internal-only edit to `objectionLedger.ts`,
`tests/unit/severityRules.spec.ts`, `tests/unit/sharedSeverityRulesIsolation.spec.ts`.

**Milestone 5A new files (updated list):**

- `src/orchestration/claims/types.ts` (§12.2, now including `ClaimLedgerSnapshot`,
  `RunAuditEvent`, `TerminalOutcomeOrigin`)
- `src/orchestration/claims/claimLedger.ts`, `decisionAgent.ts` (§8, now accepting
  `invalidReviewThisRound`), `claimPrompts.ts`, `structuredClaimParser.ts` — unchanged file
  list from v2
- `src/orchestration/humanGate/humanGate.ts` (§6.2, updated `HumanGateResponse` shape)
- `src/orchestration/runAuditedReviewLoop.ts` (§14, now owning `recommendationAgreement`/
  `hardSafetyOverride`/`runAuditTrail` computation — the orchestrator, not the gate or the
  Decision Engine, is responsible for all of §7.6's derivation logic)
- `scripts/smoke-audited-review.ts` + `npm run smoke:audited-review`
- `tests/unit/structuredClaimParser.spec.ts`, `claimLedger.spec.ts`,
  `decisionAgent.spec.ts`, `humanGate.spec.ts`, `runAuditedReviewLoop.spec.ts`,
  `claimsIsolation.spec.ts`, `humanGateIsolation.spec.ts`,
  `claimVsObjectionSemantics.spec.ts` (**new**), `evidenceLifecycle.spec.ts` (**new**)
- `tests/unit/fakes/fakeHumanGate.ts`

**Explicitly untouched:** unchanged from v2 §17.
