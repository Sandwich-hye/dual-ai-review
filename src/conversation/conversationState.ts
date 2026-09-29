import type {
  AuditedReviewResult,
  DecisionRecommendation,
  HumanGateOutcome,
  TerminalOutcomeOrigin,
} from "../orchestration/claims/types";
import type {
  SupervisorAssessment,
  SupervisorFlagKind,
  SupervisorUnavailable,
} from "../orchestration/supervisor/types";

export const CONVERSATION_SCHEMA_VERSION = 1;

export type JevConvergenceSignal =
  | {
      available: true;
      flags: readonly SupervisorFlagKind[];
      riskLevel: "none" | "advisory" | "elevated";
      detail: readonly string[];
    }
  | { available: false; reason: string };

/** Presentation-only relabeling of the existing advisory assessment. */
export function toJevConvergenceSignal(
  assessment: SupervisorAssessment | SupervisorUnavailable,
): JevConvergenceSignal {
  if ("unavailable" in assessment) return Object.freeze({ available: false, reason: assessment.reason });
  return Object.freeze({
    available: true,
    flags: Object.freeze(assessment.flags.map((flag) => flag.flag)),
    riskLevel: assessment.escalationRecommended ? "elevated" as const
      : assessment.flags.length > 0 ? "advisory" as const : "none" as const,
    detail: Object.freeze(assessment.flags.map((flag) => flag.detail)),
  });
}

interface RoundState {
  schemaVersion: typeof CONVERSATION_SCHEMA_VERSION;
  task: string;
  round: number;
  /** The current round is not committed until the audited loop records it. */
  roundsCompleted: number;
  currentAnswer: string;
  recommendationKind: DecisionRecommendation["kind"];
  legalOutcomes: readonly HumanGateOutcome[];
  latestJevSignal?: JevConvergenceSignal;
}

/** Read-only observations, never input to the Decision Agent or Human Gate. */
export type ConversationState =
  | (RoundState & { status: "awaiting_human" })
  | (RoundState & { status: "human_decision_submitted"; humanRequestedOutcome: HumanGateOutcome })
  | {
      schemaVersion: typeof CONVERSATION_SCHEMA_VERSION;
      status: "complete";
      task: string;
      round: number;
      roundsCompleted: number;
      terminalOutcome: AuditedReviewResult["outcome"];
      outcomeOrigin: TerminalOutcomeOrigin;
      latestJevSignal?: JevConvergenceSignal;
    };

export interface ConversationLifecycleMetadata {
  schemaVersion: typeof CONVERSATION_SCHEMA_VERSION;
  startedAt: string;
  completedAt: string;
  roundsCompleted: number;
  terminalOutcome: AuditedReviewResult["outcome"];
}
