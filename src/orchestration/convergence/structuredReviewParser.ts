import type { InvalidReview, ObjectionLedgerEntry, ReviewSeverity, StructuredClaudeReview } from "./types";

const BEGIN = "BEGIN_STRUCTURED_REVIEW";
const END = "END_STRUCTURED_REVIEW";
const ID = /^OBJ-\d+$/;
const SEVERITIES = new Set<ReviewSeverity>(["HIGH", "MEDIUM", "LOW"]);
export interface ReviewParseContext { knownEntries?: ObjectionLedgerEntry[]; round?: number }
const invalid = (rawText: string, reason: string): InvalidReview => ({ invalid: true, reason, rawText });
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: string[]): string | undefined => Object.keys(value).find(key => !keys.includes(key));
const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const isSeverity = (value: unknown): value is ReviewSeverity => typeof value === "string" && SEVERITIES.has(value as ReviewSeverity);
const duplicateId = (ids: string[]): string | undefined => ids.find((id, index) => ids.indexOf(id) !== index);

export function parseStructuredReview(rawText: string, context: ReviewParseContext = {}): StructuredClaudeReview | InvalidReview {
  const lines = rawText.split(/\r?\n/);
  const begins = lines.map((line, index) => line.trim() === BEGIN ? index : -1).filter(index => index >= 0);
  const ends = lines.map((line, index) => line.trim() === END ? index : -1).filter(index => index >= 0);
  if (begins.length !== 1 || ends.length !== 1 || begins[0] >= ends[0]) return invalid(rawText, "missing or duplicated structured-review delimiters");
  let parsed: unknown;
  try { parsed = JSON.parse(lines.slice(begins[0] + 1, ends[0]).join("\n")); }
  catch (error) { return invalid(rawText, "structured review body is not valid JSON: " + (error instanceof Error ? error.message : String(error))); }
  if (!object(parsed)) return invalid(rawText, "structured review body must be a JSON object");

  const required = ["reviewStatus", "resolvedObjectionIds", "stillOpenObjections", "reopenedObjections", "newObjections"];
  const unknown = hasOnly(parsed, [...required, "resolutionEvidence", "reviewNotes"]);
  if (unknown) return invalid(rawText, "unknown field " + unknown);
  for (const key of required) if (!(key in parsed)) return invalid(rawText, "missing field " + key);
  if (!("resolutionEvidence" in parsed)) return invalid(rawText, "missing field resolutionEvidence");
  if (parsed.reviewStatus !== "CONTINUE" && parsed.reviewStatus !== "CANDIDATE_CONVERGED") return invalid(rawText, "invalid reviewStatus");

  if (!Array.isArray(parsed.resolvedObjectionIds)) return invalid(rawText, "resolvedObjectionIds must be an array");
  const resolved: string[] = [];
  for (let i = 0; i < parsed.resolvedObjectionIds.length; i++) { const value = parsed.resolvedObjectionIds[i]; if (!isId(value)) return invalid(rawText, `resolvedObjectionIds[${i}] must match /^OBJ-\\d+$/`); resolved.push(value); }
  const resolvedDuplicate = duplicateId(resolved); if (resolvedDuplicate) return invalid(rawText, `duplicate objection id ${resolvedDuplicate} within resolvedObjectionIds`);

  if (!object(parsed.resolutionEvidence)) return invalid(rawText, "resolutionEvidence must be an object");
  const evidence: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.resolutionEvidence)) { if (!isId(key) || typeof value !== "string" || !value.trim()) return invalid(rawText, "resolutionEvidence values must be non-empty"); evidence[key] = value; }
  for (const id of resolved) if (!evidence[id]) return invalid(rawText, "missing resolution evidence for " + id);
  for (const id of Object.keys(evidence)) if (!resolved.includes(id)) return invalid(rawText, "resolution evidence provided for unresolved objection " + id);

  if (!Array.isArray(parsed.stillOpenObjections)) return invalid(rawText, "stillOpenObjections must be an array");
  const stillOpen: { id: string; severityOverride?: ReviewSeverity }[] = [];
  for (let i = 0; i < parsed.stillOpenObjections.length; i++) { const value = parsed.stillOpenObjections[i]; if (!object(value)) return invalid(rawText, `stillOpenObjections[${i}] must be an object`); const extra = hasOnly(value, ["id", "severityOverride"]); if (extra) return invalid(rawText, `stillOpenObjections[${i}].${extra} is not allowed`); if (!isId(value.id)) return invalid(rawText, `stillOpenObjections[${i}].id is invalid`); if (value.severityOverride !== undefined && !isSeverity(value.severityOverride)) return invalid(rawText, `stillOpenObjections[${i}].severityOverride is invalid`); stillOpen.push({ id: value.id, ...(value.severityOverride === undefined ? {} : { severityOverride: value.severityOverride }) }); }
  const stillDuplicate = duplicateId(stillOpen.map(value => value.id)); if (stillDuplicate) return invalid(rawText, `duplicate objection id ${stillDuplicate} within stillOpenObjections`);

  if (!Array.isArray(parsed.reopenedObjections)) return invalid(rawText, "reopenedObjections must be an array");
  const reopened: { id: string; note: string; severityOverride?: ReviewSeverity }[] = [];
  for (let i = 0; i < parsed.reopenedObjections.length; i++) { const value = parsed.reopenedObjections[i]; if (!object(value)) return invalid(rawText, `reopenedObjections[${i}] must be an object`); const extra = hasOnly(value, ["id", "note", "severityOverride"]); if (extra) return invalid(rawText, `reopenedObjections[${i}].${extra} is not allowed`); if (!isId(value.id) || typeof value.note !== "string" || !value.note.trim()) return invalid(rawText, `reopenedObjections[${i}] is invalid`); if (value.severityOverride !== undefined && !isSeverity(value.severityOverride)) return invalid(rawText, `reopenedObjections[${i}].severityOverride is invalid`); reopened.push({ id: value.id, note: value.note, ...(value.severityOverride === undefined ? {} : { severityOverride: value.severityOverride }) }); }
  const reopenedDuplicate = duplicateId(reopened.map(value => value.id)); if (reopenedDuplicate) return invalid(rawText, `duplicate objection id ${reopenedDuplicate} within reopenedObjections`);

  if (!Array.isArray(parsed.newObjections)) return invalid(rawText, "newObjections must be an array");
  const newObjections: { severity: ReviewSeverity; summary: string; reason: string }[] = [];
  for (let i = 0; i < parsed.newObjections.length; i++) { const value = parsed.newObjections[i]; if (!object(value)) return invalid(rawText, `newObjections[${i}] must be an object`); const extra = hasOnly(value, ["severity", "summary", "reason"]); if (extra) return invalid(rawText, `newObjections[${i}].${extra} is not allowed`); if (!isSeverity(value.severity)) return invalid(rawText, `newObjections[${i}].severity must be HIGH, MEDIUM, or LOW`); if (typeof value.summary !== "string" || !value.summary.trim()) return invalid(rawText, `newObjections[${i}].summary must be non-empty`); if (typeof value.reason !== "string" || !value.reason.trim()) return invalid(rawText, `newObjections[${i}].reason must be non-empty`); newObjections.push({ severity: value.severity, summary: value.summary, reason: value.reason }); }
  if (parsed.reviewNotes !== undefined && typeof parsed.reviewNotes !== "string") return invalid(rawText, "reviewNotes must be a string");

  const buckets = new Map<string, string>();
  const checkBucket = (bucket: string, ids: string[]): InvalidReview | undefined => { for (const id of ids) { const prior = buckets.get(id); if (prior) return invalid(rawText, `objection id ${id} appears in contradictory buckets: ${prior}, ${bucket}`); buckets.set(id, bucket); } return undefined; };
  const contradiction = checkBucket("resolvedObjectionIds", resolved) ?? checkBucket("stillOpenObjections", stillOpen.map(value => value.id)) ?? checkBucket("reopenedObjections", reopened.map(value => value.id));
  if (contradiction) return contradiction;
  const known = new Map((context.knownEntries ?? []).map(entry => [entry.id, entry]));
  if ((context.round ?? 1) === 1 && buckets.size > 0) return invalid(rawText, "objection id referenced before any ledger exists");
  for (const id of resolved) if (!known.has(id) || known.get(id)!.status !== "OPEN") return invalid(rawText, "unknown or non-open objection id in resolvedObjectionIds: " + id);
  for (const id of stillOpen.map(value => value.id)) if (!known.has(id) || known.get(id)!.status !== "OPEN") return invalid(rawText, "unknown or non-open objection id in stillOpenObjections: " + id);
  for (const id of reopened.map(value => value.id)) if (!known.has(id) || !["RESOLVED", "REJECTED"].includes(known.get(id)!.status)) return invalid(rawText, "unknown or non-reopenable objection id in reopenedObjections: " + id);
  return { reviewStatus: parsed.reviewStatus, resolvedObjectionIds: resolved, resolutionEvidence: evidence, stillOpenObjections: stillOpen, reopenedObjections: reopened, newObjections, ...(parsed.reviewNotes === undefined ? {} : { reviewNotes: parsed.reviewNotes }), rawText };
}
