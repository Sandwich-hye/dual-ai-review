# MILESTONE5_DESIGN_v5.md — Auditable multi-agent review system (Claim Ledger + Human Gate)

Design-only document for Phase 2A Milestone 5. **No production TypeScript is changed by
this document.** This revision supersedes `MILESTONE5_DESIGN_v4.md` after a principal
architect review found one BLOCKING and three MEDIUM issues in v4. It builds on the frozen
Milestone 4A fixed-round loop and the frozen (behaviorally/contract-frozen, §9.1) Milestone
4B convergence-driven loop.

---

## Revision history

**v5 (this revision) — applied all four required changes from the principal architect
review of v4, before any implementation:**

1. **`ledgerSnapshot` capture moved to the true end of round processing.** v4 captured it
   immediately after the Reviewer's ingest, *before* the Human Gate fired and *before* any
   human-supplied evidence (§6.4) was ingested — meaning the stored snapshot could be
   stale relative to that same round's own `humanSuppliedEvidence` field, silently
   undermining the "read directly, no replay" guarantee this field exists to provide.
   `ledgerSnapshot` is now captured as the literal last step before an `AuditedRoundRecord`
   is recorded, after human evidence ingestion has already been folded into the ledger
   (§14). Closes BLOCKING #1.
2. **`triggeredBranch` added to `DecisionRecommendation`.** Previously, only a free-text
   `reason` and the three-valued `kind` existed; the orchestrator's audit-event-logging
   step had to re-derive §8.4's branch conditions itself (e.g., recomputing
   `invalidReviewStreak >= invalidReviewRejectThreshold`) to know *why* a recommendation
   fired, creating a drift risk between the engine's decision and the audit trail's
   description of it. `triggeredBranch: DecisionBranch` now names exactly one of §8.4's
   seven branches, authoritatively, and every place that previously re-derived a branch
   condition (§10, §14) now reads this field instead. Closes MEDIUM #1.
3. **`ClaimHistoryEventKind.HUMAN_DECISION_RECORDED` removed.** No mechanism in any prior
   revision ever fired it — a human's claim-level action (attaching evidence, §6.4) is
   already fully captured by the ordinary `EVIDENCE_ADDED` event with `sourceRole: "HUMAN"`
   on the `Evidence` record itself, and a human's run-level action (continue/accept/reject)
   is already fully captured by `HumanDecisionRecord`/`RunAuditEvent`. The value had no
   defined trigger and no gap it was needed to fill; removed rather than retrofitted with
   a speculative use, consistent with this document's established discipline (§4.6, §5.5).
   Closes MEDIUM #2.
4. **A consolidated Claim Ledger ingest table added (§4.7)**, directly analogous to
   `MILESTONE4B_DESIGN.md` §6.3, giving one authoritative table mapping every input signal
   to its mutation, history event, and confidence/status effect — closing the gap where
   these rules were previously scattered correctly, but separately, across §4.2, §4.3,
   §5.3, and §9.1 with no single consolidated reference. Closes MEDIUM #3.

**Explicitly preserved, verified again in this revision (item 5 of the required
changes):** exactly one Decision Engine function, evaluated in one priority order — adding
`triggeredBranch` labels the existing seven branches, it does not add an eighth or change
their order or conditions (§8.4); the Human Gate's structural separation
(`HumanGateRawResponse` vs. orchestrator-only `HumanDecisionRecord`, §6.2) is untouched;
`hardMaxRounds`'s two-layer, unoverridable enforcement (§6.5) is untouched and remains
deliberately decoupled from the Decision Engine's own branch 1, exactly as it was designed
to be; Milestone 4B's frozen behavioral/contract boundary and the single, precisely-scoped
`objectionLedger.ts` migration (§9.1) are untouched; no production code implemented
anywhere in this document.

Everything not named above is unchanged from v4's reasoning and is restated below so this
document remains self-contained.

---

## 0. Inspection summary

Unchanged from v4 §0, plus the principal architect review of v4 itself, whose four
findings are the direct input to this revision.

---

## 1. Goal / Non-goals

Unchanged from v4 §1.

---

## 2. Current state recap (frozen foundation)

Unchanged from v4 §2.

---

## 3. Architecture evolution

Unchanged from v4 §3.

---

## 4. Claim Ledger enhancement

### 4.1 Field-by-field evolution table (updated: history-kind list corrected)

