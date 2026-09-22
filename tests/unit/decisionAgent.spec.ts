import { test, expect } from "@playwright/test";
import { evaluateDecision, type DecisionAgentInput } from "../../src/orchestration/claims/decisionAgent";
import type { ClaimLedgerEntry } from "../../src/orchestration/claims/types";

const claim = (overrides: Partial<ClaimLedgerEntry> = {}): ClaimLedgerEntry => ({
  id: "CLAIM-1",
  claim: { statement: "claim", rationale: "rationale" },
  severity: "HIGH",
  highestSeveritySeen: "HIGH",
  confidence: 0.5,
  status: "OPEN",
  evidenceFor: [],
  evidenceAgainst: [],
  confidenceHistory: [],
  firstSeenRound: 1,
  lastSeenRound: 1,
  normalizedFingerprint: ["claim"],
  history: [],
  ...overrides,
});

const input = (overrides: Partial<DecisionAgentInput> = {}): DecisionAgentInput => ({
  claims: [],
  round: 1,
  hardMaxRounds: 20,
  recommendedMaxRounds: 10,
  stabilityWindowRounds: 2,
  reopenRejectThreshold: 3,
  invalidReviewRejectThreshold: 3,
  resolutionConfidenceThreshold: 0.75,
  cleanStreak: 0,
  invalidReviewStreak: 0,
  invalidReviewThisRound: null,
  ...overrides,
});

test("hard maximum wins over chronic claims, invalid reviews, and clean acceptance", () => {
  const result = evaluateDecision(input({
    round: 20,
    claims: [claim({ history: [{ round: 1, kind: "REOPENED" }, { round: 2, kind: "REOPENED" }, { round: 3, kind: "REOPENED" }] })],
    invalidReviewStreak: 3,
    invalidReviewThisRound: { reason: "bad JSON" },
    cleanStreak: 5,
  }));
  expect(result.kind).toBe("REJECT_RECOMMENDED");
  expect(result.triggeredBranch).toBe("HARD_MAX_ROUNDS_REACHED");
  expect(result.reason).toContain("hardMaxRounds (20) reached");
});

test("selects the chronic claim branch", () => {
  const result = evaluateDecision(input({
    claims: [claim({ id: "CLAIM-7", history: [{ round: 1, kind: "REOPENED" }, { round: 2, kind: "REOPENED" }, { round: 3, kind: "REOPENED" }] })],
  }));
  expect(result).toMatchObject({ kind: "REJECT_RECOMMENDED", triggeredBranch: "CHRONIC_CLAIM" });
  expect(result.reason).toContain("claim CLAIM-7");
});

test("selects the invalid-review streak branch", () => {
  const result = evaluateDecision(input({
    invalidReviewStreak: 3,
    invalidReviewThisRound: { reason: "malformed payload" },
  }));
  expect(result).toMatchObject({ kind: "REJECT_RECOMMENDED", triggeredBranch: "INVALID_REVIEW_STREAK" });
  expect(result.reason).toContain("invalidReviewStreak (=3)");
});

test("selects the single invalid-review branch before soft budget or clean acceptance", () => {
  const result = evaluateDecision(input({
    round: 11,
    cleanStreak: 4,
    invalidReviewStreak: 1,
    invalidReviewThisRound: { reason: "missing sentinel" },
  }));
  expect(result).toMatchObject({ kind: "CONTINUE_RECOMMENDED", triggeredBranch: "INVALID_REVIEW_SINGLE" });
  expect(result.invalidReview).toEqual({ reason: "missing sentinel" });
});

test("selects the soft-budget branch", () => {
  const result = evaluateDecision(input({ round: 11 }));
  expect(result).toMatchObject({ kind: "CONTINUE_RECOMMENDED", triggeredBranch: "SOFT_BUDGET_EXCEEDED" });
});

test("selects clean acceptance only after the stability window", () => {
  const result = evaluateDecision(input({ round: 2, cleanStreak: 2 }));
  expect(result).toMatchObject({ kind: "ACCEPT_RECOMMENDED", triggeredBranch: "CLEAN_ACCEPT", cleanStreak: 2 });
});

test("selects default continuation for a non-clean ordinary round", () => {
  const result = evaluateDecision(input({ claims: [claim()] }));
  expect(result).toMatchObject({ kind: "CONTINUE_RECOMMENDED", triggeredBranch: "DEFAULT_CONTINUE", openHighCount: 1 });
  expect(result.reason).toBe("1 open HIGH, 0 open MEDIUM, 0 disputed, 0 low-confidence resolution(s) remaining");
});

test("returns deterministic, audit-safe output for identical input", () => {
  const value = input({
    claims: [claim({ status: "DISPUTED", confidence: 0.5, evidenceFor: ["EV-1"], evidenceAgainst: ["EV-2"] })],
    cleanStreak: 1,
  });
  const first = evaluateDecision(value);
  const second = evaluateDecision(value);
  expect(first).toEqual(second);
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  expect(first.triggeredBranch).toBe("DEFAULT_CONTINUE");
});
