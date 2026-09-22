import type {
  DecisionRecommendation,
  HumanGateOutcome,
  RecommendationAgreement,
} from "../claims/types";

export function inferRecommendationAgreement(
  recommendationKind: DecisionRecommendation["kind"],
  requestedOutcome: HumanGateOutcome,
): RecommendationAgreement {
  const mappedOutcome: HumanGateOutcome = recommendationKind === "ACCEPT_RECOMMENDED"
    ? "ACCEPT"
    : recommendationKind === "REJECT_RECOMMENDED" ? "REJECT" : "CONTINUE";
  return requestedOutcome === mappedOutcome ? "AGREED" : "OVERRODE";
}

export function inferHardSafetyOverride(
  requestedOutcome: HumanGateOutcome,
  legalOutcomes: HumanGateOutcome[],
): boolean {
  return requestedOutcome === "CONTINUE" && !legalOutcomes.includes("CONTINUE");
}
