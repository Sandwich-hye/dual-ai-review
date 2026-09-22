// Pure severity arithmetic shared by the Milestone 4B objection ledger and the
// Milestone 5 claim ledger. Mutation and history recording remain local to each
// ledger.

export type ReviewSeverity = "LOW" | "MEDIUM" | "HIGH";

export const SEVERITY_ORDER: Record<ReviewSeverity, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

export const rankOf = (severity: ReviewSeverity): number => SEVERITY_ORDER[severity];

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
): SeverityAdjustResult {
  const proposedRank = rankOf(proposedSeverity);
  const currentRank = rankOf(currentSeverity);

  if (proposedRank > currentRank) {
    return {
      newSeverity: proposedSeverity,
      newHighestSeveritySeen:
        rankOf(currentHighestSeveritySeen) >= proposedRank
          ? currentHighestSeveritySeen
          : proposedSeverity,
      event: "ESCALATED",
    };
  }

  if (proposedRank < currentRank) {
    return {
      newSeverity: currentSeverity,
      newHighestSeveritySeen: currentHighestSeveritySeen,
      event: "DOWNGRADE_REJECTED",
    };
  }

  return {
    newSeverity: currentSeverity,
    newHighestSeveritySeen: currentHighestSeveritySeen,
    event: "UNCHANGED",
  };
}

export interface SeverityReopenResult {
  newSeverity: ReviewSeverity;
  newHighestSeveritySeen: ReviewSeverity;
  floored: boolean;
}

export function computeReopenSeverity(
  severityAtResolution: ReviewSeverity,
  highestSeveritySeen: ReviewSeverity,
  override: ReviewSeverity | undefined,
): SeverityReopenResult {
  const requestedSeverity = override ?? severityAtResolution;
  const newSeverity =
    rankOf(highestSeveritySeen) >= rankOf(requestedSeverity)
      ? highestSeveritySeen
      : requestedSeverity;
  const newHighestSeveritySeen =
    rankOf(highestSeveritySeen) >= rankOf(newSeverity)
      ? highestSeveritySeen
      : newSeverity;

  return {
    newSeverity,
    newHighestSeveritySeen,
    floored: rankOf(newSeverity) > rankOf(requestedSeverity),
  };
}
