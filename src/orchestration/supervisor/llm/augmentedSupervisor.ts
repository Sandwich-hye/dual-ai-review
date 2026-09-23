import type {
  Supervisor,
  SupervisorAssessment,
  SupervisorInput,
  SupervisorUnavailable,
  SupervisedReviewResult,
} from "../types";
import type { AugmentedSupervisedReviewResult } from "./contracts";
import type { LlmAuditSnapshot, LlmExecutionManager } from "./executionManager";
import { assembleAugmentedReviewResult } from "./integration";

export type LlmTriggerPolicy =
  | { kind: "on-deterministic-flag" }
  | { kind: "every-round" }
  | { kind: "every-n-rounds"; n: number };

export interface AugmentedSupervisorOptions {
  trigger?: LlmTriggerPolicy;
}

export interface AugmentedSupervisor extends Supervisor {
  finalizeAudit(timeoutMs?: number): Promise<LlmAuditSnapshot>;
  finalizeResult(supervised: SupervisedReviewResult, timeoutMs?: number): Promise<AugmentedSupervisedReviewResult>;
}

function shouldTrigger(
  policy: LlmTriggerPolicy,
  result: SupervisorAssessment | SupervisorUnavailable,
  input: SupervisorInput,
): boolean {
  switch (policy.kind) {
    case "on-deterministic-flag":
      return !("unavailable" in result) && (result.flags.length > 0 || result.escalationRecommended);
    case "every-round":
      return true;
    case "every-n-rounds": {
      const round = input.rounds.at(-1)?.roundNumber;
      return round !== undefined && Number.isSafeInteger(round) && round > 0 && round % policy.n === 0;
    }
  }
}

/** The only 6B-to-6A composition point. LLM work is audit-only and never awaited by assess(). */
export function createAugmentedSupervisor(
  deterministic: Supervisor,
  execution: LlmExecutionManager,
  options: AugmentedSupervisorOptions = {},
): AugmentedSupervisor {
  const trigger = options.trigger ?? { kind: "on-deterministic-flag" };
  if (trigger.kind !== "on-deterministic-flag" && trigger.kind !== "every-round" &&
      trigger.kind !== "every-n-rounds") {
    throw new RangeError("unknown LLM trigger policy");
  }
  if (trigger.kind === "every-n-rounds" && (!Number.isSafeInteger(trigger.n) || trigger.n < 1)) {
    throw new RangeError("every-n-rounds requires a positive integer n");
  }

  return {
    async assess(input) {
      const result = await deterministic.assess(input);
      // The returned object is fixed before any LLM dispatch. All side-channel errors stay here.
      try {
        if (shouldTrigger(trigger, result, input)) execution.dispatch(input);
      } catch {
        try {
          let round = 0;
          try { round = input.rounds.at(-1)?.roundNumber ?? 0; } catch { /* retain unknown round */ }
          execution.recordSkippedDispatch(round, "llm trigger evaluation or dispatch failed");
        } catch { /* LLM audit failure must not affect the deterministic result. */ }
      }
      return result;
    },
    finalizeAudit: (timeoutMs) => execution.finalizeAudit(timeoutMs),
    async finalizeResult(supervised, timeoutMs) {
      const snapshot = await execution.finalizeAudit(timeoutMs);
      return assembleAugmentedReviewResult(supervised, snapshot);
    },
  };
}
