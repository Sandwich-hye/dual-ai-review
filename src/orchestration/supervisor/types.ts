import type {
  AuditedReviewResult,
  DecisionBranch,
  DecisionRecommendation,
  HumanGateOutcome,
  RecommendationAgreement,
  HumanGatePresentation,
  HumanGateRawResponse,
} from "../claims/types";
import { inferHardSafetyOverride, inferRecommendationAgreement } from "./inference";

/** Structured, non-prose projection of a Milestone 5 recommendation. */
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

/** The single projection boundary exposed to Supervisor implementations. */
export function toSupervisorRecommendationSignal(
  recommendation: DecisionRecommendation,
): SupervisorRecommendationSignal {
  const {
    round,
    triggeredBranch,
    cleanStreak,
    openHighCount,
    openMediumCount,
    disputedCount,
    averageConfidence,
    lowConfidenceResolutionCount,
    invalidReviewStreak,
  } = recommendation;
  return {
    round,
    triggeredBranch,
    cleanStreak,
    openHighCount,
    openMediumCount,
    disputedCount,
    averageConfidence,
    lowConfidenceResolutionCount,
    invalidReviewStreak,
  };
}

export interface SupervisorRoundSignal {
  roundNumber: number;
  recommendation: SupervisorRecommendationSignal;
  recommendationAgreement?: RecommendationAgreement;
  hardSafetyOverrideInferred?: boolean;
  outcome?: HumanGateOutcome;
}

export interface SupervisorInput {
  rounds: SupervisorRoundSignal[];
  invalidReviewRejectThreshold: number;
  reopenRejectThreshold: number;
}

export function toSupervisorRoundSignal(
  presentation: HumanGatePresentation,
  rawResponse: HumanGateRawResponse,
): SupervisorRoundSignal {
  return {
    roundNumber: presentation.round,
    recommendation: toSupervisorRecommendationSignal(presentation.recommendation),
    recommendationAgreement: inferRecommendationAgreement(presentation.recommendation.kind, rawResponse.requestedOutcome),
    hardSafetyOverrideInferred: inferHardSafetyOverride(rawResponse.requestedOutcome, presentation.legalOutcomes),
    outcome: rawResponse.requestedOutcome,
  };
}

export type SupervisorFlagKind =
  | "STAGNATION"
  | "DECISION_INCONSISTENCY"
  | "ABNORMAL_WORKFLOW";

export interface SupervisorFlag {
  flag: SupervisorFlagKind;
  detail: string;
  evidenceRounds: number[];
}

/** Compatibility name used by the design sketch for the same flag contract. */
export type SupervisorFlagDetail = SupervisorFlag;

export type SupervisorAssessmentRecord =
  (SupervisorAssessment | SupervisorUnavailable) & { renderingFailure?: { reason: string } };

export interface SupervisorAssessment {
  round: number;
  flags: SupervisorFlag[];
  escalationRecommended: boolean;
  escalationReason?: string;
}

export interface SupervisorUnavailable {
  unavailable: true;
  round: number;
  reason: string;
}

export interface Supervisor {
  assess(input: SupervisorInput): Promise<SupervisorAssessment | SupervisorUnavailable>;
}

export const SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION = 1;

export interface SupervisedReviewResult {
  schemaVersion: number;
  base: AuditedReviewResult;
  supervisorAssessments: (SupervisorAssessment | SupervisorUnavailable)[];
}
