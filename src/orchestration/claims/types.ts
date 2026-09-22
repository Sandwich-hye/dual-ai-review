export const AUDITED_REVIEW_SCHEMA_VERSION = 1;
export const AUDITED_ROUND_SCHEMA_VERSION = 1;
export const CLAIM_LEDGER_SNAPSHOT_SCHEMA_VERSION = 1;
export const HUMAN_DECISION_RECORD_SCHEMA_VERSION = 1;

export type ReviewSeverity = "HIGH" | "MEDIUM" | "LOW";
export type ClaimStatus = "OPEN" | "DISPUTED" | "RESOLVED" | "REJECTED";
export type EvidenceKind = "SUPPORTING" | "CHALLENGING" | "RESOLUTION";
export type EvidenceStrength = "STRONG" | "MODERATE" | "WEAK";
export type EvidenceSourceRole = "GENERATOR" | "REVIEWER" | "EVIDENCE_AGENT" | "HUMAN";

export type EvidenceRef = string;

export interface Evidence {
  id: string;
  claimId: string;
  kind: EvidenceKind;
  strength: EvidenceStrength;
  sourceRole: EvidenceSourceRole;
  text: string;
  round: number;
  submittedAt: string;
  supersedesEvidenceId?: EvidenceRef;
}

export interface ConfidenceChangeEvent {
  round: number;
  previousConfidence: number;
  newConfidence: number;
  causeEvidenceId: EvidenceRef;
}

export type ConfidenceHistory = ConfidenceChangeEvent[];

export type ClaimHistoryEventKind =
  | "RAISED"
  | "REPEATED"
  | "PARAPHRASED"
  | "RESOLVED"
  | "REJECTED"
  | "REOPENED"
  | "IMPLICITLY_CARRIED_OPEN"
  | "SEVERITY_CHANGED"
  | "SEVERITY_DOWNGRADE_REJECTED"
  | "DUPLICATE_COLLAPSED"
  | "EVIDENCE_ADDED"
  | "CONFIDENCE_CHANGED"
  | "DISPUTED"
  | "UNDISPUTED";

export interface ClaimHistoryEvent {
  round: number;
  kind: ClaimHistoryEventKind;
  detail?: string;
  resolutionEvidenceRef?: EvidenceRef;
}

export interface ClaimLedgerEntry {
  id: string;
  claim: {
    statement: string;
    rationale: string;
  };
  severity: ReviewSeverity;
  highestSeveritySeen: ReviewSeverity;
  confidence: number;
  status: ClaimStatus;
  evidenceFor: EvidenceRef[];
  evidenceAgainst: EvidenceRef[];
  confidenceHistory: ConfidenceHistory;
  firstSeenRound: number;
  lastSeenRound: number;
  normalizedFingerprint: string[];
  history: ClaimHistoryEvent[];
}

export interface ClaimLedgerSnapshot {
  schemaVersion: number;
  round: number;
  entries: ClaimLedgerEntry[];
}

export type DecisionBranch =
  | "HARD_MAX_ROUNDS_REACHED"
  | "CHRONIC_CLAIM"
  | "INVALID_REVIEW_STREAK"
  | "INVALID_REVIEW_SINGLE"
  | "SOFT_BUDGET_EXCEEDED"
  | "CLEAN_ACCEPT"
  | "DEFAULT_CONTINUE";

export interface DecisionRecommendation {
  kind: "CONTINUE_RECOMMENDED" | "ACCEPT_RECOMMENDED" | "REJECT_RECOMMENDED";
  triggeredBranch: DecisionBranch;
  round: number;
  reason: string;
  cleanStreak: number;
  openHighCount: number;
  openMediumCount: number;
  disputedCount: number;
  averageConfidence: number;
  lowConfidenceResolutionCount: number;
  invalidReviewStreak: number;
  invalidReview?: {
    reason: string;
  };
}

export type HumanGateOutcome = "CONTINUE" | "ACCEPT" | "REJECT";
export type RecommendationAgreement = "AGREED" | "OVERRODE";

export interface HumanGatePresentation {
  round: number;
  currentAnswer: string;
  recommendation: DecisionRecommendation;
  disputedClaims: ClaimLedgerEntry[];
  claimLedgerDelta: ClaimLedgerEntry[];
  relevantEvidence: Evidence[];
  legalOutcomes: HumanGateOutcome[];
}

export interface HumanGateRawResponse {
  requestedOutcome: HumanGateOutcome;
  rationale?: string;
  decidedAt: string;
}

export interface HumanDecisionRecord {
  schemaVersion: number;
  raw: HumanGateRawResponse;
  outcome: HumanGateOutcome;
  recommendationAgreement: RecommendationAgreement;
  hardSafetyOverride?: {
    reason: string;
  };
}

export type RunAuditEventKind =
  | "HARD_MAX_ROUNDS_OVERRIDE"
  | "INVALID_REVIEW_ENCOUNTERED"
  | "INVALID_REVIEW_STREAK_THRESHOLD_REACHED"
  | "RECOMMENDATION_OVERRIDDEN_BY_HUMAN"
  | "HUMAN_EVIDENCE_ATTACHED";

export interface RunAuditEvent {
  round: number;
  kind: RunAuditEventKind;
  detail: string;
  recordedAt: string;
}

export interface AuditedRoundRecord {
  schemaVersion: number;
  roundNumber: number;
  reviewerPrompt: string;
  reviewerRawResponse: string;
  recommendation: DecisionRecommendation;
  ledgerSnapshot: ClaimLedgerEntry[];
  humanDecision: HumanDecisionRecord;
  humanSuppliedEvidence?: Evidence[];
  generatorPrompt?: string;
  generatorResponse?: string;
}

export type TerminalOutcomeOrigin =
  | "HUMAN_AGREED_WITH_RECOMMENDATION"
  | "HUMAN_OVERRODE_RECOMMENDATION"
  | "HARD_SAFETY_OVERRIDE";

export interface AuditedReviewResult {
  schemaVersion: number;
  originalTask: string;
  outcome: "ACCEPTED" | "REJECTED";
  outcomeOrigin: TerminalOutcomeOrigin;
  finalAnswer: string;
  initial: {
    prompt: string;
    response: string;
    startedAt: string;
    completedAt: string;
  };
  rounds: AuditedRoundRecord[];
  claimLedger: ClaimLedgerEntry[];
  evidenceLog: Evidence[];
  runAuditTrail: RunAuditEvent[];
  hardMaxRounds: number;
  recommendedMaxRounds: number;
  invalidReviewRejectThreshold: number;
}
