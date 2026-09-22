import { classifyFingerprint, fingerprintTokens } from "../convergence/fingerprint";
import type { ConvergenceOptions, ObjectionLedgerEntry } from "../convergence/types";
import {
  computeAdjustedSeverity,
  computeReopenSeverity,
  type ReviewSeverity,
} from "../shared/severityRules";
import type {
  ClaimHistoryEvent,
  ClaimLedgerEntry,
  ClaimStatus,
  Evidence,
  EvidenceKind,
  EvidenceSourceRole,
  EvidenceStrength,
} from "./types";

export interface ClaimLedger {
  entries: ClaimLedgerEntry[];
  evidenceLog: Evidence[];
  nextClaimId: number;
  nextEvidenceId: number;
}

export interface ClaimLedgerOptions
  extends Pick<
    ConvergenceOptions,
    | "fingerprintMergeThreshold"
    | "fingerprintAmbiguityMargin"
    | "fingerprintMinSharedTokens"
    | "fingerprintCandidateThreshold"
  > {
  disputedConfidenceBandLow: number;
  disputedConfidenceBandHigh: number;
}

export const DEFAULT_CLAIM_LEDGER_OPTIONS: ClaimLedgerOptions = {
  fingerprintMergeThreshold: 0.85,
  fingerprintAmbiguityMargin: 0.15,
  fingerprintMinSharedTokens: 3,
  fingerprintCandidateThreshold: 0.6,
  disputedConfidenceBandLow: 0.35,
  disputedConfidenceBandHigh: 0.65,
};

export interface NewClaimInput {
  severity: ReviewSeverity;
  statement: string;
  rationale: string;
}

export interface EvidenceInput {
  claimId: string;
  kind: EvidenceKind;
  strength: EvidenceStrength;
  sourceRole: EvidenceSourceRole;
  text: string;
  round: number;
  submittedAt: string;
  supersedesEvidenceId?: string;
}

export interface StillOpenClaimInput {
  id: string;
  severityOverride?: ReviewSeverity;
}

export interface ReopenedClaimInput {
  id: string;
  note: string;
  severityOverride?: ReviewSeverity;
}

export interface ClaimReviewInput {
  resolvedClaimIds?: string[];
  resolutionEvidence?: Record<string, string>;
  stillOpenClaims?: StillOpenClaimInput[];
  reopenedClaims?: ReopenedClaimInput[];
  newClaims?: NewClaimInput[];
}

export interface ClaimLedgerMutation {
  ledger: ClaimLedger;
  touchedClaimIds: string[];
  newClaimIds: string[];
  newEvidenceIds: string[];
}

export class InvalidClaimLedgerMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidClaimLedgerMutationError";
  }
}

const CONFIDENCE_PRIOR = 0.5;
const CONFIDENCE_STEP: Record<EvidenceStrength, number> = {
  STRONG: 0.2,
  MODERATE: 0.1,
  WEAK: 0.05,
};

export const createEmptyClaimLedger = (): ClaimLedger => ({
  entries: [],
  evidenceLog: [],
  nextClaimId: 1,
  nextEvidenceId: 1,
});

const cloneHistory = (history: ClaimHistoryEvent[]): ClaimHistoryEvent[] => history.map((event) => ({ ...event }));

const cloneEntry = (entry: ClaimLedgerEntry): ClaimLedgerEntry => ({
  ...entry,
  claim: { ...entry.claim },
  evidenceFor: [...entry.evidenceFor],
  evidenceAgainst: [...entry.evidenceAgainst],
  confidenceHistory: entry.confidenceHistory.map((event) => ({ ...event })),
  normalizedFingerprint: [...entry.normalizedFingerprint],
  history: cloneHistory(entry.history),
});

const cloneEvidence = (evidence: Evidence): Evidence => ({ ...evidence });

export const cloneClaimLedger = (ledger: ClaimLedger): ClaimLedger => ({
  entries: ledger.entries.map(cloneEntry),
  evidenceLog: ledger.evidenceLog.map(cloneEvidence),
  nextClaimId: ledger.nextClaimId,
  nextEvidenceId: ledger.nextEvidenceId,
});

const addHistory = (
  entry: ClaimLedgerEntry,
  round: number,
  kind: ClaimHistoryEvent["kind"],
  detail?: string,
  resolutionEvidenceRef?: string,
): void => {
  entry.history.push({
    round,
    kind,
    ...(detail === undefined ? {} : { detail }),
    ...(resolutionEvidenceRef === undefined ? {} : { resolutionEvidenceRef }),
  });
};

