# MILESTONE5_DESIGN_v4.md — Auditable multi-agent review system (Claim Ledger + Human Gate)

Design-only document for Phase 2A Milestone 5. **No production TypeScript is changed by
this document.** This revision supersedes `MILESTONE5_DESIGN_v3.md` after a principal
architect review found one BLOCKING and three MEDIUM issues in v3. It builds on the frozen
Milestone 4A fixed-round loop and the frozen (behaviorally/contract-frozen, §9.1) Milestone
4B convergence-driven loop.

---

## Revision history

**v4 (this revision) — applied all four required changes from the principal architect
review of v3, before any implementation:**

1. **`AuditedReviewResult.invalidReview` removed.** It was a leftover from the pre-v3
   model where `INVALID_REVIEW` was itself a terminal `stopReason`; under v3's actual
   model a run can encounter multiple invalid-review rounds without ever terminating
   because of one, leaving the field's semantics genuinely undefined (which occurrence
   would it hold?). Invalid reviews now exist **only** as per-round
   `DecisionRecommendation.invalidReview` (unchanged from v3, §8.6) and
   `RunAuditEvent`s of kind `"INVALID_REVIEW_ENCOUNTERED"` (unchanged from v3, §10) — both
   of which already fully and unambiguously captured this information. Closes BLOCKING #1.
2. **`ledgerSnapshot` added to `AuditedRoundRecord`**, directly following
   `MILESTONE4B_DESIGN.md`'s `ConvergenceHistory.rounds[].ledgerSnapshot` precedent — the
   full claim ledger state as of the end of each round is now a stored, directly-readable
   field, not something a reader must reconstruct by replaying round-tagged history events.
   Closes MEDIUM #1 (audit-reconstruction ergonomics).
3. **`HumanGate` response semantics split.** `HumanGate.presentAndAwaitDecision()` now
   returns a narrow `HumanGateRawResponse` (`requestedOutcome`, optional `rationale`,
   `decidedAt`) containing **only** what a human/gate implementation actually provides.
   `recommendationAgreement` and `hardSafetyOverride` no longer exist on any type a
   `HumanGate` implementation can construct — they exist only on a new,
   orchestrator-only-constructed `HumanDecisionRecord` that wraps the raw response. This
   makes the "only the orchestrator computes these" invariant structural (a type-level
   guarantee), not conventional. Closes MEDIUM #2.
4. **Repeated invalid-review handling added, inside the same Decision Engine, no bypass.**
   A new `invalidReviewStreak` input (reset on any successful parse, incremented on every
   consecutive parse failure) and a new default `invalidReviewRejectThreshold` (= 3) are
   added as one more priority-ordered branch in §8.4 — positioned after `hardMaxRounds`/
   chronic-claim, before the ordinary single-round invalid-review branch — so a
   persistently malformed Reviewer is now caught by its own dedicated, symmetric-to-
   chronic-claims trigger rather than silently consuming the entire `hardMaxRounds`
   budget. Closes MEDIUM #3.

**Explicitly preserved, verified again in this revision (item 5 of the required
changes):** exactly one Decision Engine function, evaluated in one priority order, with no
external caller ever computing or hardcoding a `DecisionRecommendation.kind` (§8.4, §14);
`hardMaxRounds`'s two-layer, unoverridable enforcement (§6.5, unchanged in mechanism,
updated only in which type it reads from); Milestone 4B's frozen behavioral/contract
boundary and the single, precisely-scoped `objectionLedger.ts` migration (§9.1, unchanged);
no production code implemented anywhere in this document.

Everything not named above is unchanged from v3's reasoning and is restated below so this
document remains self-contained.

---

## 0. Inspection summary

Unchanged from v3 §0, plus the principal architect review of v3 itself, whose four
findings are the direct input to this revision.

---

## 1. Goal / Non-goals

Unchanged from v3 §1.

---

## 2. Current state recap (frozen foundation)

Unchanged from v3 §2.

---

## 3. Architecture evolution

Unchanged from v3 §3.

---

## 4. Claim Ledger enhancement

