import type { SupervisorAssessment, SupervisorFlag, SupervisorUnavailable } from "../types";
import type { LlmSupervisorSettlement } from "./contracts";

export const INVALID_SUPERVISOR_OUTCOME_REASON = "invalid supervisor outcome";
export const REJECTED_SUPERVISOR_OUTCOME_REASON = "supervisor assessment failed";

const flagKinds = new Set(["STAGNATION", "DECISION_INCONSISTENCY", "ABNORMAL_WORKFLOW"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): LlmSupervisorSettlement {
  return { kind: "failure", source: "invalid", reason: INVALID_SUPERVISOR_OUTCOME_REASON };
}

/** Classifies a fulfilled adapter value without trusting its TypeScript return annotation. */
export function classifyLlmSupervisorOutcome(value: unknown, expectedRound: number): LlmSupervisorSettlement {
  try {
    if (!Number.isSafeInteger(expectedRound) || expectedRound < 1 || !isRecord(value) || value.round !== expectedRound) {
      return invalid();
    }

    if ("unavailable" in value) {
      if (value.unavailable !== true || typeof value.reason !== "string" || value.reason.trim() === "") {
        return invalid();
      }
      const unavailable: SupervisorUnavailable = {
        unavailable: true,
        round: expectedRound,
        reason: value.reason,
      };
      return { kind: "failure", source: "unavailable", reason: unavailable.reason };
    }

    if (!Array.isArray(value.flags) || typeof value.escalationRecommended !== "boolean") {
      return invalid();
    }
    if (value.escalationReason !== undefined && typeof value.escalationReason !== "string") {
      return invalid();
    }

    const flags: SupervisorFlag[] = [];
    for (const flag of value.flags) {
      if (!isRecord(flag) || !flagKinds.has(flag.flag as string) ||
          typeof flag.detail !== "string" || !Array.isArray(flag.evidenceRounds) ||
          !flag.evidenceRounds.every((round: unknown) =>
            Number.isSafeInteger(round) && (round as number) >= 1 && (round as number) <= expectedRound)) {
        return invalid();
      }
      flags.push({
        flag: flag.flag as SupervisorFlag["flag"],
        detail: flag.detail,
        evidenceRounds: [...flag.evidenceRounds],
      });
    }

    const assessment: SupervisorAssessment = {
      round: expectedRound,
      flags,
      escalationRecommended: value.escalationRecommended,
    };
    if (value.escalationReason !== undefined) assessment.escalationReason = value.escalationReason;
    return { kind: "assessment", assessment };
  } catch {
    // A hostile getter or Proxy must not make outcome normalization reject.
    return invalid();
  }
}

/** Rejections use the same failure branch as fulfilled SupervisorUnavailable. */
export function classifyLlmSupervisorRejection(error: unknown): LlmSupervisorSettlement {
  try {
    const reason = error instanceof Error && typeof error.message === "string" && error.message.trim() !== ""
      ? error.message
      : REJECTED_SUPERVISOR_OUTCOME_REASON;
    return { kind: "failure", source: "rejected", reason };
  } catch {
    return { kind: "failure", source: "rejected", reason: REJECTED_SUPERVISOR_OUTCOME_REASON };
  }
}
