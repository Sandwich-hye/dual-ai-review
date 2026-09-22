import type { ClaimLedgerEntry, DecisionRecommendation } from "./types";

export interface DecisionAgentInput {
  claims: readonly ClaimLedgerEntry[];
  round: number;
  hardMaxRounds: number;
  recommendedMaxRounds: number;
  stabilityWindowRounds?: number;
  reopenRejectThreshold?: number;
  invalidReviewRejectThreshold?: number;
  resolutionConfidenceThreshold?: number;
  cleanStreak: number;
  invalidReviewStreak: number;
  invalidReviewThisRound: { reason: string } | null;
}

export function evaluateDecision(input: DecisionAgentInput): DecisionRecommendation {
  const stabilityWindowRounds = input.stabilityWindowRounds ?? 2;
  const reopenRejectThreshold = input.reopenRejectThreshold ?? 3;
  const invalidReviewRejectThreshold = input.invalidReviewRejectThreshold ?? 3;
  const resolutionConfidenceThreshold = input.resolutionConfidenceThreshold ?? 0.75;

  const openHighCount = input.claims.filter((claim) => claim.status === "OPEN" && claim.severity === "HIGH").length;
  const openMediumCount = input.claims.filter((claim) => claim.status === "OPEN" && claim.severity === "MEDIUM").length;
  const disputedCount = input.claims.filter((claim) => claim.status === "DISPUTED").length;
  const lowConfidenceResolutionCount = input.claims.filter(
    (claim) => claim.status === "RESOLVED" && claim.confidence < resolutionConfidenceThreshold,
  ).length;
  const confidenceClaims = input.claims.filter((claim) => claim.status === "OPEN" || claim.status === "DISPUTED");
  const averageConfidence = confidenceClaims.length === 0
    ? 0
    : confidenceClaims.reduce((total, claim) => total + claim.confidence, 0) / confidenceClaims.length;
  const chronicClaim = input.claims.find(
    (claim) => claim.history.filter((event) => event.kind === "REOPENED").length >= reopenRejectThreshold,
  );
  const isCleanRound = openHighCount === 0
    && openMediumCount === 0
    && disputedCount === 0
    && lowConfidenceResolutionCount === 0;
  const cleanStreak = isCleanRound ? input.cleanStreak : 0;
  const common = {
    round: input.round,
    cleanStreak,
    openHighCount,
    openMediumCount,
    disputedCount,
    averageConfidence,
    lowConfidenceResolutionCount,
    invalidReviewStreak: input.invalidReviewStreak,
  };

  if (input.round >= input.hardMaxRounds) {
    return {
      ...common,
      kind: "REJECT_RECOMMENDED",
      triggeredBranch: "HARD_MAX_ROUNDS_REACHED",
      reason: `hardMaxRounds (${input.hardMaxRounds}) reached`,
    };
  }

  if (chronicClaim) {
    return {
      ...common,
      kind: "REJECT_RECOMMENDED",
      triggeredBranch: "CHRONIC_CLAIM",
      reason: `claim ${chronicClaim.id} reopened >= reopenRejectThreshold times`,
    };
  }

  if (input.invalidReviewStreak >= invalidReviewRejectThreshold) {
    return {
      ...common,
      kind: "REJECT_RECOMMENDED",
      triggeredBranch: "INVALID_REVIEW_STREAK",
      reason: `reviewer response failed to parse for invalidReviewStreak (=${input.invalidReviewStreak}) >= invalidReviewRejectThreshold (${invalidReviewRejectThreshold}) consecutive rounds`,
      invalidReview: input.invalidReviewThisRound ?? { reason: "consecutive invalid reviews" },
    };
  }

  if (input.invalidReviewThisRound !== null) {
    return {
      ...common,
      kind: "CONTINUE_RECOMMENDED",
      triggeredBranch: "INVALID_REVIEW_SINGLE",
      reason: `reviewer response could not be parsed this round: ${input.invalidReviewThisRound.reason}; ledger unchanged from round ${input.round - 1}; invalidReviewStreak=${input.invalidReviewStreak}`,
      invalidReview: input.invalidReviewThisRound,
    };
  }

  if (input.round > input.recommendedMaxRounds) {
    return {
      ...common,
      kind: "CONTINUE_RECOMMENDED",
      triggeredBranch: "SOFT_BUDGET_EXCEEDED",
      reason: `round budget (recommendedMaxRounds=${input.recommendedMaxRounds}) exceeded; consider REJECT or a manual ACCEPT override if remaining claims are judged immaterial`,
    };
  }

  if (isCleanRound && input.cleanStreak >= stabilityWindowRounds) {
    return {
      ...common,
      kind: "ACCEPT_RECOMMENDED",
      triggeredBranch: "CLEAN_ACCEPT",
      reason: `${input.cleanStreak} consecutive clean rounds, no open HIGH/MEDIUM, no disputed claims, no low-confidence resolutions`,
    };
  }

  return {
    ...common,
    kind: "CONTINUE_RECOMMENDED",
    triggeredBranch: "DEFAULT_CONTINUE",
    reason: `${openHighCount} open HIGH, ${openMediumCount} open MEDIUM, ${disputedCount} disputed, ${lowConfidenceResolutionCount} low-confidence resolution(s) remaining`,
  };
}