Unchanged from v3/v4 §4.1, with one correction: the `history` row's list of new event
kinds is now `EVIDENCE_ADDED`, `CONFIDENCE_CHANGED`, `DISPUTED`, `UNDISPUTED` —
**`HUMAN_DECISION_RECORDED` is removed** (mandatory change 3; see §4.6a below for the
rationale, restated where it's most visible).

### 4.2 Confidence (unchanged from v1/v2/v3/v4)

### 4.3 The `DISPUTED` status band (unchanged from v1/v2/v3/v4)

### 4.4 Resolution history (unchanged from v1/v2/v3/v4)

### 4.5 Severity rules (unchanged from v3/v4 §4.5 — pure calculation shared, mutation/history local)

### 4.6 Claim vs Objection — explicit definition (unchanged from v3/v4 §4.6)

### 4.6a `HUMAN_DECISION_RECORDED` removed (mandatory change 3, MEDIUM #2 fix)

This history-event kind existed in every prior revision's `ClaimHistoryEventKind` union
(v1 through v4) but was never wired into any described ingest rule, evidence-attachment
step, or lifecycle transition — it had no defined trigger. Two candidate justifications
were considered and both rejected as redundant:

- **"A human attached evidence to this claim"** — already fully captured by the ordinary
  `EVIDENCE_ADDED` history event on the claim, combined with `sourceRole: "HUMAN"` on the
  `Evidence` record itself (§5.1, §5.3). No claim-level event distinct from `EVIDENCE_ADDED`
  is needed to know a human, specifically, was the source.
- **"A human made a run-level outcome decision (continue/accept/reject) during this
  round"** — this is not a *claim-level* fact at all; it's a *run-level* fact, already
  fully captured by `HumanDecisionRecord` (§6.2) and, for anything worth flagging in the
  audit trail specifically, `RunAuditEvent` (§10). Attaching it to individual claims would
  either duplicate that information per-claim for no benefit, or require an undefined rule
  for *which* claims it should attach to (all `OPEN`/`DISPUTED` claims that round? only
  ones referenced in the recommendation?) — a speculative complication with no named
  consumer.

Consistent with §4.6's and §5.5's established discipline of defining scope explicitly
rather than leaving unused generality in the schema, `HUMAN_DECISION_RECORDED` is removed
from `ClaimHistoryEventKind` (§12.2) rather than retrofitted with a rule invented after the
fact to justify its presence.

### 4.7 Claim Ledger ingest table (new, mandatory change 4, MEDIUM #3 fix)

This section is the direct analogue of `MILESTONE4B_DESIGN.md` §6.3 for the Claim Ledger.
It consolidates, in one place, every rule already established individually in §4.2
(confidence), §4.3 (`DISPUTED`), §5.3 (evidence sources), and §9.1 (severity via
`shared/severityRules.ts`) into a single authoritative procedure and table — nothing here
is a new rule; it is the missing consolidation the architect review asked for.

**Ingest procedure, applied in this order, once per round (mirroring
`MILESTONE4B_DESIGN.md` §6.3's own ordering discipline):**

1. Apply the parsed Reviewer response's signals (`resolvedClaimIds`, `stillOpenClaims`,
   `reopenedClaims`, `newClaims`) using the same contradiction/duplication validation and
   fingerprint-matching precedence 4B's `objectionLedger.ts` already established
   (`MILESTONE4B_DESIGN.md` §6.3, §6.4, §6.5, §7.2) — unchanged in spirit, applied to
   `ClaimLedgerEntry` instead of `ObjectionLedgerEntry`.
2. For every claim that just transitioned to `RESOLVED` in step 1, create the required
   structural resolution `Evidence` record (§5.3 point 1) from the Reviewer's resolution
   text.
3. For every claim touched in steps 1–2, recompute `confidence` per §4.2's rule, driven by
   whichever new `Evidence` record(s) were just attached.
4. For every claim touched in steps 1–3, recompute `DISPUTED`/not-`DISPUTED` classification
   per §4.3's rule, based on the claim's current `evidenceFor`/`evidenceAgainst` contents
   and recomputed confidence.
5. Any `OPEN` claim referenced nowhere in steps 1–4 is marked `IMPLICITLY_CARRIED_OPEN`,
   unchanged otherwise (§4.1's mapping table, inherited from `MILESTONE4B_DESIGN.md` §6.3's
   identical rule).
6. **Later in the same round** (§6.4, §14): if the human attaches evidence at the gate,
   steps 2–4 repeat for exactly the claim(s) the human attached evidence to — this is the
   *only* ledger mutation that can occur after the Human Gate has opened, and it is why
   `ledgerSnapshot` (§12.2) must be captured after this step, not before it (§14, fix for
   the prior BLOCKING finding).

**Consolidated table:**

| Input signal | Mutation | History event(s) | Confidence / status effect |
|---|---|---|---|
| id in `resolvedClaimIds` | `status → RESOLVED`; `lastSeenRound` updated | `RESOLVED` (with `resolutionEvidenceRef` pointing at the new structural `Evidence`, step 2 above) | Confidence recomputed (§4.2) from the new `RESOLUTION`-kind evidence; if the result is `< resolutionConfidenceThreshold`, this claim counts toward `lowConfidenceResolutions(r)` (§8.2) |
| id in `stillOpenClaims`, no `severityOverride` | `lastSeenRound` updated | `REPEATED` | None directly |
| id in `stillOpenClaims`, with `severityOverride` | `severity`/`highestSeveritySeen` updated via `shared/severityRules.ts`'s `computeAdjustedSeverity` (§9.1) | `SEVERITY_CHANGED` (escalation) or `SEVERITY_DOWNGRADE_REJECTED` (attempted downgrade) | Severity and confidence are orthogonal (§4.2) — no confidence effect from a severity override alone |
| id in `reopenedClaims` | `status → OPEN`; severity floored via `computeReopenSeverity` (§9.1); `lastSeenRound` updated | `SEVERITY_CHANGED` (if the floor changed severity) + `REOPENED` | A `CHALLENGING`-kind `Evidence` record is created from the reopen note (§5.3-analogous path); confidence recomputed (§4.2); `DISPUTED` fires if the recomputed confidence and evidence mix now qualifies (§4.3) |
| entry in `newClaims`, genuinely new (fingerprint below the merge bar) | New `ClaimLedgerEntry` created; `confidence = 0.5` (neutral prior, §4.2); `status = OPEN` | `RAISED` | Confidence starts neutral; no evidence yet |
| entry in `newClaims`, fingerprint-merges into an existing `OPEN` entry | `claim.statement`/`rationale` updated to the latest wording | `PARAPHRASED` | No confidence effect from the paraphrase alone (no new evidence was submitted, only rewording) |
| entry in `newClaims`, fingerprint-merges into an existing `RESOLVED`/`REJECTED` entry | `status → OPEN`; severity floored via `computeReopenSeverity` | `SEVERITY_CHANGED` (if floored) + `REOPENED` | Same as the explicit-reopen row above |
| `OPEN` claim referenced nowhere this round | None | `IMPLICITLY_CARRIED_OPEN` | Confidence/status carried forward unchanged — silence is never resolution (unchanged 4B principle) |
| Human attaches `SUPPORTING`/`CHALLENGING` evidence at the gate (§6.4, step 6 above) | New `Evidence` record created (`sourceRole: "HUMAN"`), appended to `evidenceFor` or `evidenceAgainst` per `kind` | `EVIDENCE_ADDED` | Confidence recomputed (§4.2); `DISPUTED`/`UNDISPUTED` re-evaluated (§4.3) — this is the *only* case where ledger mutation happens after the Decision Engine has already computed that round's `DecisionRecommendation` (§8), which is why the recommendation shown to the human reflects the ledger *before* their own evidence, while `ledgerSnapshot` (captured after, §14) reflects it *after* |
| Confidence recompute (any row above) crosses into or out of the `DISPUTED` band (§4.3) | `status` transitions to/from `DISPUTED` | `DISPUTED` or `UNDISPUTED` | Derived automatically from confidence + evidence mix; never settable directly by any role |

Every id referenced in `resolvedClaimIds`/`stillOpenClaims`/`reopenedClaims` is validated
against the ledger-id contradiction/duplication rules (`MILESTONE4B_DESIGN.md` §7.2,
reused conceptually for claims via `structuredClaimParser.ts`, §7.2 role description)
*before* any row of this table is applied — unchanged from 4B's own ordering discipline.

---

## 5. Evidence tracking system

Unchanged from v3/v4 §5 (§5.1–§5.5) — §4.7's ingest table above consolidates *when* these
rules fire; it does not change any of them.

---

## 6. Human decision gate

### 6.1–6.4 (unchanged from v4)

### 6.5 hardMaxRounds enforcement — two independent layers (unchanged from v4 §6.5)

Restated for clarity given `triggeredBranch` now exists elsewhere in this document: this
mechanism remains **deliberately independent** of `DecisionRecommendation.triggeredBranch`
— it is not a case of "audit logging recomputing a decision condition" (which mandatory
change 2 targets), it is a distinct, intentionally-decoupled safety layer, exactly as
originally designed (§6.5's own rationale: "so that a bug in this function could never, by
itself, remove the hard ceiling"). `triggeredBranch` is used to remove *redundant,
unnecessary* re-derivation (§10, §14); it is not used here, on purpose.

### 6.6 `FakeHumanGate` isolation rules (unchanged from v4 §6.6)

---

## 7. Multi-agent roles

Unchanged from v4 §7 (§7.1–§7.6).

---

## 8. Decision Engine specification (updated: adds `triggeredBranch`, mandatory change 2)

### 8.1 Inputs (unchanged from v4 §8.1)

### 8.2 Clean round definition (unchanged from v4 §8.2)

### 8.3 Chronic-claim reject trigger / 8.3a Chronic invalid-review trigger (unchanged from v4 §8.3, §8.3a)

### 8.4 Decision priority order — updated: every branch now assigns an authoritative `triggeredBranch`

**Every decision path is evaluated by exactly this one function, in exactly this priority
order. No caller ever computes or hardcodes a `DecisionRecommendation.kind` *or*
`triggeredBranch` outside it.**

```ts
export type DecisionBranch =
  | "HARD_MAX_ROUNDS_REACHED"
  | "CHRONIC_CLAIM"
  | "INVALID_REVIEW_STREAK"
  | "INVALID_REVIEW_SINGLE"
  | "SOFT_BUDGET_EXCEEDED"
  | "CLEAN_ACCEPT"
  | "DEFAULT_CONTINUE";
```

```
1. if round >= hardMaxRounds:
      kind := REJECT_RECOMMENDED
      triggeredBranch := "HARD_MAX_ROUNDS_REACHED"
      reason := "hardMaxRounds (<n>) reached"

2. else if any claim in the ledger isChronic (§8.3):
      kind := REJECT_RECOMMENDED
      triggeredBranch := "CHRONIC_CLAIM"
      reason := "claim <id> reopened >= reopenRejectThreshold times"

3. else if invalidReviewIsChronic(r) (§8.3a):
      kind := REJECT_RECOMMENDED
      triggeredBranch := "INVALID_REVIEW_STREAK"
      reason := "reviewer response failed to parse for
                 invalidReviewStreak (=<n>) >= invalidReviewRejectThreshold
                 consecutive rounds"

4. else if invalidReviewThisRound is not null:
      kind := CONTINUE_RECOMMENDED
      triggeredBranch := "INVALID_REVIEW_SINGLE"
      reason := "reviewer response could not be parsed this round: <reason>;
                 ledger unchanged from round <r-1>; invalidReviewStreak=<n>"

5. else if round > recommendedMaxRounds:
      kind := CONTINUE_RECOMMENDED
      triggeredBranch := "SOFT_BUDGET_EXCEEDED"
      reason := "round budget (recommendedMaxRounds=<n>) exceeded; consider REJECT or a
                 manual ACCEPT override if remaining claims are judged immaterial"

6. else if isCleanRound(r) AND cleanStreak(r) >= stabilityWindowRounds:
      kind := ACCEPT_RECOMMENDED
      triggeredBranch := "CLEAN_ACCEPT"
      reason := "<cleanStreak> consecutive clean rounds, no open HIGH/MEDIUM, no disputed
                 claims, no low-confidence resolutions"

7. else:
      kind := CONTINUE_RECOMMENDED
      triggeredBranch := "DEFAULT_CONTINUE"
      reason := "<openHighCount> open HIGH, <openMediumCount> open MEDIUM,
                 <disputedCount> disputed, <lowConfidenceResolutions> low-confidence
                 resolution(s) remaining"
```

`triggeredBranch` gives strictly more information than `kind` alone: branches 4, 5, and 7
all produce `kind === "CONTINUE_RECOMMENDED"` but are meaningfully different situations —
a single parse failure, an exceeded soft budget, and an ordinary non-clean round,
respectively. Any consumer that previously had to inspect `reason`'s free text (or,
worse, re-derive the branch condition itself, as §10/§14 did in v4) now reads
`triggeredBranch` directly.

### 8.5 Default thresholds (unchanged from v4 §8.5)

### 8.6 Updated `DecisionRecommendation` shape (one new field)

```ts
export interface DecisionRecommendation {
  kind: "CONTINUE_RECOMMENDED" | "ACCEPT_RECOMMENDED" | "REJECT_RECOMMENDED";
  triggeredBranch: DecisionBranch;      // NEW (mandatory change 2) — authoritative;
                                          // exactly one of §8.4's seven branches
  round: number; reason: string; cleanStreak: number;
  openHighCount: number; openMediumCount: number; disputedCount: number;
  averageConfidence: number; lowConfidenceResolutionCount: number;
  invalidReviewStreak: number;
  invalidReview?: { reason: string };
}
```

### 8.7 Worked consequences (unchanged from v4 §8.7)

---

## 9. Backward compatibility

Unchanged from v3/v4 §9 (§9.1–§9.4) — none of this revision's four required changes touch
`objectionLedger.ts`, `shared/severityRules.ts`, or any other 4B file.

---

## 10. Audit trail (updated: reads `triggeredBranch` instead of re-deriving branch conditions)

```ts
export type RunAuditEventKind =
  | "HARD_MAX_ROUNDS_OVERRIDE"
  | "INVALID_REVIEW_ENCOUNTERED"
  | "INVALID_REVIEW_STREAK_THRESHOLD_REACHED"
  | "RECOMMENDATION_OVERRIDDEN_BY_HUMAN"
  | "HUMAN_EVIDENCE_ATTACHED";

export interface RunAuditEvent {
  round: number; kind: RunAuditEventKind; detail: string; recordedAt: string;
}
```

**Updated logging rule for `"INVALID_REVIEW_STREAK_THRESHOLD_REACHED"` (mandatory change 2,
direct fix for the architect review's finding):** the orchestrator appends this event
exactly when `recommendation.triggeredBranch === "INVALID_REVIEW_STREAK"` **and** the
*previous* round's `recommendation.triggeredBranch` was **not**
`"INVALID_REVIEW_STREAK"` (a rising-edge check on the one authoritative field, comparing
two already-computed values — never re-testing `invalidReviewStreak >=
invalidReviewRejectThreshold` itself, which is now exclusively the Decision Engine's own
internal concern). This is both simpler and safer than v4's "for the first time this run"
phrasing, which implied scanning `runAuditTrail` for prior occurrences; a rising-edge
comparison against the immediately preceding round's `triggeredBranch` is sufficient and
requires no scan.

`AuditedReviewResult.invalidReview` remains removed (unchanged from v4, mandatory change 1
of the prior revision) — every invalid review is representable only via per-round
`recommendation.invalidReview` and `runAuditTrail`, as established.

### 10.1 Reconstructing "why," updated

All of v4 §10.1's lookup table holds, restated to note `triggeredBranch` as the preferred
lookup path over free-text `reason` parsing:

| Question | How it's answered |
|---|---|
| Why did the run continue/accept/reject-recommend at round N specifically? | `rounds[N-1].recommendation.triggeredBranch` — a single authoritative enum read, never `reason` string parsing. |
| What did the claim ledger look like at round N, **including any evidence the human attached that round**? | `rounds[N-1].ledgerSnapshot` — captured at the true end of round N's processing (§4.7 step 6, §14), so it is always complete, never stale relative to `rounds[N-1].humanSuppliedEvidence`. |

---

## 11. (reserved — see §8 for the Decision Engine; §7.6 for outcome origin)

---

## 12. Data model (consolidated design sketch — updated: `triggeredBranch`, `HUMAN_DECISION_RECORDED` removed, `ledgerSnapshot` comment corrected)

### 12.1 `schemaVersion` design (unchanged from v4 §12.1)

### 12.2 Full sketch (updated)

```ts
// design sketch — src/orchestration/claims/types.ts (new module; does not edit
// src/orchestration/convergence/types.ts)

export const AUDITED_REVIEW_SCHEMA_VERSION = 1;
export const AUDITED_ROUND_SCHEMA_VERSION = 1;
export const CLAIM_LEDGER_SNAPSHOT_SCHEMA_VERSION = 1;
export const HUMAN_DECISION_RECORD_SCHEMA_VERSION = 1;

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

export type ClaimHistoryEventKind =                          // HUMAN_DECISION_RECORDED
  | "RAISED" | "REPEATED" | "PARAPHRASED" | "RESOLVED" | "REJECTED" | "REOPENED"  // REMOVED
  | "IMPLICITLY_CARRIED_OPEN" | "SEVERITY_CHANGED" | "SEVERITY_DOWNGRADE_REJECTED" // (§4.6a)
  | "DUPLICATE_COLLAPSED" | "EVIDENCE_ADDED" | "CONFIDENCE_CHANGED" | "DISPUTED"
  | "UNDISPUTED";

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

export interface ClaimLedgerSnapshot {   // §12.1 — future ledger.json unit
  schemaVersion: number; round: number; entries: ClaimLedgerEntry[];
}

export type DecisionBranch =            // §8.4 — NEW
  | "HARD_MAX_ROUNDS_REACHED" | "CHRONIC_CLAIM" | "INVALID_REVIEW_STREAK"
  | "INVALID_REVIEW_SINGLE" | "SOFT_BUDGET_EXCEEDED" | "CLEAN_ACCEPT" | "DEFAULT_CONTINUE";

export interface DecisionRecommendation {   // §8.6
  kind: "CONTINUE_RECOMMENDED" | "ACCEPT_RECOMMENDED" | "REJECT_RECOMMENDED";
  triggeredBranch: DecisionBranch;          // NEW
  round: number; reason: string; cleanStreak: number;
  openHighCount: number; openMediumCount: number; disputedCount: number;
  averageConfidence: number; lowConfidenceResolutionCount: number;
  invalidReviewStreak: number;
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

export interface HumanGateRawResponse {     // §6.2 — the ONLY thing a HumanGate returns
  requestedOutcome: HumanGateOutcome;
  rationale?: string;
  decidedAt: string;
}

export interface HumanDecisionRecord {      // §6.2, §7.6 — orchestrator-only construction
  schemaVersion: number;
  raw: HumanGateRawResponse;
  outcome: HumanGateOutcome;
  recommendationAgreement: RecommendationAgreement;
  hardSafetyOverride?: { reason: string };
}

export type RunAuditEventKind =              // §10
  | "HARD_MAX_ROUNDS_OVERRIDE" | "INVALID_REVIEW_ENCOUNTERED"
  | "INVALID_REVIEW_STREAK_THRESHOLD_REACHED"
  | "RECOMMENDATION_OVERRIDDEN_BY_HUMAN" | "HUMAN_EVIDENCE_ATTACHED";
export interface RunAuditEvent {
  round: number; kind: RunAuditEventKind; detail: string; recordedAt: string;
}

export interface AuditedRoundRecord {
  schemaVersion: number;
  roundNumber: number;
  reviewerPrompt: string; reviewerRawResponse: string;
  recommendation: DecisionRecommendation;
  ledgerSnapshot: ClaimLedgerEntry[];        // CORRECTED (§4.7, §14, mandatory change 1) —
                                               // captured at the TRUE END of this round's
                                               // processing, i.e. AFTER humanSuppliedEvidence
                                               // (if any) has already been ingested — so this
                                               // field and humanSuppliedEvidence below are
                                               // always mutually consistent, never stale
  humanDecision: HumanDecisionRecord;
  humanSuppliedEvidence?: Evidence[];
  generatorPrompt?: string; generatorResponse?: string;
}

export type TerminalOutcomeOrigin =          // §7.6
  | "HUMAN_AGREED_WITH_RECOMMENDATION" | "HUMAN_OVERRODE_RECOMMENDATION" | "HARD_SAFETY_OVERRIDE";

export interface AuditedReviewResult {
  schemaVersion: number;
  originalTask: string;
  outcome: "ACCEPTED" | "REJECTED";
  outcomeOrigin: TerminalOutcomeOrigin;
  finalAnswer: string;
  initial: { prompt: string; response: string; startedAt: string; completedAt: string };
  rounds: AuditedRoundRecord[];
  claimLedger: ClaimLedgerEntry[];
  evidenceLog: Evidence[];
  runAuditTrail: RunAuditEvent[];
  hardMaxRounds: number; recommendedMaxRounds: number; invalidReviewRejectThreshold: number;
}
```

Every field remains plain, JSON-serializable data.

---

## 13. Prompt design

Unchanged from v3/v4 §13 (§13.1, §13.2).

---

## 14. Round lifecycle (design, updated: ledgerSnapshot moved to the true end of round processing, `triggeredBranch`-based audit logging)

```
state: INITIAL_GENERATOR
  → send task to Generator → wait → extract → G0
  → currentAnswer = G0; round = 1; invalidReviewStreak = 0; previousTriggeredBranch = null

state: ROUND(r)
  → build Reviewer prompt from (task, currentAnswer, OPEN+DISPUTED claim ledger summary)
  → send to Reviewer → wait → extract → rawReview
  → parse rawReview (claims/structuredClaimParser.ts)
  → invalidReviewThisRound := parse succeeded ? null : { reason: <parse failure detail> }
  → invalidReviewStreak := invalidReviewThisRound === null ? 0 : invalidReviewStreak + 1
  → if invalidReviewThisRound is null: apply the Claim Ledger ingest procedure (§4.7,
        steps 1–5) — resolvedClaimIds/stillOpenClaims/reopenedClaims/newClaims, structural
        resolution evidence, confidence, DISPUTED/UNDISPUTED, IMPLICITLY_CARRIED_OPEN
    else: claim ledger untouched this round; append a RunAuditEvent of kind
        "INVALID_REVIEW_ENCOUNTERED" to runAuditTrail
  → Decision Engine computes a DecisionRecommendation (§8), given
        (ledger-derived counts, round r, hardMaxRounds, recommendedMaxRounds,
         invalidReviewThisRound, invalidReviewStreak)
        — this is the ONLY place a DecisionRecommendation.kind/triggeredBranch is ever
        produced                                                                        [§8.4]
  → if recommendation.triggeredBranch === "INVALID_REVIEW_STREAK" AND
        previousTriggeredBranch !== "INVALID_REVIEW_STREAK":                            [§10]
        append a RunAuditEvent of kind "INVALID_REVIEW_STREAK_THRESHOLD_REACHED"
        (a rising-edge check on the one authoritative field — no re-derivation of the
        streak/threshold condition itself, which remains solely the Decision Engine's)
  → previousTriggeredBranch := recommendation.triggeredBranch
  → orchestrator computes legalOutcomes := round >= hardMaxRounds
        ? ["ACCEPT","REJECT"] : ["CONTINUE","ACCEPT","REJECT"]                          [§6.5]
  → ════ HUMAN GATE (§6) — always fires ════
        present: claim ledger delta, disputed claims, relevantEvidence, recommendation +
                 reason, currentAnswer, legalOutcomes
        (the recommendation shown here reflects the ledger BEFORE any evidence the human
         is about to attach — this is intentional and unchanged from v4: the human is the
         final authority and does not need a live-updated recommendation mid-interaction)
        human optionally attaches evidence (§6.4, §4.7 step 6); orchestrator applies the
                 ingest procedure's steps 2–4 for exactly the claim(s) touched; appends a
                 RunAuditEvent of kind "HUMAN_EVIDENCE_ATTACHED" if any was attached
        gate returns raw: HumanGateRawResponse { requestedOutcome, rationale?, decidedAt }
  → orchestrator constructs this round's HumanDecisionRecord (§6.5):
        recommendationAgreement := map(raw.requestedOutcome) === recommendation.kind
                                    ? "AGREED" : "OVERRODE"
        if recommendationAgreement === "OVERRODE": append a RunAuditEvent of kind
                 "RECOMMENDATION_OVERRIDDEN_BY_HUMAN"
        if raw.requestedOutcome === "CONTINUE" AND round >= hardMaxRounds:
                 outcome := "REJECTED"; hardSafetyOverride := { reason: "..." }
                 append a RunAuditEvent of kind "HARD_MAX_ROUNDS_OVERRIDE"
        else: outcome := raw.requestedOutcome
        humanDecision := { schemaVersion, raw, outcome, recommendationAgreement,
                            hardSafetyOverride }
  → ledgerSnapshot := a copy of the claim ledger's current entries                       [§4.7,
        — captured HERE, as the LAST step before recording this round, i.e. AFTER the      §12.2]
        human-evidence ingestion above has already been applied (mandatory change 1 —
        THIS is the fix: v4 captured this earlier, before the gate; v5 captures it last)
  → record this round's AuditedRoundRecord { ..., ledgerSnapshot, humanDecision,
        humanSuppliedEvidence }
  → act on humanDecision.outcome:
        ACCEPT   → STOP, result.outcome = "ACCEPTED",
                   result.outcomeOrigin := derive per §7.6, finalAnswer = currentAnswer
        REJECT   → STOP, result.outcome = "REJECTED",
                   result.outcomeOrigin := derive per §7.6, finalAnswer = currentAnswer
        CONTINUE → build Generator revision prompt (§13.1)
                   → send to Generator → wait → extract → Gr
                   → currentAnswer = Gr; round = r + 1; repeat
```

**Structural guarantees, restated once more, now covering all changes across every
revision:** exactly one call site produces a `DecisionRecommendation.kind`/
`triggeredBranch` (§8.4); exactly one call site produces a `TerminalOutcomeOrigin` (§7.6);
`recommendationAgreement`/`hardSafetyOverride` are computable only by the orchestrator,
from types that structurally cannot carry them; every round's ledger state is captured
completely, at the true end of that round's processing, with no staleness relative to
that same round's own recorded evidence; audit-event logging for the invalid-review streak
reads the engine's own authoritative output rather than re-deriving it; and no invalid-
review handling exists outside the one Decision Engine function.

---

## 15. Testing strategy (updated: `triggeredBranch`, corrected `ledgerSnapshot` timing, removed event kind)

### 15.1 Unit tests — new/updated entries beyond v4 §15.1

| Test file | Covers |
|---|---|
| `tests/unit/decisionAgent.spec.ts` (**further expanded**) | **New:** every one of §8.4's seven branches produces the exact matching `triggeredBranch` value, not just the correct `kind` — including confirming branches 4/5/7 (all `CONTINUE_RECOMMENDED`) are distinguishable from each other via `triggeredBranch` alone. |
| `tests/unit/claimLedger.spec.ts` (**further expanded**) | **New:** one test per row of §4.7's consolidated ingest table, each asserting the exact mutation + history event(s) + confidence/status effect described — this is the direct test-plan analogue of `MILESTONE4B_DESIGN.md` §15's per-row objection-ledger tests, now existing for claims. |
| `tests/unit/runAuditedReviewLoop.spec.ts` (**further expanded**) | **New (replaces the v4 "first time this run" test):** a run with 4+ consecutive invalid reviews — assert `"INVALID_REVIEW_STREAK_THRESHOLD_REACHED"` is appended exactly once (at the round `triggeredBranch` first becomes `"INVALID_REVIEW_STREAK"`), and NOT again on subsequent rounds where it remains `"INVALID_REVIEW_STREAK"` — proving the rising-edge check, not a scan-based "have I logged this before" check; **new:** a run where the human attaches evidence at the gate in the same round a claim would otherwise resolve — assert `rounds[N].ledgerSnapshot` reflects the human's evidence (post-attachment state) while `rounds[N].recommendation` (computed earlier that round) does not, confirming the corrected timing directly. |
| `tests/unit/claimVsObjectionSemantics.spec.ts`, `evidenceLifecycle.spec.ts`, `claimsIsolation.spec.ts`, `humanGateIsolation.spec.ts` | Unchanged from v4. |

### 15.2 Simulation tests (unchanged scenarios from v4 §15.2, all still valid — the persistently-malformed-Reviewer scenario now additionally asserts `triggeredBranch === "INVALID_REVIEW_STREAK"` at the stopping round)

### 15.3 Real browser tests (unchanged from v4 §15.3)

### 15.4 Compatibility/regression checks (unchanged from v4 §15.4)

---

## 16. Open questions (unchanged from v3/v4 §16)

---

## 17. File / module plan (updated: reflects `triggeredBranch`, removed event kind, corrected ledgerSnapshot timing — no new files beyond v4's list)

**Prerequisite (unchanged from v3/v4 §17).**

**Milestone 5A new files (unchanged file list from v4 §17)** — this revision changes field
definitions and lifecycle ordering within existing planned files
(`claims/types.ts`, `claims/decisionAgent.ts`, `claims/claimLedger.ts`,
`runAuditedReviewLoop.ts`), not the file list itself.

**Explicitly untouched:** unchanged from v3/v4 §17.

---

## 18. Summary of what this revision closes

| Prior finding | Resolution |
|---|---|
| BLOCKING: `ledgerSnapshot` captured before human evidence ingestion, stale relative to `humanSuppliedEvidence` | Capture moved to the true end of round processing, after human evidence ingest (§4.7 step 6, §14, §12.2) |
| MEDIUM: audit logging re-derived the invalid-review-streak threshold condition independently of the Decision Engine | Added `DecisionRecommendation.triggeredBranch` (§8.4, §8.6); audit logging now does a rising-edge comparison on this one authoritative field (§10, §14) |
| MEDIUM: `ClaimHistoryEventKind.HUMAN_DECISION_RECORDED` had no defined trigger | Removed (§4.6a, §12.2) — fully superseded by existing `EVIDENCE_ADDED`/`sourceRole` and run-level `HumanDecisionRecord`/`RunAuditEvent` mechanisms |
| MEDIUM: no consolidated claim-ledger ingest table, unlike 4B's §6.3 | Added §4.7, a single authoritative ingest procedure + table covering every input signal, mutation, history event, and confidence/status effect |