const statusForEvidence = (
  entry: ClaimLedgerEntry,
  currentStatus: ClaimStatus,
  options: ClaimLedgerOptions,
): ClaimStatus => {
  const disputed =
    entry.evidenceFor.length > 0 &&
    entry.evidenceAgainst.length > 0 &&
    entry.confidence >= options.disputedConfidenceBandLow &&
    entry.confidence <= options.disputedConfidenceBandHigh;

  if (disputed) return "DISPUTED";
  if (currentStatus === "DISPUTED") return "OPEN";
  return currentStatus;
};

const applyEvidence = (
  ledger: ClaimLedger,
  input: EvidenceInput,
  options: ClaimLedgerOptions,
): { evidence: Evidence; claim: ClaimLedgerEntry } => {
  const claim = ledger.entries.find((entry) => entry.id === input.claimId);
  if (!claim) throw new InvalidClaimLedgerMutationError(`unknown claim id: ${input.claimId}`);
  if (ledger.evidenceLog.some((evidence) => evidence.id === input.supersedesEvidenceId)) {
    // A superseded record is valid; this branch documents that the old record
    // remains untouched. No mutation is made to it.
  }

  const evidence: Evidence = {
    id: `EV-${ledger.nextEvidenceId++}`,
    claimId: input.claimId,
    kind: input.kind,
    strength: input.strength,
    sourceRole: input.sourceRole,
    text: input.text,
    round: input.round,
    submittedAt: input.submittedAt,
    ...(input.supersedesEvidenceId === undefined ? {} : { supersedesEvidenceId: input.supersedesEvidenceId }),
  };
  ledger.evidenceLog.push(evidence);

  const previousConfidence = claim.confidence;
  const direction = input.kind === "CHALLENGING" ? -1 : 1;
  const nextConfidence = Math.min(1, Math.max(0, previousConfidence + direction * CONFIDENCE_STEP[input.strength]));
  if (input.kind === "CHALLENGING") claim.evidenceAgainst.push(evidence.id);
  else claim.evidenceFor.push(evidence.id);

  claim.confidence = nextConfidence;
  claim.confidenceHistory.push({
    round: input.round,
    previousConfidence,
    newConfidence: nextConfidence,
    causeEvidenceId: evidence.id,
  });
  addHistory(claim, input.round, "EVIDENCE_ADDED", `${input.kind} evidence ${evidence.id}`);
  if (previousConfidence !== nextConfidence) {
    addHistory(claim, input.round, "CONFIDENCE_CHANGED", `${previousConfidence} -> ${nextConfidence}`);
  }

  const previousStatus = claim.status;
  const nextStatus = statusForEvidence(claim, previousStatus, options);
  if (nextStatus !== previousStatus) {
    claim.status = nextStatus;
    addHistory(claim, input.round, nextStatus === "DISPUTED" ? "DISPUTED" : "UNDISPUTED");
  }

  return { evidence, claim };
};

const asObjectionCandidates = (entries: ClaimLedgerEntry[]): ObjectionLedgerEntry[] =>
  entries.map((entry) => ({
    id: entry.id,
    severity: entry.severity,
    highestSeveritySeen: entry.highestSeveritySeen,
    summary: entry.claim.statement,
    reason: entry.claim.rationale,
    status: entry.status === "REJECTED" ? "REJECTED" : entry.status === "RESOLVED" ? "RESOLVED" : "OPEN",
    firstSeenRound: entry.firstSeenRound,
    lastSeenRound: entry.lastSeenRound,
    normalizedFingerprint: [...entry.normalizedFingerprint],
    history: [],
  }));

const findMatchingClaim = (
  input: NewClaimInput,
  entries: ClaimLedgerEntry[],
  options: ClaimLedgerOptions,
): { kind: "MERGE" | "NEW"; entry?: ClaimLedgerEntry; possibleDuplicate?: ClaimLedgerEntry } => {
  const result = classifyFingerprint(
    { summary: input.statement, reason: input.rationale },
    asObjectionCandidates(entries),
    options,
  );
  const entry = result.entry === undefined ? undefined : entries.find((candidate) => candidate.id === result.entry?.id);
  const possibleDuplicate = result.possibleDuplicate === undefined
    ? undefined
    : entries.find((candidate) => candidate.id === result.possibleDuplicate?.id);
  return { kind: result.kind, entry, possibleDuplicate };
};

