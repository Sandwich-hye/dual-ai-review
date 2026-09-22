import type { ClaimLedgerEntry } from "./types";
import type {
  ClaimReviewInput,
  NewClaimInput,
  ReopenedClaimInput,
  StillOpenClaimInput,
} from "./claimLedger";

const BEGIN = "BEGIN_STRUCTURED_REVIEW";
const END = "END_STRUCTURED_REVIEW";
const CLAIM_ID = /^CLAIM-\d+$/;
const SEVERITIES = new Set(["HIGH", "MEDIUM", "LOW"] as const);

export interface ClaimReviewParseContext {
  knownEntries?: ClaimLedgerEntry[];
  round?: number;
}

export interface StructuredClaimReview extends ClaimReviewInput {
  reviewStatus: "CONTINUE" | "CANDIDATE_CONVERGED";
  reviewNotes?: string;
  rawText: string;
}

export interface InvalidClaimReview {
  invalid: true;
  reason: string;
  rawText: string;
}

const invalid = (rawText: string, reason: string): InvalidClaimReview => ({ invalid: true, reason, rawText });
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const extraField = (value: Record<string, unknown>, allowed: string[]): string | undefined => Object.keys(value).find((key) => !allowed.includes(key));
const isClaimId = (value: unknown): value is string => typeof value === "string" && CLAIM_ID.test(value);
const isSeverity = (value: unknown): value is NewClaimInput["severity"] => typeof value === "string" && SEVERITIES.has(value as NewClaimInput["severity"]);
const duplicateId = (ids: string[]): string | undefined => ids.find((id, index) => ids.indexOf(id) !== index);

