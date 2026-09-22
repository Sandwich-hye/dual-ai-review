import { test, expect } from "@playwright/test";
import {
  AUDITED_REVIEW_SCHEMA_VERSION,
  AUDITED_ROUND_SCHEMA_VERSION,
  CLAIM_LEDGER_SNAPSHOT_SCHEMA_VERSION,
  HUMAN_DECISION_RECORD_SCHEMA_VERSION,
  type AuditedReviewResult,
  type ClaimLedgerEntry,
  type DecisionRecommendation,
  type Evidence,
  type HumanDecisionRecord,
} from "../../src/orchestration/claims/types";

const evidence: Evidence = {
  id: "EVIDENCE-1",
  claimId: "CLAIM-1",
  kind: "SUPPORTING",
  strength: "STRONG",
  sourceRole: "REVIEWER",
  text: "The reviewer supplied supporting evidence.",
  round: 1,
  submittedAt: "2026-09-22T00:00:00.000Z",
};

const claim: ClaimLedgerEntry = {
  id: "CLAIM-1",
  claim: { statement: "A claim", rationale: "A reason" },
  severity: "HIGH",
  highestSeveritySeen: "HIGH",
  confidence: 0.8,
  status: "OPEN",
  evidenceFor: [evidence.id],
  evidenceAgainst: [],
  confidenceHistory: [
    {
      round: 1,
      previousConfidence: 0.5,
      newConfidence: 0.8,
      causeEvidenceId: evidence.id,
    },
  ],
  firstSeenRound: 1,
  lastSeenRound: 1,
  normalizedFingerprint: ["claim"],
  history: [{ round: 1, kind: "RAISED" }],
};

const recommendation: DecisionRecommendation = {
  kind: "CONTINUE_RECOMMENDED",
  triggeredBranch: "DEFAULT_CONTINUE",
  round: 1,
  reason: "A blocking claim remains open.",
  cleanStreak: 0,
  openHighCount: 1,
  openMediumCount: 0,
  disputedCount: 0,
  averageConfidence: 0.8,
  lowConfidenceResolutionCount: 0,
  invalidReviewStreak: 0,
};

const humanDecision: HumanDecisionRecord = {
  schemaVersion: HUMAN_DECISION_RECORD_SCHEMA_VERSION,
  raw: {
    requestedOutcome: "CONTINUE",
    decidedAt: "2026-09-22T00:01:00.000Z",
  },
  outcome: "CONTINUE",
  recommendationAgreement: "AGREED",
};

const result: AuditedReviewResult = {
  schemaVersion: AUDITED_REVIEW_SCHEMA_VERSION,
  originalTask: "Review this task.",
  outcome: "ACCEPTED",
  outcomeOrigin: "HUMAN_AGREED_WITH_RECOMMENDATION",
  finalAnswer: "Final answer.",
  initial: {
    prompt: "Initial prompt.",
    response: "Initial response.",
    startedAt: "2026-09-22T00:00:00.000Z",
    completedAt: "2026-09-22T00:00:01.000Z",
  },
  rounds: [
    {
      schemaVersion: AUDITED_ROUND_SCHEMA_VERSION,
      roundNumber: 1,
      reviewerPrompt: "Review prompt.",
      reviewerRawResponse: "Review response.",
      recommendation,
      ledgerSnapshot: [claim],
      humanDecision,
      humanSuppliedEvidence: [evidence],
    },
  ],
  claimLedger: [claim],
  evidenceLog: [evidence],
  runAuditTrail: [
    {
      round: 1,
      kind: "HUMAN_EVIDENCE_ATTACHED",
      detail: "Evidence attached.",
      recordedAt: "2026-09-22T00:01:00.000Z",
    },
  ],
  hardMaxRounds: 5,
  recommendedMaxRounds: 3,
  invalidReviewRejectThreshold: 3,
};

test("the complete audited result is JSON serializable", () => {
  const parsed: unknown = JSON.parse(JSON.stringify(result));
  expect(parsed).toEqual(result);
});

test("schema versions are present at each versioned contract boundary", () => {
  expect(AUDITED_REVIEW_SCHEMA_VERSION).toBe(1);
  expect(AUDITED_ROUND_SCHEMA_VERSION).toBe(1);
  expect(CLAIM_LEDGER_SNAPSHOT_SCHEMA_VERSION).toBe(1);
  expect(HUMAN_DECISION_RECORD_SCHEMA_VERSION).toBe(1);
  expect(result.schemaVersion).toBe(AUDITED_REVIEW_SCHEMA_VERSION);
  expect(result.rounds[0].schemaVersion).toBe(AUDITED_ROUND_SCHEMA_VERSION);
  expect(humanDecision.schemaVersion).toBe(HUMAN_DECISION_RECORD_SCHEMA_VERSION);
});

test("contract boundaries preserve the defined lifecycle and discriminated values", () => {
  expect(["OPEN", "DISPUTED", "RESOLVED", "REJECTED"]).toContain(claim.status);
  expect(["CONTINUE_RECOMMENDED", "ACCEPT_RECOMMENDED", "REJECT_RECOMMENDED"]).toContain(recommendation.kind);
  expect([
    "HARD_MAX_ROUNDS_REACHED",
    "CHRONIC_CLAIM",
    "INVALID_REVIEW_STREAK",
    "INVALID_REVIEW_SINGLE",
    "SOFT_BUDGET_EXCEEDED",
    "CLEAN_ACCEPT",
    "DEFAULT_CONTINUE",
  ]).toContain(recommendation.triggeredBranch);
  expect(["CONTINUE", "ACCEPT", "REJECT"]).toContain(humanDecision.outcome);
  expect(result.evidenceLog[0].claimId).toBe(claim.id);
  expect(result.rounds[0].ledgerSnapshot[0].id).toBe(claim.id);
});
