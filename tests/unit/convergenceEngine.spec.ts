import { test, expect } from "@playwright/test";
import { applyConvergenceRound, createConvergenceState } from "../../src/orchestration/convergence/convergenceEngine";
import type { StructuredClaudeReview } from "../../src/orchestration/convergence/types";

const review = (newObjections: StructuredClaudeReview["newObjections"] = []): StructuredClaudeReview => ({ reviewStatus: "CONTINUE", resolvedObjectionIds: [], resolutionEvidence: {}, stillOpenObjections: [], reopenedObjections: [], newObjections, rawText: "raw" });
test("requires two clean rounds, ignores LOW, and resets on any non-clean round", () => {
  let state = createConvergenceState();
  let result = applyConvergenceRound(state, review([{ severity: "LOW", summary: "style", reason: "style" }]), 1); state = result.state; expect(result.decision.kind).toBe("CONTINUE"); expect(state.cleanStreak).toBe(1);
  result = applyConvergenceRound(state, review([{ severity: "MEDIUM", summary: "blocking", reason: "blocking" }]), 2); state = result.state; expect(result.decision.kind).toBe("CONTINUE"); expect(state.cleanStreak).toBe(0);
  result = applyConvergenceRound(state, review(), 3); state = result.state; expect(result.decision.kind).toBe("CONTINUE"); expect(state.cleanStreak).toBe(0);
  result = applyConvergenceRound(state, review(), 4); expect(result.decision.kind).toBe("CONTINUE");
});
test("decision priority is CONVERGED before max rounds and max rounds otherwise", () => {
  let result = applyConvergenceRound(createConvergenceState(), review(), 1, { maxRounds: 1 });
  expect(result.decision.kind).toBe("MAX_ROUNDS_REACHED");
  result = applyConvergenceRound(result.state, review(), 2, { maxRounds: 2 });
  expect(result.decision.kind).toBe("CONVERGED");
  let state = createConvergenceState();
  result = applyConvergenceRound(state, review([{ severity: "HIGH", summary: "block", reason: "block" }]), 1, { maxRounds: 1 });
  expect(result.decision.kind).toBe("MAX_ROUNDS_REACHED");
});
test("invalid reviews stop safely without changing clean streak or ledger", () => {
  const first = applyConvergenceRound(createConvergenceState(), review(), 1); const invalid = { invalid: true as const, reason: "bad", rawText: "bad" };
  const result = applyConvergenceRound(first.state, invalid, 2); expect(result.decision.kind).toBe("INVALID_REVIEW"); expect(result.state.cleanStreak).toBe(first.state.cleanStreak); expect(result.state.ledger.entries).toHaveLength(0);
});
test("resolving the last blocker gives exactly one clean round, not convergence", () => {
  let result = applyConvergenceRound(createConvergenceState(), review([{ severity: "HIGH", summary: "blocking", reason: "blocking" }]), 1);
  result = applyConvergenceRound(result.state, { ...review(), resolvedObjectionIds: ["OBJ-1"], resolutionEvidence: { "OBJ-1": "fixed" } }, 2);
  expect(result.state.cleanStreak).toBe(1);
  expect(result.decision.kind).toBe("CONTINUE");
});
test("an invalid review at maxRounds wins over MAX_ROUNDS_REACHED and CONVERGED", () => {
  const result = applyConvergenceRound(createConvergenceState(), { invalid: true, reason: "malformed", rawText: "malformed" }, 3, { maxRounds: 3 });
  expect(result.decision.kind).toBe("INVALID_REVIEW");
});
test("earlier ledger and history snapshots are not mutated by later rounds", () => {
  const first = applyConvergenceRound(createConvergenceState(), review([{ severity: "HIGH", summary: "blocking", reason: "blocking" }]), 1);
  const snapshot = JSON.stringify(first.state.history.rounds[0]);
  applyConvergenceRound(first.state, { ...review(), resolvedObjectionIds: ["OBJ-1"], resolutionEvidence: { "OBJ-1": "fixed" } }, 2);
  expect(JSON.stringify(first.state.history.rounds[0])).toBe(snapshot);
  expect(first.state.history.rounds[0].ledgerSnapshot[0].status).toBe("OPEN");
});
