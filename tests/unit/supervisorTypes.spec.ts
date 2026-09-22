import { test, expect } from "@playwright/test";
import {
  SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION,
  toSupervisorRecommendationSignal,
  type SupervisorAssessment,
  type SupervisorInput,
  type SupervisedReviewResult,
} from "../../src/orchestration/supervisor/types";
import type { DecisionRecommendation } from "../../src/orchestration/claims/types";

const recommendation: DecisionRecommendation = {
  kind: "CONTINUE_RECOMMENDED",
  triggeredBranch: "DEFAULT_CONTINUE",
  round: 2,
  reason: "internal diagnostic prose must not cross the supervisor boundary",
  cleanStreak: 1,
  openHighCount: 1,
  openMediumCount: 2,
  disputedCount: 1,
  averageConfidence: 0.5,
  lowConfidenceResolutionCount: 1,
  invalidReviewStreak: 0,
  invalidReview: { reason: "also excluded" },
};

const input: SupervisorInput = {
  rounds: [{
    roundNumber: 2,
    recommendation: toSupervisorRecommendationSignal(recommendation),
    recommendationAgreement: "OVERRODE",
    outcome: "CONTINUE",
  }],
  auditEvents: [{ round: 1, kind: "INVALID_REVIEW_ENCOUNTERED" }],
  hardMaxRounds: 5,
  recommendedMaxRounds: 3,
  invalidReviewRejectThreshold: 3,
  reopenRejectThreshold: 3,
};

test("maps only structured recommendation state into the Supervisor signal", () => {
  const signal = toSupervisorRecommendationSignal(recommendation);
  expect(signal).toEqual({
    round: 2,
    triggeredBranch: "DEFAULT_CONTINUE",
    cleanStreak: 1,
    openHighCount: 1,
    openMediumCount: 2,
    disputedCount: 1,
    averageConfidence: 0.5,
    lowConfidenceResolutionCount: 1,
    invalidReviewStreak: 0,
  });
  expect(signal).not.toHaveProperty("kind");
  expect(signal).not.toHaveProperty("reason");
  expect(signal).not.toHaveProperty("invalidReview");
});

test("Supervisor input and assessment contracts serialize as JSON", () => {
  const assessment: SupervisorAssessment = {
    round: 2,
    flags: [{
      flag: "STAGNATION",
      detail: "blocking load did not improve",
      evidenceRounds: [1, 2],
    }],
    escalationRecommended: true,
    escalationReason: "stagnation detected",
  };
  const result: SupervisedReviewResult = {
    schemaVersion: SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION,
    base: {} as SupervisedReviewResult["base"],
    supervisorAssessments: [assessment, { unavailable: true, round: 3, reason: "Supervisor unavailable" }],
  };

  expect(JSON.parse(JSON.stringify(input))).toEqual(input);
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});

test("Supervisor flags and unavailable assessments preserve their contract boundaries", () => {
  const assessment: SupervisorAssessment = {
    round: 1,
    flags: [
      { flag: "STAGNATION", detail: "detail", evidenceRounds: [1] },
      { flag: "DECISION_INCONSISTENCY", detail: "detail", evidenceRounds: [1] },
      { flag: "ABNORMAL_WORKFLOW", detail: "detail", evidenceRounds: [1] },
    ],
    escalationRecommended: true,
    escalationReason: "three flags",
  };
  expect(assessment.flags.every((flag) => flag.evidenceRounds.length > 0)).toBe(true);
  expect({ unavailable: true, round: 1, reason: "failure" }).toMatchObject({ unavailable: true });
});
