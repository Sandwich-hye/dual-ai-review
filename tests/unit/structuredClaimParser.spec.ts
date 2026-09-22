import { test, expect } from "@playwright/test";
import { parseStructuredClaimReview } from "../../src/orchestration/claims/structuredClaimParser";
import type { ClaimLedgerEntry } from "../../src/orchestration/claims/types";

const body = (value: object, before = "", after = "") => `${before}\nBEGIN_STRUCTURED_REVIEW\n${JSON.stringify(value, null, 2)}\nEND_STRUCTURED_REVIEW\n${after}`;
const valid = (extra: object = {}) => ({ reviewStatus: "CONTINUE", resolvedClaimIds: [], resolutionEvidence: {}, stillOpenClaims: [], reopenedClaims: [], newClaims: [], ...extra });
const known: ClaimLedgerEntry = {
  id: "CLAIM-1",
  claim: { statement: "existing claim", rationale: "existing rationale" },
  severity: "MEDIUM",
  highestSeveritySeen: "MEDIUM",
  confidence: 0.5,
  status: "OPEN",
  evidenceFor: [],
  evidenceAgainst: [],
  confidenceHistory: [],
  firstSeenRound: 1,
  lastSeenRound: 1,
  normalizedFingerprint: ["existing", "claim"],
  history: [],
};

test("parses a valid claim review and ignores text outside the sentinels", () => {
  const result = parseStructuredClaimReview(body(valid({
    newClaims: [{ severity: "HIGH", statement: "Retry loses identity", rationale: "The second attempt cannot correlate its result" }],
    reviewNotes: "Review complete",
  }), "preamble", "postamble"));
  expect("invalid" in result).toBe(false);
  if (!("invalid" in result)) {
    expect(result.newClaims[0]).toEqual({ severity: "HIGH", statement: "Retry loses identity", rationale: "The second attempt cannot correlate its result" });
    expect(result.reviewNotes).toBe("Review complete");
  }
});

test("rejects malformed JSON and missing sentinels", () => {
  expect(parseStructuredClaimReview("BEGIN_STRUCTURED_REVIEW\n{\nEND_STRUCTURED_REVIEW")).toMatchObject({ invalid: true });
  expect(parseStructuredClaimReview(JSON.stringify(valid()))).toMatchObject({ invalid: true, reason: "missing or duplicated structured-review delimiters" });
});

test("rejects duplicated sentinels", () => {
  const payload = body(valid()).replace("BEGIN_STRUCTURED_REVIEW", "BEGIN_STRUCTURED_REVIEW\nBEGIN_STRUCTURED_REVIEW");
  expect(parseStructuredClaimReview(payload)).toMatchObject({ invalid: true, reason: "missing or duplicated structured-review delimiters" });
});

test("rejects unknown fields and invalid severity values", () => {
  expect(parseStructuredClaimReview(body(valid({ unexpected: true })))).toMatchObject({ invalid: true, reason: "unknown field unexpected" });
  expect(parseStructuredClaimReview(body(valid({ newClaims: [{ severity: "URGENT", statement: "x", rationale: "y" }] }))).invalid).toBe(true);
});

test("rejects invalid claim references and invalid resolution evidence references", () => {
  expect(parseStructuredClaimReview(body(valid({ resolvedClaimIds: ["OBJ-1"], resolutionEvidence: { "OBJ-1": "fixed" } })), { knownEntries: [known], round: 2 })).toMatchObject({ invalid: true });
  expect(parseStructuredClaimReview(body(valid({ resolutionEvidence: { "CLAIM-9": "extra" } })), { knownEntries: [known], round: 2 })).toMatchObject({ invalid: true, reason: "resolution evidence provided for unresolved claim CLAIM-9" });
  expect(parseStructuredClaimReview(body(valid({ resolvedClaimIds: ["CLAIM-9"], resolutionEvidence: { "CLAIM-9": "fixed" } })), { knownEntries: [known], round: 2 })).toMatchObject({ invalid: true, reason: "unknown or non-open claim id in resolvedClaimIds: CLAIM-9" });
});

test("rejects contradictory claim references and never returns partial data", () => {
  const result = parseStructuredClaimReview(body(valid({ resolvedClaimIds: ["CLAIM-1"], resolutionEvidence: { "CLAIM-1": "fixed" }, stillOpenClaims: [{ id: "CLAIM-1" }] })), { knownEntries: [known], round: 2 });
  expect(result).toMatchObject({ invalid: true });
  expect(Object.keys(result)).toEqual(["invalid", "reason", "rawText"]);
});

test("rejects missing required fields and duplicate IDs", () => {
  expect(parseStructuredClaimReview(body({ reviewStatus: "CONTINUE" }))).toMatchObject({ invalid: true, reason: "missing field resolvedClaimIds" });
  expect(parseStructuredClaimReview(body(valid({ resolvedClaimIds: ["CLAIM-1", "CLAIM-1"], resolutionEvidence: { "CLAIM-1": "fixed" } })), { knownEntries: [known], round: 2 })).toMatchObject({ invalid: true });
});

test("valid reviews and invalid results are JSON serializable", () => {
  const parsed = parseStructuredClaimReview(body(valid({ newClaims: [{ severity: "LOW", statement: "style issue", rationale: "minor wording" }] })));
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
});
