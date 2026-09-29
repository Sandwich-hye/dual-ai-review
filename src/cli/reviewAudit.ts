import type { AuditedReviewResult } from "../orchestration/claims/types";
import type { AuditedReviewLoopPartialResult, AuditedReviewLoopStage } from "../orchestration/runAuditedReviewLoop";
import type { ReviewProvider } from "./reviewInput";
import type { ReviewProvenance } from "./renderTerminalReport";

/** Version of the CLI envelope, independent of the nested audited-review schema. */
export const CLI_REVIEW_AUDIT_SCHEMA_VERSION = 2;

interface ReviewAuditBase {
  schemaVersion: typeof CLI_REVIEW_AUDIT_SCHEMA_VERSION;
  recordedAt: string;
  providerMode: ReviewProvider;
  providers: ReviewProvenance;
}

export interface CompleteReviewAudit extends ReviewAuditBase {
  status: "complete";
  review: AuditedReviewResult;
}

export interface FailedReviewAudit extends ReviewAuditBase {
  status: "failed";
  failure: { stage: AuditedReviewLoopStage; message: string };
  partialReview: AuditedReviewLoopPartialResult;
}

export type CliReviewAudit = CompleteReviewAudit | FailedReviewAudit;

function assertProvenance(providerMode: ReviewProvider, providers: ReviewProvenance): void {
  const expectedExecutionMode = providerMode === "ollama" ? "local_http" : "browser";
  for (const [role, provider] of Object.entries(providers)) {
    if (!provider.providerName.trim() || !provider.modelName.trim() || provider.executionMode !== expectedExecutionMode) {
      throw new Error(`${role} provider provenance does not match ${providerMode} mode`);
    }
  }
}

export function completeReviewAudit(
  providerMode: ReviewProvider,
  providers: ReviewProvenance,
  review: AuditedReviewResult,
): CompleteReviewAudit {
  assertProvenance(providerMode, providers);
  return {
    schemaVersion: CLI_REVIEW_AUDIT_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    status: "complete",
    providerMode,
    providers,
    review,
  };
}

export function failedReviewAudit(
  providerMode: ReviewProvider,
  providers: ReviewProvenance,
  failure: FailedReviewAudit["failure"],
  partialReview: AuditedReviewLoopPartialResult,
): FailedReviewAudit {
  assertProvenance(providerMode, providers);
  return {
    schemaVersion: CLI_REVIEW_AUDIT_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    status: "failed",
    providerMode,
    providers,
    failure,
    partialReview,
  };
}
