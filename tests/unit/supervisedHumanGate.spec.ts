import { test, expect } from "@playwright/test";
import {
  createSupervisedHumanGate,
  type SupervisedHumanGateOptions,
} from "../../src/orchestration/supervisor/supervisedHumanGate";
import { createDeterministicSupervisor } from "../../src/orchestration/supervisor/deterministicSupervisor";
import type { HumanGate, HumanGatePresentation, HumanGateRawResponse } from "../../src/orchestration/humanGate/humanGate";
import type { Supervisor } from "../../src/orchestration/supervisor/types";

const presentation = (round = 1): HumanGatePresentation => ({
  round,
  currentAnswer: "answer",
  recommendation: {
    kind: "CONTINUE_RECOMMENDED",
    triggeredBranch: "DEFAULT_CONTINUE",
    round,
    reason: "continue",
    cleanStreak: 0,
    openHighCount: 1,
    openMediumCount: 0,
    disputedCount: 0,
    averageConfidence: 0.4,
    lowConfidenceResolutionCount: 0,
    invalidReviewStreak: 0,
  },
  disputedClaims: [],
  claimLedgerDelta: [],
  relevantEvidence: [],
  legalOutcomes: ["CONTINUE", "ACCEPT", "REJECT"],
});

const response: HumanGateRawResponse = {
  requestedOutcome: "ACCEPT",
  rationale: "human decision",
  decidedAt: "2026-09-22T00:00:00.000Z",
};

const options: SupervisedHumanGateOptions = {
  invalidReviewRejectThreshold: 3,
  reopenRejectThreshold: 3,
};

test("assesses before delegating and passes the unchanged presentation", async () => {
  const order: string[] = [];
  let received: HumanGatePresentation | undefined;
  let assessedInput: Parameters<NonNullable<Supervisor["assess"]>>[0] | undefined;
  const inner: HumanGate = {
    async presentAndAwaitDecision(value) { order.push("human"); received = value; return response; },
  };
  const supervisor: Supervisor = {
    async assess(input) {
      order.push("supervisor");
      assessedInput = input;
      return { round: 1, flags: [], escalationRecommended: false };
    },
  };
  const gate = createSupervisedHumanGate(inner, supervisor, options);
  const value = presentation();
  await gate.presentAndAwaitDecision(value);

  expect(order).toEqual(["supervisor", "human"]);
  expect(received).toBe(value);
  expect(assessedInput?.rounds).toHaveLength(1);
  expect(assessedInput?.rounds[0].recommendation.triggeredBranch).toBe("DEFAULT_CONTINUE");
  expect(assessedInput?.rounds[0].outcome).toBeUndefined();
});

test("first and final rounds are assessed with the current pending recommendation", async () => {
  const inputs: Array<Parameters<NonNullable<Supervisor["assess"]>>[0]> = [];
  const responses: HumanGateRawResponse[] = [
    { ...response, requestedOutcome: "CONTINUE" },
    { ...response, requestedOutcome: "ACCEPT" },
  ];
  let index = 0;
  const gate = createSupervisedHumanGate(
    {
      async presentAndAwaitDecision() { return responses[index++]; },
    },
    {
      async assess(input) { inputs.push(input); return { round: input.rounds.at(-1)?.roundNumber ?? 0, flags: [], escalationRecommended: false }; },
    },
    options,
  );

  await gate.presentAndAwaitDecision(presentation(1));
  await gate.presentAndAwaitDecision({
    ...presentation(2),
    recommendation: { ...presentation(2).recommendation, kind: "ACCEPT_RECOMMENDED", triggeredBranch: "CLEAN_ACCEPT" },
  });

  expect(inputs[0].rounds).toHaveLength(1);
  expect(inputs[0].rounds[0].outcome).toBeUndefined();
  expect(inputs[1].rounds).toHaveLength(2);
  expect(inputs[1].rounds[0].outcome).toBe("CONTINUE");
  expect(inputs[1].rounds[1].recommendation.triggeredBranch).toBe("CLEAN_ACCEPT");
  expect(inputs[1].rounds[1].outcome).toBeUndefined();
});

test("deterministic supervisor detects inconsistency across a realistic multi-round decorated gate", async () => {
  const gate = createSupervisedHumanGate(
    { async presentAndAwaitDecision() { return { ...response, requestedOutcome: "REJECT" }; } },
    createDeterministicSupervisor(),
    options,
  );

  for (let round = 1; round <= 4; round += 1) {
    await gate.presentAndAwaitDecision(presentation(round));
  }

  const assessments = gate.getAccumulatedAssessments();
  expect(assessments[3]).toEqual(expect.objectContaining({
    flags: expect.arrayContaining([expect.objectContaining({
      flag: "DECISION_INCONSISTENCY",
      evidenceRounds: [1, 2, 3],
    })]),
  }));
});