const adjustSeverity = (entry: ClaimLedgerEntry, proposed: ReviewSeverity, round: number): void => {
  const result = computeAdjustedSeverity(entry.severity, entry.highestSeveritySeen, proposed);
  if (result.event === "UNCHANGED") return;
  const oldSeverity = entry.severity;
  entry.severity = result.newSeverity;
  entry.highestSeveritySeen = result.newHighestSeveritySeen;
  addHistory(
    entry,
    round,
    result.event === "ESCALATED" ? "SEVERITY_CHANGED" : "SEVERITY_DOWNGRADE_REJECTED",
    `${oldSeverity} -> ${proposed}`,
  );
};

const createClaim = (ledger: ClaimLedger, input: NewClaimInput, round: number): ClaimLedgerEntry => {
  const entry: ClaimLedgerEntry = {
    id: `CLAIM-${ledger.nextClaimId++}`,
    claim: { statement: input.statement, rationale: input.rationale },
    severity: input.severity,
    highestSeveritySeen: input.severity,
    confidence: CONFIDENCE_PRIOR,
    status: "OPEN",
    evidenceFor: [],
    evidenceAgainst: [],
    confidenceHistory: [],
    firstSeenRound: round,
    lastSeenRound: round,
    normalizedFingerprint: fingerprintTokens({ summary: input.statement, reason: input.rationale }),
    history: [],
  };
  addHistory(entry, round, "RAISED");
  ledger.entries.push(entry);
  return entry;
};

export const addClaim = (
  input: NewClaimInput,
  round: number,
  source: ClaimLedger = createEmptyClaimLedger(),
  options: ClaimLedgerOptions = DEFAULT_CLAIM_LEDGER_OPTIONS,
): ClaimLedgerMutation => {
  const ledger = cloneClaimLedger(source);
  const match = findMatchingClaim(input, ledger.entries, options);
  if (match.kind === "MERGE" && match.entry) {
    const entry = match.entry;
    const previousStatus = entry.status;
    const previousWording = `${entry.claim.statement} | ${entry.claim.rationale}`;
    entry.claim = { statement: input.statement, rationale: input.rationale };
    entry.normalizedFingerprint = fingerprintTokens({ summary: input.statement, reason: input.rationale });
    entry.lastSeenRound = round;
    if (previousStatus === "OPEN" || previousStatus === "DISPUTED") {
      addHistory(entry, round, "PARAPHRASED", previousWording);
      adjustSeverity(entry, input.severity, round);
    } else {
      entry.status = "OPEN";
      const reopen = computeReopenSeverity(entry.severity, entry.highestSeveritySeen, input.severity);
      const oldSeverity = entry.severity;
      entry.severity = reopen.newSeverity;
      entry.highestSeveritySeen = reopen.newHighestSeveritySeen;
      if (oldSeverity !== entry.severity) addHistory(entry, round, "SEVERITY_CHANGED", `${oldSeverity} -> ${entry.severity} (reopen floor)`);
      addHistory(entry, round, "REOPENED", "fingerprint-derived reopen");
    }
    return { ledger, touchedClaimIds: [entry.id], newClaimIds: [], newEvidenceIds: [] };
  }

  const entry = createClaim(ledger, input, round);
  if (match.possibleDuplicate) addHistory(entry, round, "RAISED", `possible duplicate of ${match.possibleDuplicate.id}`);
  return { ledger, touchedClaimIds: [entry.id], newClaimIds: [entry.id], newEvidenceIds: [] };
};

export const attachEvidence = (
  source: ClaimLedger,
  input: EvidenceInput,
  options: ClaimLedgerOptions = DEFAULT_CLAIM_LEDGER_OPTIONS,
): ClaimLedgerMutation => {
  const ledger = cloneClaimLedger(source);
  const { evidence, claim } = applyEvidence(ledger, input, options);
  return { ledger, touchedClaimIds: [claim.id], newClaimIds: [], newEvidenceIds: [evidence.id] };
};

export const resolveClaim = (
  source: ClaimLedger,
  claimId: string,
  resolutionText: string,
  round: number,
  options: ClaimLedgerOptions = DEFAULT_CLAIM_LEDGER_OPTIONS,
  rejected = false,
): ClaimLedgerMutation => {
  const ledger = cloneClaimLedger(source);
  const claim = ledger.entries.find((entry) => entry.id === claimId);
  if (!claim) throw new InvalidClaimLedgerMutationError(`unknown claim id: ${claimId}`);
  if (claim.status !== "OPEN" && claim.status !== "DISPUTED") {
    throw new InvalidClaimLedgerMutationError(`claim is not open or disputed: ${claimId}`);
  }

  const applied = applyEvidence(ledger, {
    claimId,
    kind: "RESOLUTION",
    strength: "STRONG",
    sourceRole: "REVIEWER",
    text: resolutionText,
    round,
    submittedAt: new Date(0).toISOString(),
  }, options);
  const nextStatus: ClaimStatus = rejected ? "REJECTED" : "RESOLVED";
  claim.status = nextStatus;
  addHistory(claim, round, nextStatus, resolutionText, applied.evidence.id);
  return { ledger, touchedClaimIds: [claimId], newClaimIds: [], newEvidenceIds: [applied.evidence.id] };
};