Unchanged from v3 §4 (§4.1–§4.6, including the explicit Claim-vs-Objection definition in
§4.6 — untouched by this revision's four required changes).

---

## 5. Evidence tracking system

Unchanged from v3 §5 (§5.1–§5.5, including the Evidence lifecycle definition in §5.5 —
untouched by this revision).

---

## 6. Human decision gate

### 6.1 Placement in the lifecycle (unchanged from v3 §6.1)

### 6.2 Gate contract (updated: split response types, mandatory change 3)

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

// What a HumanGate implementation returns — and ALL it can return. There is no field
// here a gate could use to claim its own outcome was "agreed with the recommendation" or
// to declare a hard safety override — those concepts don't exist at this layer at all.
export interface HumanGateRawResponse {
  requestedOutcome: HumanGateOutcome;
  rationale?: string;       // REQUIRED (by the real gate's own input validation, §6.3)
                             // when requestedOutcome === "REJECT"
  decidedAt: string;
}

export interface HumanGate {
  presentAndAwaitDecision(presentation: HumanGatePresentation): Promise<HumanGateRawResponse>;
}

// What the ORCHESTRATOR constructs after receiving a HumanGateRawResponse — and the ONLY
// place recommendationAgreement/hardSafetyOverride can ever be produced (§7.6, §6.5).
// No HumanGate implementation, real or fake, ever builds one of these.
export interface HumanDecisionRecord {
  schemaVersion: number;
  raw: HumanGateRawResponse;                 // exactly what the gate returned, untouched
  outcome: HumanGateOutcome;                 // what was actually acted on — differs from
                                               // raw.requestedOutcome ONLY when
                                               // hardSafetyOverride is present
  recommendationAgreement: RecommendationAgreement;
  hardSafetyOverride?: { reason: string };
}
```

This is the direct fix for the architect review's finding: previously, `HumanGateResponse`
carried `recommendationAgreement`/`hardSafetyOverride` as ordinary optional fields that a
non-conforming `HumanGate` implementation could technically populate itself, with only
prose ("computed by the orchestrator, never by the gate") preventing it. Under v4, a
`HumanGate` implementation's return type (`HumanGateRawResponse`) **structurally cannot
contain** either field — there is no way to spoof them from that layer, by construction,
not by convention.

### 6.3 Production implementation: blocking terminal prompt (unchanged mechanism from v3 §6.3, now returns `HumanGateRawResponse`)

### 6.4 Evidence attachment at the gate (unchanged from v3 §6.4)

### 6.5 hardMaxRounds enforcement — two independent layers (updated: reads/writes the split types)

Unchanged mechanism from v3 §6.5 (gate-level input restriction + independent
orchestrator-level validation), restated precisely against the new split types:

**Layer 1 — gate-level input restriction (§6.3):** the real terminal implementation will
not submit `requestedOutcome: "CONTINUE"` when `legalOutcomes` excludes it.

**Layer 2 — orchestrator-level validation:** after receiving *any* `HumanGateRawResponse`
(from the real gate, a future custom gate, or — in tests only — a fake),
`runAuditedReviewLoop.ts` constructs the round's `HumanDecisionRecord` as follows:

```
raw := the HumanGateRawResponse just received
recommendationAgreement := mapOutcome(raw.requestedOutcome) === recommendation.kind
                            ? "AGREED" : "OVERRODE"                              [§7.6]

if raw.requestedOutcome === "CONTINUE" AND round >= hardMaxRounds:
      outcome := "REJECTED"
      hardSafetyOverride := { reason: "hardMaxRounds (<n>) reached; a CONTINUE
                               request past the ceiling was not honored" }
      append a RunAuditEvent of kind "HARD_MAX_ROUNDS_OVERRIDE"
else:
      outcome := raw.requestedOutcome
      hardSafetyOverride := undefined

humanDecision := { schemaVersion, raw, outcome, recommendationAgreement, hardSafetyOverride }
```

No `HumanGate` implementation is ever consulted for, or able to influence,
`recommendationAgreement` or `hardSafetyOverride` — both are pure functions of
`(raw.requestedOutcome, recommendation.kind, round, hardMaxRounds)`, computed identically
regardless of which `HumanGate` implementation supplied `raw`.

### 6.6 `FakeHumanGate` isolation rules (unchanged from v3 §6.6; `FakeHumanGate` now implements the narrower `HumanGate` interface, returning only `HumanGateRawResponse`, which if anything makes a fake's job simpler and its scope-of-influence smaller)

---

## 7. Multi-agent roles

### 7.1–7.5 (unchanged from v3)

### 7.6 Outcome origin — three-way discriminator (updated: reads from `HumanDecisionRecord`)

Unchanged concept and unchanged type (`TerminalOutcomeOrigin`) from v3 §7.6. The
derivation rule is restated against the new type:

```
terminalRound := rounds[rounds.length - 1]
decision := terminalRound.humanDecision            // HumanDecisionRecord, not the old
                                                     // HumanGateResponse

outcomeOrigin :=
  if decision.hardSafetyOverride is present:            "HARD_SAFETY_OVERRIDE"
  else if decision.recommendationAgreement === "AGREED": "HUMAN_AGREED_WITH_RECOMMENDATION"
  else:                                                  "HUMAN_OVERRODE_RECOMMENDATION"
```

`recommendationAgreement` is still computed every round (§6.5), not only at the terminal
one, preserving the full-run override visibility v3 established.

---

## 8. Decision Engine specification (updated: adds the invalid-review-streak branch, mandatory change 4)

### 8.1 Inputs (updated — one new input added)

All inputs from v3 §8.1, **plus:**

- `invalidReviewStreak: number` — the count of *consecutive* rounds (ending at, and
  including, the current round if it is itself invalid) whose Reviewer response failed to
  parse. Reset rule, stated precisely:

  ```
  invalidReviewStreak(r) := invalidReviewThisRound(r) !== null
                             ? invalidReviewStreak(r-1) + 1
                             : 0
  ```

  This resets to `0` on **any** successfully-parsed round, regardless of what that round's
  content says (independent of `isCleanRound`, and independent of `cleanStreak` — the two
  streaks track different things and must not be conflated: `cleanStreak` measures ledger
  cleanliness across valid rounds; `invalidReviewStreak` measures the Reviewer's ability to
  produce parseable output at all).

### 8.2 Clean round definition (unchanged from v3 §8.2)

### 8.3 Chronic-claim reject trigger (unchanged from v3 §8.3)

### 8.3a Chronic invalid-review trigger (new, symmetric to §8.3)

```
invalidReviewIsChronic(r) := invalidReviewStreak(r) >= invalidReviewRejectThreshold  // default 3
```

Rationale, directly parallel to §8.3's: a Reviewer that cannot produce parseable output
several rounds running indicates a structural problem (a broken prompt, a model that has
drifted off the expected contract, an unrecoverable session state) that further rounds are
unlikely to fix — exactly the same "this is unlikely to be salvageable by continuing"
judgment §8.3 already makes for a chronically-reopened claim, now made for a chronically-
unparseable Reviewer.

### 8.4 Decision priority order — updated: one new branch, still a single function, still no bypass

**Every decision path is evaluated by exactly this one function, in exactly this priority
order. No caller ever computes or hardcodes a `DecisionRecommendation.kind` outside it.**

```
1. if round >= hardMaxRounds:
      kind := REJECT_RECOMMENDED
      reason := "hardMaxRounds (<n>) reached"

2. else if any claim in the ledger isChronic (§8.3):
      kind := REJECT_RECOMMENDED
      reason := "claim <id> reopened >= reopenRejectThreshold times"

3. else if invalidReviewIsChronic(r) (§8.3a):                                     // NEW
      kind := REJECT_RECOMMENDED
      reason := "reviewer response failed to parse for
                 invalidReviewStreak (=<n>) >= invalidReviewRejectThreshold
                 consecutive rounds"

4. else if invalidReviewThisRound is not null:
      kind := CONTINUE_RECOMMENDED
      reason := "reviewer response could not be parsed this round: <reason>;
                 ledger unchanged from round <r-1>; invalidReviewStreak=<n>"
      // Still never ACCEPT here, unchanged from v3 — an unparseable round cannot
      // validate anything new. Note this branch is now reached ONLY when the streak
      // has not yet crossed invalidReviewRejectThreshold — branch 3 above takes
      // precedence once it has, so there is exactly one place a chronic parse-failure
      // streak gets acted on, not two competing paths.

5. else if round > recommendedMaxRounds:
      kind := CONTINUE_RECOMMENDED
      reason := "round budget (recommendedMaxRounds=<n>) exceeded; consider REJECT or a
                 manual ACCEPT override if remaining claims are judged immaterial"

6. else if isCleanRound(r) AND cleanStreak(r) >= stabilityWindowRounds:
      kind := ACCEPT_RECOMMENDED
      reason := "<cleanStreak> consecutive clean rounds, no open HIGH/MEDIUM, no disputed
                 claims, no low-confidence resolutions"

7. else:
      kind := CONTINUE_RECOMMENDED
      reason := "<openHighCount> open HIGH, <openMediumCount> open MEDIUM,
                 <disputedCount> disputed, <lowConfidenceResolutions> low-confidence
                 resolution(s) remaining"
```

Branch 3's position — after `hardMaxRounds`/chronic-claim, before the ordinary
single-round invalid-review branch (now branch 4) — guarantees a persistently
malformed Reviewer is caught at exactly `invalidReviewRejectThreshold` consecutive
failures, never later (it cannot fall through to branch 4 indefinitely) and never earlier
(a single, or even two, isolated parse failures still just recommend `CONTINUE` via
branch 4, unchanged from v3's behavior for the non-chronic case).

### 8.5 Default thresholds (updated — one new row)

| Option | Default | Meaning |
|---|---|---|
| `stabilityWindowRounds` | 2 | reused from 4B |
| `disputedConfidenceBandLow` / `High` | 0.35 / 0.65 | reused from v1 §4.3 |
| `resolutionConfidenceThreshold` | 0.75 | minimum confidence a `RESOLVED` claim must have at resolution time to count toward a clean round |
| `reopenRejectThreshold` | 3 | `REOPENED` event count marking a claim chronic |
| `invalidReviewRejectThreshold` | 3 | **NEW** — consecutive unparseable-Reviewer-response count marking the run itself chronic (§8.3a) |
| `recommendedMaxRounds` | 10 | soft budget; affects recommendation *reason* text only |
| `hardMaxRounds` | 20 | hard ceiling; validated `> recommendedMaxRounds` at options-construction time; enforced independently of the Decision Engine by the orchestrator (§6.5) |

### 8.6 Updated `DecisionRecommendation` shape (one new field)

```ts
export interface DecisionRecommendation {
  kind: "CONTINUE_RECOMMENDED" | "ACCEPT_RECOMMENDED" | "REJECT_RECOMMENDED";
  round: number; reason: string; cleanStreak: number;
  openHighCount: number; openMediumCount: number; disputedCount: number;
  averageConfidence: number; lowConfidenceResolutionCount: number;
  invalidReviewStreak: number;          // NEW — always present, 0 when the most recent
                                          // round parsed successfully
  invalidReview?: { reason: string };   // unchanged from v3 — present iff THIS round's
                                          // recommendation came from branch 4 (a single
                                          // parse failure, not yet chronic)
}
```

### 8.7 Worked consequences (updated: two new bullets)

All of v3 §8.7's consequences hold, plus:

- **A run whose Reviewer fails to parse for `invalidReviewRejectThreshold` consecutive
  rounds recommends `REJECT`, not an indefinite string of `CONTINUE`s** — closing the gap
  the architect review identified (previously, only `hardMaxRounds` would eventually catch
  this, potentially wasting the entire round budget).
- **A single isolated parse failure, or an intermittent one (failure, success, failure,
  ...) never triggers the chronic branch** — `invalidReviewStreak` resets to `0` on every
  successful parse, so only genuinely *consecutive* failures accumulate toward
  `invalidReviewRejectThreshold`.

---

## 9. Backward compatibility

Unchanged from v3 §9 (§9.1–§9.4) — none of this revision's four required changes touch
`objectionLedger.ts`, `shared/severityRules.ts`, or any other 4B file. The migration plan,
its acceptance gate, and the frozen list are all identical to v3.

---

## 10. Audit trail (updated: one new `RunAuditEventKind`, `invalidReview` removal reflected)

```ts
export type RunAuditEventKind =
  | "HARD_MAX_ROUNDS_OVERRIDE"
  | "INVALID_REVIEW_ENCOUNTERED"
  | "INVALID_REVIEW_STREAK_THRESHOLD_REACHED"     // NEW — fired exactly once, the round
                                                    // §8.4 branch 3 first fires for this run
  | "RECOMMENDATION_OVERRIDDEN_BY_HUMAN"
  | "HUMAN_EVIDENCE_ATTACHED";

export interface RunAuditEvent {
  round: number; kind: RunAuditEventKind; detail: string; recordedAt: string;
}
```

`AuditedReviewResult.runAuditTrail` remains the single source of truth for every invalid
review that ever occurred across a run (one `"INVALID_REVIEW_ENCOUNTERED"` event per
occurrence, unchanged from v3), **plus** a distinct, unambiguous marker
(`"INVALID_REVIEW_STREAK_THRESHOLD_REACHED"`) for the specific moment the streak itself
became decision-relevant — a reader no longer has to recompute run-adjacency of
`"INVALID_REVIEW_ENCOUNTERED"` events themselves to notice this happened; the event is
logged directly, mirroring how `"HARD_MAX_ROUNDS_OVERRIDE"` gives a direct marker rather
than requiring a reader to notice "the round number equals `hardMaxRounds`."

**`AuditedReviewResult.invalidReview` is removed** (mandatory change 1). Every invalid
review, singular or repeated, is now representable **only** via
`rounds[i].recommendation.invalidReview` (single-round detail, §8.6) and `runAuditTrail`
(the full, multi-occurrence, run-level log, this section) — there is no longer a
redundant, ambiguously-defined third place the same fact could live.

### 10.1 Reconstructing "why," updated

All of v3 §10.1's lookup table holds, restated against the new types, plus one new row:

| Question | How it's answered |
|---|---|
| Why did the run's final outcome differ from what the human actually asked for? | `outcomeOrigin === "HARD_SAFETY_OVERRIDE"` points to the terminal round's `humanDecision.hardSafetyOverride.reason`, cross-referenced against the matching `RunAuditEvent` of kind `"HARD_MAX_ROUNDS_OVERRIDE"` in `runAuditTrail`. |
| **What did the claim ledger look like at round N?** (**new**) | **Read `rounds[N-1].ledgerSnapshot` directly** — no replay of history events required (§12.2). |
| Was every invalid review this run ever encountered visible, even ones that didn't change the outcome? | Filter `runAuditTrail` for `kind === "INVALID_REVIEW_ENCOUNTERED"` — one entry per occurrence, in round order, regardless of how many there were or whether the run ultimately accepted, rejected, or was forced to stop. |

---

## 11. (reserved — see §8 for the Decision Engine; §7.6 for outcome origin)

---

## 12. Data model (consolidated design sketch — updated: `invalidReview` removed, `ledgerSnapshot` added, HumanGate types split)

### 12.1 `schemaVersion` design (updated table — `HumanGateResponse` replaced by `HumanDecisionRecord`)

| Type | Versioned? | Why |
|---|---|---|
| `AuditedReviewResult` | Yes | Top-level unit. |
| `AuditedRoundRecord` | Yes | Maps to the anticipated `round-NN-*.json` per-round file; now also carries `ledgerSnapshot` (§12.2), making it a strictly more complete independent unit than in v3. |
| `ClaimLedgerSnapshot` | Yes | Maps to the anticipated `ledger.json` file (unchanged from v3). |
| `HumanDecisionRecord` | **Yes (renamed/split from v3's `HumanGateResponse`)** | The orchestrator-finalized decision unit — still the plausible target of a future independent, append-only decision log (§16.2, unchanged rationale from v3). |
| `HumanGateRawResponse` | **No (new type, deliberately unversioned)** | Transient input consumed immediately by the orchestrator to produce a `HumanDecisionRecord`; never itself an independently-persisted artifact — same treatment as `HumanGatePresentation`, which is also unversioned for the same reason. |
| `ClaimLedgerEntry`, `Evidence`, `DecisionRecommendation`, `HumanGatePresentation`, `ConfidenceChangeEvent`, `ClaimHistoryEvent`, `RunAuditEvent` | No | Each only ever travels inside an already-versioned container. |

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

export interface ClaimLedgerSnapshot {   // §12.1 — future ledger.json unit (unchanged from v3)
  schemaVersion: number; round: number; entries: ClaimLedgerEntry[];
}

export interface DecisionRecommendation {   // §8.6
  kind: "CONTINUE_RECOMMENDED" | "ACCEPT_RECOMMENDED" | "REJECT_RECOMMENDED";
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
  ledgerSnapshot: ClaimLedgerEntry[];        // NEW (§10.1, mandatory change 2) — full claim
                                               // ledger state as of the end of THIS round
                                               // (after ingest + any evidence bookkeeping),
                                               // directly mirroring
                                               // MILESTONE4B_DESIGN.md's
                                               // ConvergenceHistory.rounds[].ledgerSnapshot
  humanDecision: HumanDecisionRecord;         // RENAMED from v3's humanGateResponse
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
  claimLedger: ClaimLedgerEntry[];            // final ledger state; per-round state now
                                                // lives on each AuditedRoundRecord instead
  evidenceLog: Evidence[];
  runAuditTrail: RunAuditEvent[];
  hardMaxRounds: number; recommendedMaxRounds: number;
  invalidReviewRejectThreshold: number;       // NEW — recorded for audit, §8.5
  // invalidReview REMOVED (mandatory change 1) — see runAuditTrail and
  // rounds[i].recommendation.invalidReview instead
}
```

Every field remains plain, JSON-serializable data.

---

## 13. Prompt design

Unchanged from v3 §13 (§13.1, §13.2).

---

## 14. Round lifecycle (design, updated: ledgerSnapshot capture, split HumanGate types, invalidReviewStreak tracking)

```
state: INITIAL_GENERATOR
  → send task to Generator → wait → extract → G0
  → currentAnswer = G0; round = 1; invalidReviewStreak = 0

state: ROUND(r)
  → build Reviewer prompt from (task, currentAnswer, OPEN+DISPUTED claim ledger summary)
  → send to Reviewer → wait → extract → rawReview
  → parse rawReview (claims/structuredClaimParser.ts)
  → invalidReviewThisRound := parse succeeded ? null : { reason: <parse failure detail> }
  → invalidReviewStreak := invalidReviewThisRound === null ? 0 : invalidReviewStreak + 1  [§8.1]
  → if invalidReviewThisRound is null: ingest parsed claims into the Claim Ledger,
        including structural resolution evidence (§5.3)
    else: claim ledger untouched this round; append a RunAuditEvent of kind
        "INVALID_REVIEW_ENCOUNTERED" to runAuditTrail
  → ledgerSnapshot := a copy of the claim ledger's current entries (post-ingest, or
        unchanged from the prior round if invalidReviewThisRound is not null)          [§10.1]
  → Decision Engine computes a DecisionRecommendation (§8), given
        (ledger-derived counts, round r, hardMaxRounds, recommendedMaxRounds,
         invalidReviewThisRound, invalidReviewStreak)
        — this is the ONLY place a DecisionRecommendation.kind is ever produced         [§8.4]
  → if this round's recommendation.kind === "REJECT_RECOMMENDED" AND
        invalidReviewStreak >= invalidReviewRejectThreshold for the FIRST time
        this run: append a RunAuditEvent of kind
        "INVALID_REVIEW_STREAK_THRESHOLD_REACHED"                                       [§10]
  → orchestrator computes legalOutcomes := round >= hardMaxRounds
        ? ["ACCEPT","REJECT"] : ["CONTINUE","ACCEPT","REJECT"]                          [§6.5]
  → ════ HUMAN GATE (§6) — always fires ════
        present: claim ledger delta, disputed claims, relevantEvidence, recommendation +
                 reason, currentAnswer, legalOutcomes
        human optionally attaches evidence (§6.4); orchestrator ingests it, appends a
                 RunAuditEvent of kind "HUMAN_EVIDENCE_ATTACHED" if any was attached
        gate returns raw: HumanGateRawResponse { requestedOutcome, rationale?, decidedAt }
                                                                                          [§6.2]
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
  → record this round's AuditedRoundRecord, including ledgerSnapshot and humanDecision
  → act on humanDecision.outcome:
        ACCEPT   → STOP, result.outcome = "ACCEPTED",
                   result.outcomeOrigin := derive per §7.6, finalAnswer = currentAnswer
        REJECT   → STOP, result.outcome = "REJECTED",
                   result.outcomeOrigin := derive per §7.6, finalAnswer = currentAnswer
        CONTINUE → build Generator revision prompt (§13.1)
                   → send to Generator → wait → extract → Gr
                   → currentAnswer = Gr; round = r + 1; repeat
```

**Structural guarantees restated, now covering all four required changes:** exactly one
call site produces a `DecisionRecommendation.kind` (§8.4); exactly one call site produces
a `TerminalOutcomeOrigin` (§7.6); `recommendationAgreement`/`hardSafetyOverride` are
computable **only** by the orchestrator, from types (`HumanGateRawResponse`) that
structurally cannot carry them; every round's ledger state is captured directly, not left
to replay; and no invalid-review handling exists outside the one Decision Engine function.

---

## 15. Testing strategy (updated: new tests for streak handling, ledgerSnapshot, and the split gate types)

### 15.1 Unit tests — new/updated entries beyond v3 §15.1

| Test file | Covers |
|---|---|
| `tests/unit/decisionAgent.spec.ts` (**further expanded**) | **New:** 3 consecutive invalid reviews (default `invalidReviewRejectThreshold`) produce `REJECT_RECOMMENDED` via branch 3, with `invalidReviewStreak === 3` on the recommendation; **new:** 2 invalid + 1 valid + 2 invalid produces `CONTINUE_RECOMMENDED` throughout (streak never reaches 3, correctly resets on the valid round); **new:** a chronic claim (§8.3) still takes precedence over an invalid-review streak that has also crossed threshold in the same round (branch 2 before branch 3); **new:** `hardMaxRounds` still takes precedence over both (branch 1 before branch 2/3), re-confirming the architect review's original regression test still passes with the new branch inserted. |
| `tests/unit/runAuditedReviewLoop.spec.ts` (**further expanded**) | **New:** a run whose Reviewer never once produces a parseable response — assert it stops at exactly `invalidReviewRejectThreshold` rounds via `REJECT_RECOMMENDED`, not at `hardMaxRounds`, and that a `RunAuditEvent` of kind `"INVALID_REVIEW_STREAK_THRESHOLD_REACHED"` appears exactly once, at that round; **new:** assert every `AuditedRoundRecord.ledgerSnapshot` in a multi-round run matches the claim ledger's actual state at that point in the run (a direct equality check against an independently-tracked expected snapshot per round in the test's fake-adapter harness); **new:** assert a fake `HumanGate` that only ever returns `HumanGateRawResponse`-shaped values (i.e., cannot even attempt to set `recommendationAgreement`/`hardSafetyOverride`, since the type has no such fields) still produces correctly-computed values for both on every round — proving the orchestrator, not the gate, is the sole source. |
| `tests/unit/humanGate.spec.ts` (**updated**) | Re-targeted at `HumanGateRawResponse`/`HumanGate` (narrower interface); the `REJECT` without `rationale` rejection test (unchanged behavior) now operates on the narrower type. |

### 15.2 Simulation tests — one new scenario beyond v3 §15.2

- **Persistently malformed Reviewer:** a scripted run where the fake Reviewer adapter
  always returns unparseable text — confirm the run stops at round
  `invalidReviewRejectThreshold` with `outcome === "REJECTED"`,
  `outcomeOrigin === "HUMAN_AGREED_WITH_RECOMMENDATION"` (assuming the scripted human
  accepts the `REJECT_RECOMMENDED` recommendation) or
  `"HUMAN_OVERRODE_RECOMMENDATION"` (if scripted to `CONTINUE` instead, which remains
  legal since `round < hardMaxRounds` at that point) — confirming the streak-based reject
  is a *recommendation*, not itself a forced stop, consistent with every other
  recommendation kind in this design except the `hardMaxRounds` case specifically.

### 15.3 Real browser tests (unchanged from v3 §15.3)

### 15.4 Compatibility/regression checks (unchanged from v3 §15.4)

---

## 16. Open questions (unchanged from v3 §16 — nothing in this revision reopens or resolves any of them)

---

## 17. File / module plan (updated: reflects the split HumanGate types and new fields)

**Prerequisite (unchanged from v3 §17):** `src/orchestration/shared/severityRules.ts`, the
internal-only edit to `objectionLedger.ts`, `tests/unit/severityRules.spec.ts`,
`tests/unit/sharedSeverityRulesIsolation.spec.ts`.

**Milestone 5A new files (updated):**

- `src/orchestration/claims/types.ts` (§12.2, now including `HumanGateRawResponse`,
  `HumanDecisionRecord`, the expanded `RunAuditEventKind`, `ledgerSnapshot` on
  `AuditedRoundRecord`, and the removal of the old top-level `invalidReview` field)
- `src/orchestration/claims/claimLedger.ts`, `claimPrompts.ts`, `structuredClaimParser.ts`
  — unchanged file list from v3
- `src/orchestration/claims/decisionAgent.ts` (§8, now also accepting
  `invalidReviewStreak` and implementing §8.4's new branch 3)
- `src/orchestration/humanGate/humanGate.ts` (§6.2 — `HumanGate` interface now returns
  `HumanGateRawResponse`; `HumanDecisionRecord` construction lives in
  `runAuditedReviewLoop.ts`, not here)
- `src/orchestration/runAuditedReviewLoop.ts` (§14 — now owning `ledgerSnapshot` capture
  and all of `HumanDecisionRecord`'s construction)
- `scripts/smoke-audited-review.ts` + `npm run smoke:audited-review`
- `tests/unit/structuredClaimParser.spec.ts`, `claimLedger.spec.ts`,
  `decisionAgent.spec.ts`, `humanGate.spec.ts`, `runAuditedReviewLoop.spec.ts`,
  `claimsIsolation.spec.ts`, `humanGateIsolation.spec.ts`,
  `claimVsObjectionSemantics.spec.ts`, `evidenceLifecycle.spec.ts`
- `tests/unit/fakes/fakeHumanGate.ts` (now implementing the narrower `HumanGate` interface)

**Explicitly untouched:** unchanged from v3 §17.

---

## 18. Summary of what this revision closes

| Prior finding | Resolution |
|---|---|
| BLOCKING: `AuditedReviewResult.invalidReview` undefined/contradictory under v3's model | Removed (§10, §12.2); superseded by `runAuditTrail` + per-round `recommendation.invalidReview` |
| MEDIUM: no per-round ledger snapshot, unlike 4B's precedent | Added `AuditedRoundRecord.ledgerSnapshot` (§12.2), directly mirroring `ConvergenceHistory.rounds[].ledgerSnapshot` |
| MEDIUM: `HumanGateResponse` didn't structurally prevent gate-set orchestrator fields | Split into `HumanGateRawResponse` (gate-returned, narrow) and `HumanDecisionRecord` (orchestrator-only, richer) — §6.2 |
| MEDIUM: no cap on repeated invalid-review rounds | Added `invalidReviewStreak`/`invalidReviewRejectThreshold` as a new, symmetric priority branch inside the same Decision Engine (§8.3a, §8.4) |
