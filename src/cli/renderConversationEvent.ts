import {
  CONVERSATION_EVENT_SCHEMA_VERSION,
  type ConversationEventObserver,
} from "../conversation/conversationEvents";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  isNonNegativeInteger(value) && value > 0;

const isOneOf = (value: unknown, choices: readonly string[]): value is string =>
  typeof value === "string" && choices.includes(value);

/** Only validated, bounded lifecycle metadata reaches the terminal. */
export function renderConversationEvent(value: unknown): string | undefined {
  try {
    if (!isRecord(value)
      || value.schemaVersion !== CONVERSATION_EVENT_SCHEMA_VERSION
      || !isPositiveInteger(value.sequence)
      || typeof value.emittedAt !== "string") return undefined;

    switch (value.type) {
      case "conversation_started":
        return typeof value.task === "string" ? "[Conversation] Started." : undefined;
      case "round_started":
        return isPositiveInteger(value.round) ? `[Round ${value.round}] Started.` : undefined;
      case "generator_completed":
        if (!isNonNegativeInteger(value.round) || !isNonNegativeInteger(value.responseLength)) return undefined;
        return value.round === 0
          ? `[Generator] Initial response complete (${value.responseLength} chars).`
          : `[Generator] Round ${value.round} revision complete (${value.responseLength} chars).`;
      case "reviewer_completed":
        return isPositiveInteger(value.round) && isNonNegativeInteger(value.responseLength)
          ? `[Reviewer] Round ${value.round} response complete (${value.responseLength} chars).`
          : undefined;
      case "jev_advisory_generated": {
        if (!isPositiveInteger(value.round) || !isRecord(value.signal)) return undefined;
        if (value.signal.available === false) {
          return typeof value.signal.reason === "string"
            ? `[JEV] Round ${value.round} advisory unavailable.`
            : undefined;
        }
        if (value.signal.available !== true
          || !isOneOf(value.signal.riskLevel, ["none", "advisory", "elevated"])
          || !Array.isArray(value.signal.flags)
          || !value.signal.flags.every((flag: unknown) => isOneOf(flag, ["STAGNATION", "DECISION_INCONSISTENCY", "ABNORMAL_WORKFLOW"]))
          || !Array.isArray(value.signal.detail)
          || !value.signal.detail.every((detail: unknown) => typeof detail === "string")) return undefined;
        const flags = value.signal.flags.length === 0 ? "none" : value.signal.flags.join(", ");
        return `[JEV] Round ${value.round} advisory: ${value.signal.riskLevel}; flags: ${flags}.`;
      }
      case "human_gate_waiting":
        return isPositiveInteger(value.round)
          && isOneOf(value.recommendationKind, ["CONTINUE_RECOMMENDED", "ACCEPT_RECOMMENDED", "REJECT_RECOMMENDED"])
          ? `[Human Gate] Round ${value.round}: waiting for a human decision (${value.recommendationKind}).`
          : undefined;
      case "conversation_completed":
        return isNonNegativeInteger(value.roundsCompleted)
          && isOneOf(value.outcome, ["ACCEPTED", "REJECTED"])
          && isOneOf(value.outcomeOrigin, ["HUMAN_AGREED_WITH_RECOMMENDATION", "HUMAN_OVERRODE_RECOMMENDATION", "HARD_SAFETY_OVERRIDE"])
          ? `[Conversation] Completed: ${value.outcome} after ${value.roundsCompleted} ${value.roundsCompleted === 1 ? "round" : "rounds"} (${value.outcomeOrigin}).`
          : undefined;
      default:
        return undefined;
    }
  } catch {
    // Malformed or hostile event objects cannot interrupt an active review.
    return undefined;
  }
}

/** Terminal output is an observer, never a source of review decisions. */
export function createTerminalConversationObserver(writeLine: (line: string) => void = console.log): ConversationEventObserver {
  return {
    onEvent(event) {
      try {
        const line = renderConversationEvent(event);
        if (line !== undefined) writeLine(line);
      } catch {
        // Output failures are isolated even when this observer is used directly.
      }
    },
  };
}
