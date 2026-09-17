import { test, expect } from "@playwright/test";
import { createEmptyLedger, ingestReview, InvalidLedgerIngestError } from "../../src/orchestration/convergence/objectionLedger";
import { DEFAULT_CONVERGENCE_OPTIONS } from "../../src/orchestration/convergence/types";
import type { StructuredClaudeReview } from "../../src/orchestration/convergence/types";

const review = (part: Partial<StructuredClaudeReview>): StructuredClaudeReview => ({ reviewStatus: "CONTINUE", resolvedObjectionIds: [], resolutionEvidence: {}, stillOpenObjections: [], reopenedObjections: [], newObjections: [], rawText: "raw", ...part });
const raised = (severity: "HIGH" | "MEDIUM" | "LOW" = "MEDIUM") => review({ newObjections: [{ severity, summary: "retry timeout handling", reason: "retry timeout handling" }] });

test("assigns monotonic engine IDs and carries omitted OPEN objections forward", () => {
  const first = ingestReview(createEmptyLedger(), review({ newObjections: [{ severity: "HIGH", summary: "alpha risk", reason: "alpha risk" }, { severity: "LOW", summary: "beta risk", reason: "beta risk" }] }), 1, DEFAULT_CONVERGENCE_OPTIONS);
  const second = ingestReview(first.ledger, review({}), 2, DEFAULT_CONVERGENCE_OPTIONS);
  expect(second.ledger.entries.map(entry => entry.id)).toEqual(["OBJ-1", "OBJ-2"]);
  expect(second.ledger.entries[0].history.at(-1)?.kind).toBe("IMPLICITLY_CARRIED_OPEN");
});
test("collapses identical same-round new objections and preserves paraphrase audit text", () => {
  const first = ingestReview(createEmptyLedger(), review({ newObjections: [{ severity: "MEDIUM", summary: "retry timeout handling", reason: "retry timeout handling" }, { severity: "MEDIUM", summary: "retry timeout handling", reason: "retry timeout handling" }] }), 1, DEFAULT_CONVERGENCE_OPTIONS);
  expect(first.ledger.entries).toHaveLength(1); expect(first.ledger.nextId).toBe(2); expect(first.ledger.entries[0].history.at(-1)?.kind).toBe("DUPLICATE_COLLAPSED");
  const merged = ingestReview(first.ledger, raised("HIGH"), 2, DEFAULT_CONVERGENCE_OPTIONS);
  expect(merged.ledger.entries[0].history.find(event => event.kind === "PARAPHRASED")?.detail).toContain("retry timeout");
  expect(merged.ledger.entries[0].severity).toBe("HIGH");
});
test("rejects open-objective downgrade and applies historical severity floor on reopen", () => {
  const first = ingestReview(createEmptyLedger(), raised("MEDIUM"), 1, DEFAULT_CONVERGENCE_OPTIONS);
  const resolved = ingestReview(first.ledger, review({ resolvedObjectionIds: ["OBJ-1"], resolutionEvidence: { "OBJ-1": "fixed" } }), 2, DEFAULT_CONVERGENCE_OPTIONS);
  const reopened = ingestReview(resolved.ledger, review({ reopenedObjections: [{ id: "OBJ-1", note: "returned", severityOverride: "LOW" }] }), 3, DEFAULT_CONVERGENCE_OPTIONS);
  expect(reopened.ledger.entries[0].status).toBe("OPEN"); expect(reopened.ledger.entries[0].severity).toBe("MEDIUM"); expect(reopened.ledger.entries[0].highestSeveritySeen).toBe("MEDIUM");
  const downgrade = ingestReview(reopened.ledger, review({ stillOpenObjections: [{ id: "OBJ-1", severityOverride: "LOW" }] }), 4, DEFAULT_CONVERGENCE_OPTIONS);
  expect(downgrade.ledger.entries[0].severity).toBe("MEDIUM"); expect(downgrade.ledger.entries[0].history.at(-1)?.kind).toBe("SEVERITY_DOWNGRADE_REJECTED");
});

test.describe("post-match canonical conflicts", () => {
  test("rejects RESOLVED plus NEW matching the same canonical objection", () => {
    const first = ingestReview(createEmptyLedger(), raised(), 1, DEFAULT_CONVERGENCE_OPTIONS);
    expect(() => ingestReview(first.ledger, review({ resolvedObjectionIds: ["OBJ-1"], resolutionEvidence: { "OBJ-1": "fixed" }, newObjections: [{ severity: "MEDIUM", summary: "retry timeout handling", reason: "retry timeout handling" }] }), 2, DEFAULT_CONVERGENCE_OPTIONS)).toThrow(InvalidLedgerIngestError);
  });
  test("rejects STILL_OPEN plus NEW matching the same canonical objection", () => {
    const first = ingestReview(createEmptyLedger(), raised(), 1, DEFAULT_CONVERGENCE_OPTIONS);
    expect(() => ingestReview(first.ledger, review({ stillOpenObjections: [{ id: "OBJ-1" }], newObjections: [{ severity: "MEDIUM", summary: "retry timeout handling", reason: "retry timeout handling" }] }), 2, DEFAULT_CONVERGENCE_OPTIONS)).toThrow(InvalidLedgerIngestError);
  });
  test("rejects REOPENED plus NEW matching the same canonical objection", () => {
    const first = ingestReview(createEmptyLedger(), raised(), 1, DEFAULT_CONVERGENCE_OPTIONS);
    const resolved = ingestReview(first.ledger, review({ resolvedObjectionIds: ["OBJ-1"], resolutionEvidence: { "OBJ-1": "fixed" } }), 2, DEFAULT_CONVERGENCE_OPTIONS);
    expect(() => ingestReview(resolved.ledger, review({ reopenedObjections: [{ id: "OBJ-1", note: "returned" }], newObjections: [{ severity: "MEDIUM", summary: "retry timeout handling", reason: "retry timeout handling" }] }), 3, DEFAULT_CONVERGENCE_OPTIONS)).toThrow(InvalidLedgerIngestError);
  });
});

test("same-round exact duplicates keep the highest severity in either order", () => {
  for (const severities of [["LOW", "HIGH"], ["HIGH", "LOW"]] as const) {
    const result = ingestReview(createEmptyLedger(), review({ newObjections: severities.map(severity => ({ severity, summary: "retry timeout handling", reason: "retry timeout handling" })) }), 1, DEFAULT_CONVERGENCE_OPTIONS);
    expect(result.ledger.entries).toHaveLength(1);
    expect(result.ledger.entries[0].severity).toBe("HIGH");
    expect(result.ledger.entries[0].highestSeveritySeen).toBe("HIGH");
  }
});
