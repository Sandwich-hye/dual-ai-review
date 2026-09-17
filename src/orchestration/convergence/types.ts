export type ReviewSeverity = "HIGH" | "MEDIUM" | "LOW";
export type ObjectionStatus = "OPEN" | "RESOLVED" | "REJECTED";
export type ObjectionHistoryKind = "RAISED" | "REPEATED" | "PARAPHRASED" | "RESOLVED" | "REJECTED" | "REOPENED" | "IMPLICITLY_CARRIED_OPEN" | "SEVERITY_CHANGED" | "SEVERITY_DOWNGRADE_REJECTED" | "DUPLICATE_COLLAPSED";
export interface ObjectionHistoryEvent { round: number; kind: ObjectionHistoryKind; detail?: string }
export interface ObjectionLedgerEntry { id: string; severity: ReviewSeverity; highestSeveritySeen: ReviewSeverity; summary: string; reason: string; status: ObjectionStatus; firstSeenRound: number; lastSeenRound: number; normalizedFingerprint: string[]; history: ObjectionHistoryEvent[] }
export interface StructuredClaudeReview { reviewStatus: "CONTINUE" | "CANDIDATE_CONVERGED"; resolvedObjectionIds: string[]; resolutionEvidence: Record<string,string>; stillOpenObjections: {id:string; severityOverride?:ReviewSeverity}[]; reopenedObjections: {id:string; note:string; severityOverride?:ReviewSeverity}[]; newObjections: {severity:ReviewSeverity;summary:string;reason:string}[]; reviewNotes?: string; rawText: string }
export interface InvalidReview { invalid: true; reason: string; rawText: string }
export interface ConvergenceOptions { maxRounds:number; stabilityWindowRounds:number; fingerprintMergeThreshold:number; fingerprintAmbiguityMargin:number; fingerprintMinSharedTokens:number; fingerprintCandidateThreshold:number }
export const DEFAULT_CONVERGENCE_OPTIONS: ConvergenceOptions={maxRounds:10,stabilityWindowRounds:2,fingerprintMergeThreshold:.85,fingerprintAmbiguityMargin:.15,fingerprintMinSharedTokens:3,fingerprintCandidateThreshold:.6};
export interface ObjectionLedger { entries: ObjectionLedgerEntry[]; nextId:number }
export interface LedgerCounts { openHighCount:number; openMediumCount:number; openLowCount:number }
export type ConvergenceDecisionKind="CONTINUE"|"CONVERGED"|"MAX_ROUNDS_REACHED"|"INVALID_REVIEW";
export interface ConvergenceDecision { kind:ConvergenceDecisionKind; round:number; reason:string; cleanStreak:number; openHighCount:number; openMediumCount:number; openLowCount:number }
export interface ConvergenceHistory { rounds:{round:number;decision:ConvergenceDecision;ledgerSnapshot:ObjectionLedgerEntry[]}[] }
export interface ConvergenceState { ledger:ObjectionLedger; cleanStreak:number; history:ConvergenceHistory }
export interface ConvergenceRoundRecord { roundNumber:number; claudeReviewPrompt:string; claudeReviewRawResponse:string; claudeStructuredReview:StructuredClaudeReview|null; decision:ConvergenceDecision; claudeStartedAt:string; claudeCompletedAt:string; chatgptRevisionPrompt?:string; chatgptRevisionResponse?:string; chatgptStartedAt?:string; chatgptCompletedAt?:string }
export interface ConvergedReviewResult { originalTask:string; maxRounds:number; stopReason:"CONVERGED"|"MAX_ROUNDS_REACHED"|"INVALID_REVIEW"; finalAnswer:string; initial:{prompt:string;response:string;startedAt:string;completedAt:string}; rounds:ConvergenceRoundRecord[]; ledger:ObjectionLedgerEntry[]; convergenceHistory:ConvergenceHistory; invalidReview?:{round:number;rawText:string;reason:string} }
