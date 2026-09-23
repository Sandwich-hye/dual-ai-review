import type {
  Supervisor,
  SupervisorInput,
  SupervisedReviewResult,
  SupervisorAssessment,
  SupervisorRecommendationSignal,
  SupervisorUnavailable,
} from "../types";

/** 6B contracts are additive; the deterministic 6A types remain the authority. */
export type LlmSupervisorAssessment = SupervisorAssessment;
export type LlmSupervisorResolvedOutcome = SupervisorAssessment | SupervisorUnavailable;

/** LLM adapter evidence travels beside the unchanged 6A Supervisor outcome. */
export type LlmSupervisorAdapterObservation =
  | {
      outcome: SupervisorAssessment;
      prompt: string;
      rawResponse: string;
      groundedSignals: SupervisorRecommendationSignal[];
    }
  | {
      outcome: SupervisorUnavailable;
      prompt?: string;
      rawResponse?: string;
    };

export interface AuditableLlmSupervisor extends Supervisor {
  assessWithAudit(input: SupervisorInput): Promise<LlmSupervisorAdapterObservation>;
}

export const ISOLATION_ATTESTATION_MAX_AGE_DAYS = 30;

/** Dated operator confirmation of the separate, memory-disabled LLM profile. */
export interface LlmIsolationAttestation {
  isolationAttestedAt: string; // ISO date-time; the future config loader must validate freshness.
}

export const DEFAULT_LLM_FINALIZATION_TIMEOUT_MS = 60_000;
export const MAX_LLM_FINALIZATION_TIMEOUT_MS = 300_000;

/** Values are milliseconds; the future config loader must validate positive finite integers. */
export interface LlmTimeoutSettings {
  timeoutMs: number;
  finalizationTimeoutMs?: number;
}

export type LlmSupervisorSettlement =
  | {
      kind: "assessment";
      assessment: SupervisorAssessment;
      prompt?: string;
      rawResponse?: string;
      groundedSignals?: SupervisorRecommendationSignal[];
    }
  | {
      kind: "failure";
      source: "unavailable" | "rejected" | "invalid";
      reason: string;
      prompt?: string;
      rawResponse?: string;
    };

/** A logical timeout does not imply the underlying operation has settled. */
export type LlmSupervisorTimedOutcome =
  | LlmSupervisorSettlement
  | { kind: "timeout"; timeoutMs: number };

export type LlmSessionStatus =
  | { status: "not_configured" }
  | { status: "not_ready"; detail: string }
  | { status: "ready" }
  | { status: "degraded"; detail: string; sinceRound: number; triggeringRecordId: string };

export interface LlmSupervisorAssessmentRecord {
  id: string;
  round: number;
  status: "pending" | "resolved" | "unavailable" | "timed_out" | "skipped";
  dispatchedAt?: string;
  resolvedAt?: string;
  assessment?: SupervisorAssessment;
  groundedSignals?: SupervisorRecommendationSignal[];
  reason?: string;
  prompt?: string;
  rawResponse?: string;
  lateResolution?:
    | { kind: "success"; resolvedAt: string; assessment?: SupervisorAssessment }
    | { kind: "failure"; resolvedAt: string; reason: string };
  finalizationIncomplete?: { phase: "operation" | "recovery"; at: string };
}

export type LlmAuditFinalization =
  | { status: "complete"; finalizedAt: string }
  | {
      status: "incomplete";
      finalizedAt: string;
      activeRecordId: string;
      phase: "operation" | "recovery";
      reason: "finalization_deadline_exceeded";
    };

export const LLM_SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION = 2 as const;

/** Only an explicitly opted-in 6B run produces this result. */
export interface AugmentedSupervisedReviewResult extends SupervisedReviewResult {
  schemaVersion: typeof LLM_SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION;
  llmSupervisorAssessments: LlmSupervisorAssessmentRecord[];
  llmSessionStatus: LlmSessionStatus;
  llmAuditFinalization: LlmAuditFinalization;
}
