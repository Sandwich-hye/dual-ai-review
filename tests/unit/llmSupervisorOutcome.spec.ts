import { expect, test } from "@playwright/test";
import { raceWithTimeout } from "../../src/orchestration/supervisor/llmSupervisorOutcome";
import type { SupervisorAssessment, SupervisorUnavailable } from "../../src/orchestration/supervisor/types";

const assessment: SupervisorAssessment = {
  round: 1,
  flags: [],
  escalationRecommended: false,
};

test("a resolved SupervisorUnavailable takes the failure path", async () => {
  const unavailable: SupervisorUnavailable = { unavailable: true, round: 1, reason: "login expired" };
  await expect(raceWithTimeout(Promise.resolve(unavailable), 100)).resolves.toEqual({
    kind: "rejected",
    error: "login expired",
  });
});

test("a rejected adapter call takes the same failure path", async () => {
  const failure = new Error("adapter failed");
  await expect(raceWithTimeout(Promise.reject(failure), 100)).resolves.toEqual({
    kind: "rejected",
    error: failure,
  });
});

test("timeout keeps the operation pending and classifies late unavailability as failure", async () => {
  let settle!: (value: SupervisorAssessment | SupervisorUnavailable) => void;
  const real = new Promise<SupervisorAssessment | SupervisorUnavailable>((resolve) => { settle = resolve; });
  const outcome = await raceWithTimeout(real, 0);
  expect(outcome.kind).toBe("timeout");
  if (outcome.kind !== "timeout") throw new Error("expected timeout");

  settle({ unavailable: true, round: 1, reason: "session lost" });
  await expect(outcome.awaitRealSettlement()).resolves.toEqual({
    kind: "rejected",
    error: "session lost",
  });
});

test("a normal SupervisorAssessment remains a success", async () => {
  await expect(raceWithTimeout(Promise.resolve(assessment), 100)).resolves.toEqual({
    kind: "resolved",
    value: assessment,
  });
});
