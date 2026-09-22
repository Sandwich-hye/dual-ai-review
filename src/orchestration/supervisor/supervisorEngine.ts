import type {
  SupervisorAssessment,
  SupervisorFlag,
  SupervisorInput,
} from "./types";

export interface SupervisorEngineOptions {
  stagnationWindowRounds?: number;
  decisionInconsistencyWindowRounds?: number;
  invalidReviewFlapThreshold?: number;
}

const DEFAULTS = {
  stagnationWindowRounds: 4,
  decisionInconsistencyWindowRounds: 3,
  invalidReviewFlapThreshold: 2,
};

export function evaluateSupervisorState(
  input: SupervisorInput,
  suppliedOptions: SupervisorEngineOptions = {},
): SupervisorAssessment {
  const options = { ...DEFAULTS, ...suppliedOptions };
  const rounds = input.rounds;
  const currentRound = rounds.at(-1)?.roundNumber ?? 0;
  const flags: SupervisorFlag[] = [];

  const stagnationWindow = rounds.slice(-options.stagnationWindowRounds);
  if (
    stagnationWindow.length >= options.stagnationWindowRounds
    && (stagnationWindow.at(-1)!.recommendation.openHighCount
      + stagnationWindow.at(-1)!.recommendation.openMediumCount
      + stagnationWindow.at(-1)!.recommendation.disputedCount)
      >= (stagnationWindow[0].recommendation.openHighCount
        + stagnationWindow[0].recommendation.openMediumCount
        + stagnationWindow[0].recommendation.disputedCount)
  ) {
    flags.push({
      flag: "STAGNATION",
      detail: `blocking load did not improve across the last ${options.stagnationWindowRounds} rounds`,
      evidenceRounds: stagnationWindow.map((round) => round.roundNumber),
    });
  }

  const completedRounds = rounds.filter((round) => (
    round.outcome !== undefined && round.recommendationAgreement !== undefined
  ));
  const consistencyWindow = completedRounds.slice(-options.decisionInconsistencyWindowRounds);
  if (
    consistencyWindow.length >= options.decisionInconsistencyWindowRounds
    && consistencyWindow.every((round) => round.recommendationAgreement === "OVERRODE")
  ) {
    flags.push({
      flag: "DECISION_INCONSISTENCY",
      detail: `the human overrode the Decision Agent in each of the last ${options.decisionInconsistencyWindowRounds} rounds`,
      evidenceRounds: consistencyWindow.map((round) => round.roundNumber),
    });
  }

  let activeInvalidCyclePeak = 0;
  let invalidReviewFlapCount = 0;
  const flapRounds: number[] = [];
  for (const round of rounds) {
    const streak = round.recommendation.invalidReviewStreak;
    if (streak > 0) {
      activeInvalidCyclePeak = Math.max(activeInvalidCyclePeak, streak);
      flapRounds.push(round.roundNumber);
    } else if (activeInvalidCyclePeak > 0) {
      if (activeInvalidCyclePeak < input.invalidReviewRejectThreshold) invalidReviewFlapCount += 1;
      activeInvalidCyclePeak = 0;
    }
  }

  const hardSafetyRounds = rounds
    .filter((round) => round.hardSafetyOverrideInferred)
    .map((round) => round.roundNumber);
  const invalidReviewThresholdRounds = rounds
    .filter((round, index) => round.recommendation.triggeredBranch === "INVALID_REVIEW_STREAK"
      && index > 0
      && rounds[index - 1].recommendation.triggeredBranch !== "INVALID_REVIEW_STREAK")
    .map((round) => round.roundNumber);
  if (
    hardSafetyRounds.length > 0
    || invalidReviewThresholdRounds.length > 0
    || invalidReviewFlapCount >= options.invalidReviewFlapThreshold
  ) {
    const evidenceRounds = [...new Set([
      ...hardSafetyRounds,
      ...invalidReviewThresholdRounds,
      ...(invalidReviewFlapCount >= options.invalidReviewFlapThreshold ? flapRounds : []),
    ])].sort((left, right) => left - right);
    const reasons = [
      hardSafetyRounds.length > 0 || invalidReviewThresholdRounds.length > 0 ? "hard-ceiling or chronic-invalid-review signal" : "",
      invalidReviewFlapCount >= options.invalidReviewFlapThreshold
        ? `${invalidReviewFlapCount} sub-threshold invalid-review flap cycles`
        : "",
    ].filter(Boolean);
    flags.push({
      flag: "ABNORMAL_WORKFLOW",
      detail: `abnormal workflow detected: ${reasons.join("; ")}`,
      evidenceRounds: evidenceRounds.length > 0 ? evidenceRounds : [currentRound],
    });
  }

  return {
    round: currentRound,
    flags,
    escalationRecommended: flags.length > 0,
    ...(flags.length === 0 ? {} : { escalationReason: flags.map((flag) => flag.detail).join(" | ") }),
  };
}
