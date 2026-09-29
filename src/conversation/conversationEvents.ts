import type {
  AuditedReviewResult,
  DecisionRecommendation,
  TerminalOutcomeOrigin,
} from "../orchestration/claims/types";
import type { JevConvergenceSignal } from "./conversationState";

export const CONVERSATION_EVENT_SCHEMA_VERSION = 1;

interface ConversationEventBase {
  schemaVersion: typeof CONVERSATION_EVENT_SCHEMA_VERSION;
  sequence: number;
  emittedAt: string;
}

export type ConversationEventData =
  | { type: "conversation_started"; task: string }
  | { type: "round_started"; round: number }
  | { type: "generator_completed"; round: number; responseLength: number }
  | { type: "reviewer_completed"; round: number; responseLength: number }
  | { type: "jev_advisory_generated"; round: number; signal: JevConvergenceSignal }
  | { type: "human_gate_waiting"; round: number; recommendationKind: DecisionRecommendation["kind"] }
  | {
      type: "conversation_completed";
      roundsCompleted: number;
      outcome: AuditedReviewResult["outcome"];
      outcomeOrigin: TerminalOutcomeOrigin;
    };

/** Event data is for observation only; it never feeds back into the audited loop. */
export type ConversationEvent = Readonly<ConversationEventBase & ConversationEventData>;

export interface ConversationEventObserver {
  onEvent(event: ConversationEvent): void | Promise<void>;
}

/** A per-run sequence; observer failures are isolated, including async rejections. */
export function createConversationEventEmitter(observer?: ConversationEventObserver): (data: ConversationEventData) => void {
  let sequence = 0;
  return (data) => {
    sequence += 1;
    if (!observer) return;
    const event: ConversationEvent = Object.freeze({
      ...data,
      schemaVersion: CONVERSATION_EVENT_SCHEMA_VERSION,
      sequence,
      emittedAt: new Date().toISOString(),
    });
    try {
      void Promise.resolve(observer.onEvent(event)).catch(() => undefined);
    } catch {
      // An event observer must not become a new execution or decision boundary.
    }
  };
}