export function parseStructuredClaimReview(
  rawText: string,
  context: ClaimReviewParseContext = {},
): StructuredClaimReview | InvalidClaimReview {
  const lines = rawText.split(/\r?\n/);
  const begins = lines.map((line, index) => (line.trim() === BEGIN ? index : -1)).filter((index) => index >= 0);
  const ends = lines.map((line, index) => (line.trim() === END ? index : -1)).filter((index) => index >= 0);
  if (begins.length !== 1 || ends.length !== 1 || begins[0] >= ends[0]) {
    return invalid(rawText, "missing or duplicated structured-review delimiters");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(lines.slice(begins[0] + 1, ends[0]).join("\n"));
  } catch (error) {
    return invalid(rawText, "structured claim review body is not valid JSON: " + (error instanceof Error ? error.message : String(error)));
  }
  if (!object(parsed)) return invalid(rawText, "structured claim review body must be a JSON object");

  const required = ["reviewStatus", "resolvedClaimIds", "stillOpenClaims", "reopenedClaims", "newClaims"];
  const unknown = extraField(parsed, [...required, "resolutionEvidence", "reviewNotes"]);
  if (unknown) return invalid(rawText, "unknown field " + unknown);
  for (const key of required) if (!(key in parsed)) return invalid(rawText, "missing field " + key);
  if (!("resolutionEvidence" in parsed)) return invalid(rawText, "missing field resolutionEvidence");
  if (parsed.reviewStatus !== "CONTINUE" && parsed.reviewStatus !== "CANDIDATE_CONVERGED") return invalid(rawText, "invalid reviewStatus");

  if (!Array.isArray(parsed.resolvedClaimIds)) return invalid(rawText, "resolvedClaimIds must be an array");
  const resolvedClaimIds: string[] = [];
  for (let index = 0; index < parsed.resolvedClaimIds.length; index++) {
    const value = parsed.resolvedClaimIds[index];
    if (!isClaimId(value)) return invalid(rawText, `resolvedClaimIds[${index}] must match /^CLAIM-\\d+$/`);
    resolvedClaimIds.push(value);
  }
  const resolvedDuplicate = duplicateId(resolvedClaimIds);
  if (resolvedDuplicate) return invalid(rawText, `duplicate claim id ${resolvedDuplicate} within resolvedClaimIds`);

  if (!object(parsed.resolutionEvidence)) return invalid(rawText, "resolutionEvidence must be an object");
  const resolutionEvidence: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.resolutionEvidence)) {
    if (!isClaimId(key) || typeof value !== "string" || !value.trim()) return invalid(rawText, "resolutionEvidence values must be non-empty");
    resolutionEvidence[key] = value;
  }
  for (const id of resolvedClaimIds) if (!resolutionEvidence[id]) return invalid(rawText, "missing resolution evidence for " + id);
  for (const id of Object.keys(resolutionEvidence)) {
    if (!resolvedClaimIds.includes(id)) return invalid(rawText, "resolution evidence provided for unresolved claim " + id);
  }

  if (!Array.isArray(parsed.stillOpenClaims)) return invalid(rawText, "stillOpenClaims must be an array");
  const stillOpenClaims: StillOpenClaimInput[] = [];
  for (let index = 0; index < parsed.stillOpenClaims.length; index++) {
    const value = parsed.stillOpenClaims[index];
    if (!object(value)) return invalid(rawText, `stillOpenClaims[${index}] must be an object`);
    const extra = extraField(value, ["id", "severityOverride"]);
    if (extra) return invalid(rawText, `stillOpenClaims[${index}].${extra} is not allowed`);
    if (!isClaimId(value.id)) return invalid(rawText, `stillOpenClaims[${index}].id is invalid`);
    if (value.severityOverride !== undefined && !isSeverity(value.severityOverride)) return invalid(rawText, `stillOpenClaims[${index}].severityOverride is invalid`);
    stillOpenClaims.push({ id: value.id, ...(value.severityOverride === undefined ? {} : { severityOverride: value.severityOverride }) });
  }
  const stillOpenDuplicate = duplicateId(stillOpenClaims.map((value) => value.id));
  if (stillOpenDuplicate) return invalid(rawText, `duplicate claim id ${stillOpenDuplicate} within stillOpenClaims`);

  if (!Array.isArray(parsed.reopenedClaims)) return invalid(rawText, "reopenedClaims must be an array");
  const reopenedClaims: ReopenedClaimInput[] = [];
  for (let index = 0; index < parsed.reopenedClaims.length; index++) {
    const value = parsed.reopenedClaims[index];
    if (!object(value)) return invalid(rawText, `reopenedClaims[${index}] must be an object`);
    const extra = extraField(value, ["id", "note", "severityOverride"]);
    if (extra) return invalid(rawText, `reopenedClaims[${index}].${extra} is not allowed`);
    if (!isClaimId(value.id) || typeof value.note !== "string" || !value.note.trim()) return invalid(rawText, `reopenedClaims[${index}] is invalid`);
    if (value.severityOverride !== undefined && !isSeverity(value.severityOverride)) return invalid(rawText, `reopenedClaims[${index}].severityOverride is invalid`);
    reopenedClaims.push({ id: value.id, note: value.note, ...(value.severityOverride === undefined ? {} : { severityOverride: value.severityOverride }) });
  }
  const reopenedDuplicate = duplicateId(reopenedClaims.map((value) => value.id));
  if (reopenedDuplicate) return invalid(rawText, `duplicate claim id ${reopenedDuplicate} within reopenedClaims`);

  if (!Array.isArray(parsed.newClaims)) return invalid(rawText, "newClaims must be an array");
  const newClaims: NewClaimInput[] = [];
  for (let index = 0; index < parsed.newClaims.length; index++) {
    const value = parsed.newClaims[index];
    if (!object(value)) return invalid(rawText, `newClaims[${index}] must be an object`);
    const extra = extraField(value, ["severity", "statement", "rationale"]);
    if (extra) return invalid(rawText, `newClaims[${index}].${extra} is not allowed`);
    if (!isSeverity(value.severity)) return invalid(rawText, `newClaims[${index}].severity must be HIGH, MEDIUM, or LOW`);
    if (typeof value.statement !== "string" || !value.statement.trim()) return invalid(rawText, `newClaims[${index}].statement must be non-empty`);
    if (typeof value.rationale !== "string" || !value.rationale.trim()) return invalid(rawText, `newClaims[${index}].rationale must be non-empty`);
    newClaims.push({ severity: value.severity, statement: value.statement, rationale: value.rationale });
  }
  if (parsed.reviewNotes !== undefined && typeof parsed.reviewNotes !== "string") return invalid(rawText, "reviewNotes must be a string");

  const buckets = new Map<string, string>();
  const checkBucket = (bucket: string, ids: string[]): InvalidClaimReview | undefined => {
    for (const id of ids) {
      const prior = buckets.get(id);
      if (prior) return invalid(rawText, `claim id ${id} appears in contradictory buckets: ${prior}, ${bucket}`);
      buckets.set(id, bucket);
    }
    return undefined;
  };
  const contradiction = checkBucket("resolvedClaimIds", resolvedClaimIds)
    ?? checkBucket("stillOpenClaims", stillOpenClaims.map((value) => value.id))
    ?? checkBucket("reopenedClaims", reopenedClaims.map((value) => value.id));
  if (contradiction) return contradiction;

  const known = new Map((context.knownEntries ?? []).map((entry) => [entry.id, entry]));
  if ((context.round ?? 1) === 1 && buckets.size > 0) return invalid(rawText, "claim id referenced before any ledger exists");
  for (const id of resolvedClaimIds) if (!known.has(id) || !["OPEN", "DISPUTED"].includes(known.get(id)!.status)) return invalid(rawText, "unknown or non-open claim id in resolvedClaimIds: " + id);
  for (const id of stillOpenClaims.map((value) => value.id)) if (!known.has(id) || !["OPEN", "DISPUTED"].includes(known.get(id)!.status)) return invalid(rawText, "unknown or non-open claim id in stillOpenClaims: " + id);
  for (const id of reopenedClaims.map((value) => value.id)) if (!known.has(id) || !["RESOLVED", "REJECTED"].includes(known.get(id)!.status)) return invalid(rawText, "unknown or non-reopenable claim id in reopenedClaims: " + id);

  return {
    reviewStatus: parsed.reviewStatus,
    resolvedClaimIds,
    resolutionEvidence,
    stillOpenClaims,
    reopenedClaims,
    newClaims,
    ...(parsed.reviewNotes === undefined ? {} : { reviewNotes: parsed.reviewNotes }),
    rawText,
  };
}

export const parseStructuredReview = parseStructuredClaimReview;
