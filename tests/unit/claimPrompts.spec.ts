import { test, expect } from "@playwright/test";
import {
  buildClaimReviewClaudeReviewPrompt,
  buildClaimReviewRevisionPrompt,
} from "../../src/orchestration/claims/claimPrompts";
import type { ClaimLedgerEntry, Evidence } from "../../src/orchestration/claims/types";

const claim: ClaimLedgerEntry = {
  id: "CLAIM-1",
  claim: { statement: "Retry loses the request identifier", rationale: "The second attempt cannot correlate its response" },
  severity: "HIGH",
  highestSeveritySeen: "HIGH",
  confidence: 0.42,
  status: "DISPUTED",
  evidenceFor: ["EV-1"],
  evidenceAgainst: ["EV-2"],
  confidenceHistory: [],
  firstSeenRound: 1,
  lastSeenRound: 2,
  normalizedFingerprint: ["retry", "loses", "request", "identifier"],
  history: [],
};

const evidence: Evidence[] = [
  { id: "EV-1", claimId: "CLAIM-1", kind: "SUPPORTING", strength: "WEAK", sourceRole: "REVIEWER", text: "Support", round: 1, submittedAt: "2026-09-22T00:00:00.000Z" },
  { id: "EV-2", claimId: "CLAIM-1", kind: "CHALLENGING", strength: "MODERATE", sourceRole: "REVIEWER", text: "Challenge", round: 2, submittedAt: "2026-09-22T00:00:00.000Z" },
];

test("reviewer prompt includes task, answer, and exact claim-review sentinel/schema contract", () => {
  const prompt = buildClaimReviewClaudeReviewPrompt("Original task", "Current answer", [], 1);
  expect(prompt).toContain("You are the Reviewer LLM.");
  expect(prompt).toContain("CURRENT GENERATOR LLM ANSWER:");
  expect(prompt).not.toContain("You are Claude.");
  expect(prompt).not.toContain("CURRENT CHATGPT ANSWER:");
  expect(prompt).toContain("Original task");
  expect(prompt).toContain("Current answer");
  expect(prompt).toContain("BEGIN_STRUCTURED_REVIEW");
  expect(prompt).toContain("END_STRUCTURED_REVIEW");
  expect(prompt).toContain('"resolvedClaimIds":');
  expect(prompt).toContain('"stillOpenClaims":');
  expect(prompt).toContain('"reopenedClaims":');
  expect(prompt).toContain('"newClaims":');
  expect(prompt).toContain('"statement"');
  expect(prompt).toContain('"rationale"');
});

test("round-one reviewer prompt forbids prior claim references", () => {
  const prompt = buildClaimReviewClaudeReviewPrompt("Task", "Answer", [claim], 1);
  expect(prompt).toContain("round 1");
  expect(prompt).toContain("all claim-id arrays must be empty");
  expect(prompt).not.toContain("CURRENT CLAIM LEDGER:");
});

test("later reviewer prompt includes the current claim ledger and requires id reuse", () => {
  const prompt = buildClaimReviewClaudeReviewPrompt("Task", "Revised answer", [claim], 2);
  expect(prompt).toContain("LATEST GENERATOR LLM ANSWER:");
  expect(prompt).not.toContain("LATEST CHATGPT ANSWER:");
  expect(prompt).toContain("CURRENT CLAIM LEDGER:");
  expect(prompt).toContain("CLAIM-1");
  expect(prompt).toContain("Retry loses the request identifier");
  expect(prompt).toContain("confidence 0.42");
  expect(prompt).toContain("Only reference CLAIM-<n> ids listed");
});

test("generator prompt includes previous answer, review, unresolved claims, and evidence", () => {
  const prompt = buildClaimReviewRevisionPrompt("Task", "Previous answer", "Reviewer response", [claim], evidence);
  expect(prompt).toContain("You are the Generator LLM.");
  expect(prompt).not.toContain("You are ChatGPT.");
  expect(prompt).toContain("Task");
  expect(prompt).toContain("Previous answer");
  expect(prompt).toContain("Reviewer response");
  expect(prompt).toContain("CLAIM-1");
  expect(prompt).toContain("Retry loses the request identifier");
  expect(prompt).toContain("EV-1 (WEAK)");
  expect(prompt).toContain("EV-2 (MODERATE)");
  expect(prompt).toContain("COMPLETE revised, standalone answer");
  expect(prompt).toContain("Do not make a convergence, acceptance, or rejection decision");
});

test("generator prompt handles an empty unresolved-claim list", () => {
  const prompt = buildClaimReviewRevisionPrompt("Task", "Answer", "Review", [], []);
  expect(prompt).toContain("(there are no blocking claims)");
  expect(prompt).not.toContain("CLAIM-1");
});

test("prompt builders are deterministic", () => {
  const reviewerA = buildClaimReviewClaudeReviewPrompt("Task", "Answer", [claim], 2);
  const reviewerB = buildClaimReviewClaudeReviewPrompt("Task", "Answer", [claim], 2);
  const generatorA = buildClaimReviewRevisionPrompt("Task", "Answer", "Review", [claim], evidence);
  const generatorB = buildClaimReviewRevisionPrompt("Task", "Answer", "Review", [claim], evidence);
  expect(reviewerA).toBe(reviewerB);
  expect(generatorA).toBe(generatorB);
});
