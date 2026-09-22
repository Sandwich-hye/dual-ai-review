import { test, expect } from "@playwright/test";
import {
  addClaim,
  attachEvidence,
  createEmptyClaimLedger,
  ingestClaimReview,
  reopenClaim,
  resolveClaim,
  type ClaimLedger,
} from "../../src/orchestration/claims/claimLedger";

const newClaim = (severity: "HIGH" | "MEDIUM" | "LOW" = "MEDIUM") => ({
  severity,
  statement: "The retry path loses the request identifier",
  rationale: "A retry can no longer correlate its response",
});

test("creates canonical claim IDs with neutral confidence and RAISED history", () => {
  const result = addClaim(newClaim("HIGH"), 1);
  expect(result.ledger.entries[0]).toMatchObject({
    id: "CLAIM-1",
    severity: "HIGH",
    highestSeveritySeen: "HIGH",
    confidence: 0.5,
    status: "OPEN",
    claim: newClaim("HIGH").statement ? { statement: newClaim("HIGH").statement, rationale: newClaim("HIGH").rationale } : undefined,
  });
  expect(result.ledger.entries[0].history).toEqual([{ round: 1, kind: "RAISED" }]);
});

test("merges a conservative duplicate without creating a second claim", () => {
  const first = addClaim(newClaim(), 1);
  const second = addClaim({ ...newClaim("HIGH"), statement: "The retry path loses the request identifier" }, 2, first.ledger);
  expect(second.ledger.entries).toHaveLength(1);
  expect(second.ledger.entries[0].id).toBe("CLAIM-1");
  expect(second.ledger.entries[0].history.some((event) => event.kind === "PARAPHRASED")).toBe(true);
  expect(second.ledger.entries[0].severity).toBe("HIGH");
});

test("attaching evidence updates confidence, references, and history", () => {
  const first = addClaim(newClaim(), 1);
  const result = attachEvidence(first.ledger, {
    claimId: "CLAIM-1",
    kind: "SUPPORTING",
    strength: "STRONG",
    sourceRole: "REVIEWER",
    text: "The response identifier is absent after retry.",
    round: 2,
    submittedAt: "2026-09-22T00:00:00.000Z",
  });
  expect(result.ledger.evidenceLog[0].id).toBe("EV-1");
  expect(result.ledger.entries[0].evidenceFor).toEqual(["EV-1"]);
  expect(result.ledger.entries[0].confidence).toBe(0.7);
  expect(result.ledger.entries[0].confidenceHistory.at(-1)).toMatchObject({ causeEvidenceId: "EV-1", newConfidence: 0.7 });
  expect(result.ledger.entries[0].history.map((event) => event.kind)).toEqual(["RAISED", "EVIDENCE_ADDED", "CONFIDENCE_CHANGED"]);
});

test("moves an OPEN claim to RESOLVED with structural resolution evidence", () => {
  const first = addClaim(newClaim(), 1);
  const result = resolveClaim(first.ledger, "CLAIM-1", "The retry now preserves the identifier.", 2);
  const claim = result.ledger.entries[0];
  expect(claim.status).toBe("RESOLVED");
  expect(claim.history.at(-1)).toMatchObject({ kind: "RESOLVED", resolutionEvidenceRef: "EV-1" });
  expect(result.ledger.evidenceLog[0]).toMatchObject({ id: "EV-1", kind: "RESOLUTION", claimId: "CLAIM-1" });
});

test("moves a resolved claim into DISPUTED when balanced evidence exists", () => {
  const first = addClaim(newClaim(), 1);
  const resolved = resolveClaim(first.ledger, "CLAIM-1", "The retry now preserves the identifier.", 2);
  const challenged = attachEvidence(resolved.ledger, {
    claimId: "CLAIM-1",
    kind: "CHALLENGING",
    strength: "STRONG",
    sourceRole: "REVIEWER",
    text: "A second retry path still loses the identifier.",
    round: 3,
    submittedAt: "2026-09-22T00:00:00.000Z",
  });
  expect(challenged.ledger.entries[0].status).toBe("DISPUTED");
  expect(challenged.ledger.entries[0].evidenceFor).toContain("EV-1");
  expect(challenged.ledger.entries[0].evidenceAgainst).toContain("EV-2");
});

test("reopening applies the historical severity floor", () => {
  const first = addClaim({ ...newClaim("HIGH"), statement: "A high severity claim" }, 1);
  const resolved = resolveClaim(first.ledger, "CLAIM-1", "Fixed.", 2);
  const reopened = reopenClaim(resolved.ledger, { id: "CLAIM-1", note: "The high severity issue returned.", severityOverride: "LOW" }, 3);
  expect(reopened.ledger.entries[0].status).toBe("DISPUTED");
  expect(reopened.ledger.entries[0].severity).toBe("HIGH");
  expect(reopened.ledger.entries[0].highestSeveritySeen).toBe("HIGH");
});

test("ledger mutations do not mutate prior entries or history arrays", () => {
  const first = addClaim(newClaim(), 1);
  const before = JSON.parse(JSON.stringify(first.ledger)) as ClaimLedger;
  const second = attachEvidence(first.ledger, {
    claimId: "CLAIM-1",
    kind: "SUPPORTING",
    strength: "WEAK",
    sourceRole: "HUMAN",
    text: "Additional support.",
    round: 2,
    submittedAt: "2026-09-22T00:00:00.000Z",
  });
  expect(first.ledger).toEqual(before);
  expect(second.ledger.entries[0].history).not.toBe(first.ledger.entries[0].history);
  expect(second.ledger.evidenceLog).not.toBe(first.ledger.evidenceLog);
});

test("ingest marks untouched OPEN claims as implicitly carried", () => {
  const first = addClaim(newClaim(), 1);
  const result = ingestClaimReview(first.ledger, {}, 2);
  expect(result.ledger.entries[0].history.at(-1)?.kind).toBe("IMPLICITLY_CARRIED_OPEN");
});
