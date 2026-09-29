import type { HumanGate } from "../orchestration/humanGate/humanGate";
import type { HumanGatePresentation, HumanGateRawResponse } from "../orchestration/claims/types";
import {
  runAuditedReviewLoop,
  type AuditedReviewLoopInput,
  type AuditedReviewLoopSite,
} from "../orchestration/runAuditedReviewLoop";
import type { ConversationalSiteAdapter } from "../sites/siteTypes";
import { createDeterministicSupervisor } from "../orchestration/supervisor/deterministicSupervisor";
import { createSupervisedHumanGate } from "../orchestration/supervisor/supervisedHumanGate";
import {
  SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION,
  type Supervisor,
  type SupervisedReviewResult,
} from "../orchestration/supervisor/types";
import {
  CONVERSATION_SCHEMA_VERSION,
  type ConversationLifecycleMetadata,
  type ConversationState,
  type JevConvergenceSignal,
  toJevConvergenceSignal,
} from "./conversationState";
import {
  createConversationEventEmitter,
  type ConversationEventData,
  type ConversationEventObserver,
} from "./conversationEvents";

export interface DualAiConversationInput extends AuditedReviewLoopInput {
  /** Optional observation only; it cannot change a review decision. */
  onStateChange?: (state: ConversationState) => void | Promise<void>;
  /** Optional event stream; return values and failures never control the review. */
  eventObserver?: ConversationEventObserver;
}

export interface DualAiConversationResult {
  schemaVersion: typeof CONVERSATION_SCHEMA_VERSION;
  /** Exactly the existing supervised-review result shape. */
  review: SupervisedReviewResult;
  lifecycle: ConversationLifecycleMetadata;
}

function notify(callback: DualAiConversationInput["onStateChange"], state: ConversationState): void {
  if (!callback) return;
  try {
    // A UI observer may be asynchronous, but cannot delay or reject the review.
    void Promise.resolve(callback(state)).catch(() => undefined);
  } catch {
    // Rendering/observer failure is not a decision failure.
  }
}

function observingHumanGate(
  inner: HumanGate,
  task: string,
  onStateChange: DualAiConversationInput["onStateChange"],
  getLatestJevSignal: () => JevConvergenceSignal | undefined,
  emit: (event: ConversationEventData) => void,
): HumanGate {
  return {
    async presentAndAwaitDecision(presentation: HumanGatePresentation): Promise<HumanGateRawResponse> {
      const latestJevSignal = getLatestJevSignal();
      const shared: Omit<Extract<ConversationState, { status: "awaiting_human" }>, "status"> = {
        schemaVersion: CONVERSATION_SCHEMA_VERSION,
        task,
        round: presentation.round,
        roundsCompleted: presentation.round - 1,
        currentAnswer: presentation.currentAnswer,
        recommendationKind: presentation.recommendation.kind,
        legalOutcomes: Object.freeze([...presentation.legalOutcomes]),
        ...(latestJevSignal === undefined ? {} : { latestJevSignal }),
      };
      emit({ type: "human_gate_waiting", round: presentation.round, recommendationKind: presentation.recommendation.kind });
      notify(onStateChange, Object.freeze({ ...shared, status: "awaiting_human" as const }));
      // Delegate exactly once. A real Human Gate rejection still propagates unchanged.
      const response = await inner.presentAndAwaitDecision(presentation);
      notify(onStateChange, Object.freeze({
        ...shared,
        status: "human_decision_submitted" as const,
        humanRequestedOutcome: response.requestedOutcome,
      }));
      return response;
    },
  };
}

/** Observe adapter boundaries without changing the Page, method order, or return values. */
function observingSite(
  site: AuditedReviewLoopSite,
  onReady: (() => void) | undefined,
  onResponse: (response: string) => void,
): AuditedReviewLoopSite {
  const original = site.adapter;
  const adapter: ConversationalSiteAdapter = {
    name: original.name,
    url: original.url,
    async checkReady(page) {
      const status = await original.checkReady(page);
      if (status === "ready") onReady?.();
      return status;
    },
    captureTurnBaseline: (page) => original.captureTurnBaseline(page),
    sendPrompt: (page, prompt) => original.sendPrompt(page, prompt),
    waitForGenerationStart: (page, baseline, options) => original.waitForGenerationStart(page, baseline, options),
    waitForGenerationComplete: (page, baseline, timeoutMs) => original.waitForGenerationComplete(page, baseline, timeoutMs),
    async getLatestAssistantResponse(page, baseline) {
      const response = await original.getLatestAssistantResponse(page, baseline);
      onResponse(response);
      return response;
    },
  };
  return { ...site, adapter };
}

/** Compose the existing deterministic supervisor and audited loop; own no review decisions. */
export async function runDualAiConversation(input: DualAiConversationInput): Promise<DualAiConversationResult> {
  const { onStateChange, eventObserver, humanGate, ...loopInput } = input;
  const emit = createConversationEventEmitter(eventObserver);
  const startedAt = new Date().toISOString();
  emit({ type: "conversation_started", task: input.originalTask });
  let currentRound = 0;
  const generator = observingSite(loopInput.chatgpt, undefined, (response) => {
    emit({ type: "generator_completed", round: currentRound, responseLength: response.length });
  });
  const reviewer = observingSite(loopInput.claude, () => {
    currentRound += 1;
    emit({ type: "round_started", round: currentRound });
  }, (response) => {
    emit({ type: "reviewer_completed", round: currentRound, responseLength: response.length });
  });
  let latestJevSignal: JevConvergenceSignal | undefined;
  const deterministicSupervisor = createDeterministicSupervisor();
  const observingSupervisor: Supervisor = {
    async assess(supervisorInput) {
      latestJevSignal = undefined;
      const assessment = await deterministicSupervisor.assess(supervisorInput);
      try {
        latestJevSignal = toJevConvergenceSignal(assessment);
        emit({ type: "jev_advisory_generated", round: assessment.round, signal: latestJevSignal });
      }
      catch { /* A projection failure cannot alter the assessment returned to the gate. */ }
      return assessment;
    },
  };
  const supervisedGate = createSupervisedHumanGate(
    observingHumanGate(humanGate, input.originalTask, onStateChange, () => latestJevSignal, emit),
    observingSupervisor,
    {
      invalidReviewRejectThreshold: input.options?.invalidReviewRejectThreshold ?? 3,
      reopenRejectThreshold: input.options?.reopenRejectThreshold ?? 3,
    },
  );
  const base = await runAuditedReviewLoop({
    ...loopInput,
    chatgpt: generator,
    claude: reviewer,
    humanGate: supervisedGate,
  });
  const review: SupervisedReviewResult = {
    schemaVersion: SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION,
    base,
    supervisorAssessments: supervisedGate.getAccumulatedAssessments(),
  };
  const completedAt = new Date().toISOString();
  const lifecycle: ConversationLifecycleMetadata = {
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    startedAt,
    completedAt,
    roundsCompleted: base.rounds.length,
    terminalOutcome: base.outcome,
  };
  emit({
    type: "conversation_completed",
    roundsCompleted: base.rounds.length,
    outcome: base.outcome,
    outcomeOrigin: base.outcomeOrigin,
  });
  notify(onStateChange, Object.freeze({
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    status: "complete" as const,
    task: input.originalTask,
    round: base.rounds.length,
    roundsCompleted: base.rounds.length,
    terminalOutcome: base.outcome,
    outcomeOrigin: base.outcomeOrigin,
    ...(latestJevSignal === undefined ? {} : { latestJevSignal }),
  }));
  return { schemaVersion: CONVERSATION_SCHEMA_VERSION, review, lifecycle };
}
