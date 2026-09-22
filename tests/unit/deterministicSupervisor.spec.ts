import { test, expect } from "@playwright/test";
import { createDeterministicSupervisor } from "../../src/orchestration/supervisor/deterministicSupervisor";
import { evaluateSupervisorState } from "../../src/orchestration/supervisor/supervisorEngine";
import type { SupervisorInput } from "../../src/orchestration/supervisor/types";

const input: SupervisorInput = {
  rounds: [{
    roundNumber: 1,
    recommendation: {
      round: 1,
      triggeredBranch: "DEFAULT_CONTINUE",
      cleanStreak: 0,
      openHighCount: 1,
      openMediumCount: 0,
      disputedCount: 0,
      averageConfidence: 0.5,
      lowConfidenceResolutionCount: 0,
      invalidReviewStreak: 0,
    },
  }],
  invalidReviewRejectThreshold: 3,
  reopenRejectThreshold: 3,
};

test("deterministic supervisor factory delegates to evaluateSupervisorState", async () => {
  const supervisor = createDeterministicSupervisor();
  await expect(supervisor.assess(input)).resolves.toEqual(evaluateSupervisorState(input));
});