test("hard-max final-round recommendation is visible before the human decision", async () => {
  let observed: Parameters<NonNullable<Supervisor["assess"]>>[0] | undefined;
  const gate = createSupervisedHumanGate(
    { async presentAndAwaitDecision() { return { ...response, requestedOutcome: "REJECT" }; } },
    { async assess(input) { observed = input; return { round: 3, flags: [], escalationRecommended: false }; } },
    options,
  );
  const finalPresentation: HumanGatePresentation = {
    ...presentation(3),
    recommendation: { ...presentation(3).recommendation, triggeredBranch: "HARD_MAX_ROUNDS_REACHED", kind: "REJECT_RECOMMENDED" },
    legalOutcomes: ["ACCEPT", "REJECT"],
  };

  await gate.presentAndAwaitDecision(finalPresentation);
  expect(observed?.rounds.at(-1)).toMatchObject({
    roundNumber: 3,
    recommendation: { triggeredBranch: "HARD_MAX_ROUNDS_REACHED" },
  });
  expect(observed?.rounds.at(-1)?.outcome).toBeUndefined();
});

test("chronic-claim final-round recommendation is visible before the human decision", async () => {
  let observed: Parameters<NonNullable<Supervisor["assess"]>>[0] | undefined;
  const gate = createSupervisedHumanGate(
    { async presentAndAwaitDecision() { return response; } },
    { async assess(input) { observed = input; return { round: 3, flags: [], escalationRecommended: false }; } },
    options,
  );
  const finalPresentation: HumanGatePresentation = {
    ...presentation(3),
    recommendation: { ...presentation(3).recommendation, triggeredBranch: "CHRONIC_CLAIM", kind: "REJECT_RECOMMENDED" },
  };

  await gate.presentAndAwaitDecision(finalPresentation);
  expect(observed?.rounds.at(-1)).toMatchObject({
    roundNumber: 3,
    recommendation: { triggeredBranch: "CHRONIC_CLAIM" },
  });
  expect(observed?.rounds.at(-1)?.outcome).toBeUndefined();
});

test("supervisor failure still reaches the original Human Gate", async () => {
  const supervisor: Supervisor = { async assess() { throw new Error("JEV unavailable"); } };
  const inner: HumanGate = { async presentAndAwaitDecision() { return response; } };
  const gate = createSupervisedHumanGate(inner, supervisor, options);

  await expect(gate.presentAndAwaitDecision(presentation())).resolves.toBe(response);
  expect(gate.getAccumulatedAssessments()).toEqual([{ unavailable: true, round: 1, reason: "JEV unavailable" }]);
});

test("rendering failure is recorded and still reaches the original Human Gate", async () => {
  const supervisor: Supervisor = {
    async assess() { return { round: 1, flags: [], escalationRecommended: false }; },
  };
  const gate = createSupervisedHumanGate(
    { async presentAndAwaitDecision() { return response; } },
    supervisor,
    { ...options, renderAssessment: async () => { throw new Error("render failed"); } },
  );

  await expect(gate.presentAndAwaitDecision(presentation())).resolves.toBe(response);
  expect(gate.getAccumulatedAssessments()[0]).toMatchObject({ renderingFailure: { reason: "render failed" } });
});

test("JEV cannot change the human response", async () => {
  const supervisor: Supervisor = {
    async assess() {
      return { round: 1, flags: [{ flag: "ABNORMAL_WORKFLOW", detail: "reject", evidenceRounds: [1] }], escalationRecommended: true, escalationReason: "reject" };
    },
  };
  const gate = createSupervisedHumanGate(
    { async presentAndAwaitDecision() { return response; } }, supervisor, options,
  );

  await expect(gate.presentAndAwaitDecision(presentation())).resolves.toBe(response);
});

test("assessment audit records accumulate and serialize", async () => {
  const supervisor: Supervisor = {
    async assess(input) { return { round: input.rounds.length + 1, flags: [], escalationRecommended: false }; },
  };
  const gate = createSupervisedHumanGate(
    { async presentAndAwaitDecision() { return response; } }, supervisor, options,
  );
  await gate.presentAndAwaitDecision(presentation(1));
  await gate.presentAndAwaitDecision(presentation(2));
  const records = gate.getAccumulatedAssessments();

  expect(records).toHaveLength(2);
  expect(JSON.parse(JSON.stringify(records))).toEqual(records);
});

test("original Human Gate failures propagate unchanged", async () => {
  const failure = new Error("human gate failed");
  const gate = createSupervisedHumanGate(
    { async presentAndAwaitDecision() { throw failure; } },
    { async assess() { return { round: 1, flags: [], escalationRecommended: false }; } },
    options,
  );

  await expect(gate.presentAndAwaitDecision(presentation())).rejects.toBe(failure);
});
