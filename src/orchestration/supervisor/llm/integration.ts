import type { SupervisedReviewResult } from "../types";
import { SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION } from "../types";
import type { AugmentedSupervisedReviewResult } from "./contracts";
import { LLM_SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION } from "./contracts";
import type { LlmAuditSnapshot } from "./executionManager";

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** Add a sealed 6B audit beside, never inside, the frozen 6A result fields. */
export function assembleAugmentedReviewResult(
  supervised: SupervisedReviewResult,
  llmAudit: LlmAuditSnapshot,
): AugmentedSupervisedReviewResult {
  if (supervised.schemaVersion !== SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION) {
    throw new Error("expected a Milestone 6A supervised result");
  }
  if (!Object.isFrozen(llmAudit)) {
    throw new Error("LLM audit must be finalized before result assembly");
  }
  const result: AugmentedSupervisedReviewResult = {
    schemaVersion: LLM_SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION,
    base: supervised.base,
    supervisorAssessments: supervised.supervisorAssessments,
    llmSupervisorAssessments: llmAudit.llmSupervisorAssessments,
    llmSessionStatus: llmAudit.llmSessionStatus,
    llmAuditFinalization: llmAudit.llmAuditFinalization,
  };
  return freezeDeep(JSON.parse(JSON.stringify(result)) as AugmentedSupervisedReviewResult);
}
