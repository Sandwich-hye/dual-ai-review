import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateSupervisorState } from "../../src/orchestration/supervisor/supervisorEngine";
import type { SupervisorInput, SupervisorRecommendationSignal } from "../../src/orchestration/supervisor/types";

const recommendation = (overrides: Partial<SupervisorRecommendationSignal> = {}): SupervisorRecommendationSignal => ({
  round: 1,
  triggeredBranch: "DEFAULT_CONTINUE",
  cleanStreak: 0,
  openHighCount: 0,
  openMediumCount: 0,
  disputedCount: 0,
  averageConfidence: 0.5,
  lowConfidenceResolutionCount: 0,
  invalidReviewStreak: 0,
  ...overrides,
});

const input = (recommendations: SupervisorRecommendationSignal[], agreements: Array<"AGREED" | "OVERRODE"> = []): SupervisorInput => ({
  rounds: recommendations.map((value, index) => ({
    roundNumber: index + 1,
    recommendation: { ...value, round: index + 1 },
    recommendationAgreement: agreements[index] ?? "AGREED",
    outcome: "CONTINUE",
  })),
  auditEvents: [],
  hardMaxRounds: 10,
  recommendedMaxRounds: 6,
  invalidReviewRejectThreshold: 3,
  reopenRejectThreshold: 3,
});

test("healthy state produces no flags and no escalation", () => {
  const result = evaluateSupervisorState(input([
    recommendation({ openHighCount: 3 }),
    recommendation({ openHighCount: 2 }),
    recommendation({ openHighCount: 1 }),
    recommendation({ openHighCount: 0 }),
  ]));

  expect(result).toEqual({ round: 4, flags: [], escalationRecommended: false });
});

test("detects stagnation when blocking load does not improve across the window", () => {
  const result = evaluateSupervisorState(input([
    recommendation({ openHighCount: 2 }),
    recommendation({ openHighCount: 1, openMediumCount: 1 }),
    recommendation({ openHighCount: 2 }),
    recommendation({ openHighCount: 2 }),
  ]));

  expect(result.flags).toHaveLength(1);
  expect(result.flags[0]).toMatchObject({ flag: "STAGNATION", evidenceRounds: [1, 2, 3, 4] });
  expect(result.escalationRecommended).toBe(true);
});

test("does not flag a window whose blocking load trends down despite oscillation", () => {
  const result = evaluateSupervisorState(input([
    recommendation({ openHighCount: 5 }),
    recommendation({ openHighCount: 3 }),
    recommendation({ openHighCount: 4 }),
    recommendation({ openHighCount: 2 }),
  ]));

  expect(result.flags).toEqual([]);
});

test("detects decision inconsistency only when every completed round in the window is overridden", () => {
  const result = evaluateSupervisorState(input([
    recommendation(),
    recommendation(),
    recommendation(),
  ], ["OVERRODE", "OVERRODE", "OVERRODE"]));

  expect(result.flags).toHaveLength(1);
  expect(result.flags[0]).toMatchObject({ flag: "DECISION_INCONSISTENCY", evidenceRounds: [1, 2, 3] });
});

test("detects invalid-review flap cycles without requiring the chronic threshold", () => {
  const result = evaluateSupervisorState(input([
    recommendation({ openHighCount: 4, invalidReviewStreak: 1 }),
    recommendation({ openHighCount: 3, invalidReviewStreak: 2 }),
    recommendation({ openHighCount: 2, invalidReviewStreak: 0 }),
    recommendation({ openHighCount: 1, invalidReviewStreak: 1 }),
    recommendation({ openHighCount: 0, invalidReviewStreak: 0 }),
  ]));

  expect(result.flags).toHaveLength(1);
  expect(result.flags[0]).toMatchObject({ flag: "ABNORMAL_WORKFLOW" });
  expect(result.flags[0].detail).toContain("2 sub-threshold invalid-review flap cycles");
});

test("detects hard-ceiling events as abnormal workflow", () => {
  const state = input([recommendation()]);
  state.rounds[0].hardSafetyOverrideInferred = true;
  const result = evaluateSupervisorState(state);

  expect(result.flags).toHaveLength(1);
  expect(result.flags[0].flag).toBe("ABNORMAL_WORKFLOW");
  expect(result.flags[0].evidenceRounds).toEqual([1]);
});

test("a pending current round does not disable decision inconsistency", () => {
  const state = input([
    recommendation(), recommendation(), recommendation(), recommendation(),
  ], ["OVERRODE", "OVERRODE", "OVERRODE", "AGREED"]);
  const pending = state.rounds.at(-1)!;
  pending.recommendation.triggeredBranch = "CLEAN_ACCEPT";
  pending.recommendationAgreement = undefined;
  pending.outcome = undefined;

  const result = evaluateSupervisorState(state);
  expect(result.flags.some((flag) => flag.flag === "DECISION_INCONSISTENCY")).toBe(true);
  expect(result.flags.find((flag) => flag.flag === "DECISION_INCONSISTENCY")?.evidenceRounds).toEqual([1, 2, 3]);
});

test("three completed overrides plus one pending round trigger inconsistency", () => {
  const state = input([
    recommendation(), recommendation(), recommendation(), recommendation(),
  ], ["OVERRODE", "OVERRODE", "OVERRODE", "AGREED"]);
  state.rounds[3].recommendationAgreement = undefined;
  state.rounds[3].outcome = undefined;

  const result = evaluateSupervisorState(state, { decisionInconsistencyWindowRounds: 3 });
  expect(result.flags).toContainEqual(expect.objectContaining({
    flag: "DECISION_INCONSISTENCY",
    evidenceRounds: [1, 2, 3],
  }));
});

test("identical input produces identical output", () => {
  const state = input([
    recommendation({ openHighCount: 1 }),
    recommendation({ openHighCount: 1 }),
    recommendation({ openHighCount: 1 }),
    recommendation({ openHighCount: 1 }),
  ], ["OVERRODE", "OVERRODE", "OVERRODE", "AGREED"]);
  expect(evaluateSupervisorState(state, { stagnationWindowRounds: 4 })).toEqual(evaluateSupervisorState(state, { stagnationWindowRounds: 4 }));
});

test("engine source has no browser, network, or filesystem dependency", () => {
  const source = readFileSync(resolve(process.cwd(), "src/orchestration/supervisor/supervisorEngine.ts"), "utf8");
  expect(source).not.toMatch(/playwright|\bPage\b|fetch\(|https?:\/\//i);
  expect(source).not.toMatch(/from ["']node:(fs|net|http|https)["']/i);
});