export const reopenClaim = (
  source: ClaimLedger,
  input: ReopenedClaimInput,
  round: number,
  options: ClaimLedgerOptions = DEFAULT_CLAIM_LEDGER_OPTIONS,
): ClaimLedgerMutation => {
  const ledger = cloneClaimLedger(source);
  const claim = ledger.entries.find((entry) => entry.id === input.id);
  if (!claim || (claim.status !== "RESOLVED" && claim.status !== "REJECTED")) {
    throw new InvalidClaimLedgerMutationError(`claim is not reopenable: ${input.id}`);
  }
  const oldSeverity = claim.severity;
  const severity = computeReopenSeverity(claim.severity, claim.highestSeveritySeen, input.severityOverride);
  claim.status = "OPEN";
  claim.severity = severity.newSeverity;
  claim.highestSeveritySeen = severity.newHighestSeveritySeen;
  if (oldSeverity !== claim.severity) addHistory(claim, round, "SEVERITY_CHANGED", `${oldSeverity} -> ${claim.severity} (reopen floor)`);
  const applied = applyEvidence(ledger, {
    claimId: input.id,
    kind: "CHALLENGING",
    strength: "STRONG",
    sourceRole: "REVIEWER",
    text: input.note,
    round,
    submittedAt: new Date(0).toISOString(),
  }, options);
  addHistory(claim, round, "REOPENED", input.note);
  claim.lastSeenRound = round;
  return { ledger, touchedClaimIds: [claim.id], newClaimIds: [], newEvidenceIds: [applied.evidence.id] };
};

export const ingestClaimReview = (
  source: ClaimLedger,
  review: ClaimReviewInput,
  round: number,
  options: ClaimLedgerOptions = DEFAULT_CLAIM_LEDGER_OPTIONS,
): ClaimLedgerMutation => {
  let current = cloneClaimLedger(source);
  const touched = new Set<string>();
  const newClaims: string[] = [];
  const newEvidence: string[] = [];

  for (const input of review.newClaims ?? []) {
    const result = addClaim(input, round, current, options);
    current = result.ledger;
    result.touchedClaimIds.forEach((id) => touched.add(id));
    newClaims.push(...result.newClaimIds);
  }
  for (const item of review.stillOpenClaims ?? []) {
    const ledger = cloneClaimLedger(current);
    const claim = ledger.entries.find((entry) => entry.id === item.id);
    if (!claim || (claim.status !== "OPEN" && claim.status !== "DISPUTED")) throw new InvalidClaimLedgerMutationError(`unknown or non-open claim id: ${item.id}`);
    claim.lastSeenRound = round;
    addHistory(claim, round, "REPEATED");
    if (item.severityOverride) adjustSeverity(claim, item.severityOverride, round);
    current = ledger;
    touched.add(item.id);
  }
  for (const item of review.resolvedClaimIds ?? []) {
    const result = resolveClaim(current, item, review.resolutionEvidence?.[item] ?? "Resolved by reviewer.", round, options);
    current = result.ledger;
    touched.add(item);
    newEvidence.push(...result.newEvidenceIds);
  }
  for (const item of review.reopenedClaims ?? []) {
    const result = reopenClaim(current, item, round, options);
    current = result.ledger;
    touched.add(item.id);
    newEvidence.push(...result.newEvidenceIds);
  }
  for (const claim of current.entries) {
    if (claim.status === "OPEN" && !touched.has(claim.id)) {
      const ledger = cloneClaimLedger(current);
      const carried = ledger.entries.find((entry) => entry.id === claim.id)!;
      carried.lastSeenRound = round;
      addHistory(carried, round, "IMPLICITLY_CARRIED_OPEN");
      current = ledger;
    }
  }
  return { ledger: current, touchedClaimIds: [...touched], newClaimIds: newClaims, newEvidenceIds: newEvidence };
};

export const ingestClaims = ingestClaimReview;
