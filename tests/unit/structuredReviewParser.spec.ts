import { test, expect } from "@playwright/test";
import { parseStructuredReview } from "../../src/orchestration/convergence/structuredReviewParser";
import type { ObjectionLedgerEntry } from "../../src/orchestration/convergence/types";

const body = (value: object, before = "", after = "") => `${before}\nBEGIN_STRUCTURED_REVIEW\n${JSON.stringify(value, null, 2)}\nEND_STRUCTURED_REVIEW\n${after}`;
const valid = (extra: object = {}) => ({ reviewStatus: "CONTINUE", resolvedObjectionIds: [], resolutionEvidence: {}, stillOpenObjections: [], reopenedObjections: [], newObjections: [], ...extra });
const known: ObjectionLedgerEntry = { id: "OBJ-1", severity: "MEDIUM", highestSeveritySeen: "MEDIUM", summary: "x", reason: "x", status: "OPEN", firstSeenRound: 1, lastSeenRound: 1, normalizedFingerprint: ["x"], history: [] };

test("parses only the sentinel-wrapped strict JSON payload", () => {
  const result = parseStructuredReview(body(valid({ newObjections: [{ severity: "LOW", summary: "style", reason: "line one\nline two END_STRUCTURED_REVIEW" }] }), "preamble", "postamble"));
  expect("invalid" in result).toBe(false); if (!("invalid" in result)) expect(result.newObjections[0].reason).toContain("\n");
});
test("rejects malformed delimiters, syntax, missing fields, unknown fields, and nested extras", () => {
  expect(parseStructuredReview("BEGIN_STRUCTURED_REVIEW\n{}\nEND_STRUCTURED_REVIEW")).toMatchObject({ invalid: true });
  expect(parseStructuredReview("BEGIN_STRUCTURED_REVIEW\n{\nEND_STRUCTURED_REVIEW")).toMatchObject({ invalid: true });
  expect(parseStructuredReview(body({ ...valid(), unexpected: true }))).toMatchObject({ invalid: true, reason: "unknown field unexpected" });
  expect(parseStructuredReview(body(valid({ stillOpenObjections: [{ id: "OBJ-1", extra: true }] })), { knownEntries: [known], round: 2 })).toMatchObject({ invalid: true });
});
test("validates IDs, contradictions, duplicates, and required resolution evidence", () => {
  expect(parseStructuredReview(body(valid({ resolvedObjectionIds: ["OBJ-9"], resolutionEvidence: { "OBJ-9": "fixed" } })), { knownEntries: [known], round: 2 })).toMatchObject({ invalid: true, reason: "unknown or non-open objection id in resolvedObjectionIds: OBJ-9" });
  expect(parseStructuredReview(body(valid({ resolvedObjectionIds: ["OBJ-1"], resolutionEvidence: { "OBJ-1": "fixed" }, stillOpenObjections: [{ id: "OBJ-1" }] })), { knownEntries: [known], round: 2 })).toMatchObject({ invalid: true, reason: "objection id OBJ-1 appears in contradictory buckets: resolvedObjectionIds, stillOpenObjections" });
  expect(parseStructuredReview(body(valid({ resolvedObjectionIds: ["OBJ-1", "OBJ-1"], resolutionEvidence: { "OBJ-1": "fixed" } })), { knownEntries: [known], round: 2 })).toMatchObject({ invalid: true });
  expect(parseStructuredReview(body(valid({ resolvedObjectionIds: ["OBJ-1"] })), { knownEntries: [known], round: 2 })).toMatchObject({ invalid: true, reason: "missing resolution evidence for OBJ-1" });
});
test("round one permits only empty prior-ID buckets", () => {
  expect(parseStructuredReview(body(valid({ stillOpenObjections: [{ id: "OBJ-1" }] })))).toMatchObject({ invalid: true, reason: "objection id referenced before any ledger exists" });
  expect(parseStructuredReview(body(valid({ resolvedObjectionIds: ["OBJ-1"], resolutionEvidence: { "OBJ-1": "fixed" } })))).toMatchObject({ invalid: true, reason: "objection id referenced before any ledger exists" });
  expect(parseStructuredReview(body(valid({ reopenedObjections: [{ id: "OBJ-1", note: "returned" }] })))).toMatchObject({ invalid: true, reason: "objection id referenced before any ledger exists" });
  expect(parseStructuredReview(body(valid({ newObjections: [{ severity: "HIGH", summary: "risk", reason: "evidence" }] }))).invalid).toBeUndefined();
});

test("rejects extra evidence and duplicate or unknown still-open/reopened IDs", () => {
  expect(parseStructuredReview(body(valid({ resolutionEvidence: { "OBJ-9": "extra" } })), { knownEntries: [known], round: 2 })).toMatchObject({ invalid: true, reason: "resolution evidence provided for unresolved objection OBJ-9" });
  expect(parseStructuredReview(body(valid({ stillOpenObjections: [{ id: "OBJ-1" }, { id: "OBJ-1" }] })), { knownEntries: [known], round: 2 })).toMatchObject({ invalid: true });
  expect(parseStructuredReview(body(valid({ reopenedObjections: [{ id: "OBJ-2", note: "a" }, { id: "OBJ-2", note: "b" }] })), { knownEntries: [known], round: 2 })).toMatchObject({ invalid: true });
  expect(parseStructuredReview(body(valid({ stillOpenObjections: [{ id: "OBJ-9" }] })), { knownEntries: [known], round: 2 })).toMatchObject({ invalid: true, reason: "unknown or non-open objection id in stillOpenObjections: OBJ-9" });
  expect(parseStructuredReview(body(valid({ reopenedObjections: [{ id: "OBJ-9", note: "returned" }] })), { knownEntries: [known], round: 2 })).toMatchObject({ invalid: true, reason: "unknown or non-reopenable objection id in reopenedObjections: OBJ-9" });
});

test("rejects a duplicated BEGIN sentinel", () => {
  const payload = body(valid());
  expect(parseStructuredReview(payload.replace("BEGIN_STRUCTURED_REVIEW", "BEGIN_STRUCTURED_REVIEW\nBEGIN_STRUCTURED_REVIEW"))).toMatchObject({ invalid: true, reason: "missing or duplicated structured-review delimiters" });
});
