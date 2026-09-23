import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import type { ConversationalSiteAdapter } from "../../src/sites/siteTypes";
import type { HumanGatePresentation, HumanGateRawResponse } from "../../src/orchestration/humanGate/humanGate";
import { runAuditedReviewLoop } from "../../src/orchestration/runAuditedReviewLoop";
import { createDeterministicSupervisor } from "../../src/orchestration/supervisor/deterministicSupervisor";
import { createSupervisedHumanGate } from "../../src/orchestration/supervisor/supervisedHumanGate";
import type { Supervisor, SupervisorAssessment, SupervisorInput, SupervisedReviewResult } from "../../src/orchestration/supervisor/types";
import { createAugmentedSupervisor } from "../../src/orchestration/supervisor/llm/augmentedSupervisor";
import { LlmExecutionManager } from "../../src/orchestration/supervisor/llm/executionManager";
import type { LlmSupervisorSession } from "../../src/orchestration/supervisor/llm/session";

const input = (round = 1): SupervisorInput => ({
  rounds: [{
    roundNumber: round,
    recommendation: {
      round, triggeredBranch: "DEFAULT_CONTINUE", cleanStreak: 0,
      openHighCount: 1, openMediumCount: 0, disputedCount: 0,
      averageConfidence: 0.4, lowConfidenceResolutionCount: 0, invalidReviewStreak: 0,
    },
  }],
  invalidReviewRejectThreshold: 3,
  reopenRejectThreshold: 3,
});

const deterministicAssessment: SupervisorAssessment = {
  round: 1,
  flags: [{ flag: "STAGNATION", detail: "deterministic concern", evidenceRounds: [1] }],
  escalationRecommended: true,
  escalationReason: "deterministic escalation",
};
const llmAssessment: SupervisorAssessment = {
  round: 1,
  flags: [{ flag: "ABNORMAL_WORKFLOW", detail: "LLM-only concern", evidenceRounds: [1] }],
  escalationRecommended: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeManager(llm: Supervisor, options: { timeoutMs?: number; checkReady?: LlmSupervisorSession["checkReady"] } = {}) {
  const session: LlmSupervisorSession = {
    page: {} as Page,
    adapter: {} as ConversationalSiteAdapter,
    checkReady: options.checkReady ?? (async () => "ready"),
    close: async () => {},
  };
  return new LlmExecutionManager(llm, session, {
    timeoutMs: options.timeoutMs ?? 1000,
    recoveryProbe: async () => ({ healthy: true }),
  });
}

const humanResponse: HumanGateRawResponse = {
  requestedOutcome: "ACCEPT", rationale: "human choice", decidedAt: "2026-09-23T00:00:00.000Z",
};

function presentation(round = 1): HumanGatePresentation {
  return {
    round,
    currentAnswer: "answer",
    recommendation: {
      kind: "CONTINUE_RECOMMENDED", triggeredBranch: "DEFAULT_CONTINUE", round,
      reason: "continue", cleanStreak: 0, openHighCount: 1, openMediumCount: 0,
      disputedCount: 0, averageConfidence: 0.4, lowConfidenceResolutionCount: 0,
      invalidReviewStreak: 0,
    },
    disputedClaims: [], claimLedgerDelta: [], relevantEvidence: [],
    legalOutcomes: ["CONTINUE", "ACCEPT", "REJECT"],
  };
}

test("deterministic result is returned by identity; LLM success stays in its own audit record", async () => {
  const manager = makeManager({ assess: async () => llmAssessment });
  const augmented = createAugmentedSupervisor(
    { assess: async () => deterministicAssessment }, manager, { trigger: { kind: "every-round" } },
  );
  const actual = await augmented.assess(input());
  expect(actual).toBe(deterministicAssessment);
  expect(actual).toEqual({
    ...deterministicAssessment,
    flags: deterministicAssessment.flags,
    escalationRecommended: true,
  });
  const audit = await augmented.finalizeAudit(100);
  expect(audit.llmSupervisorAssessments).toHaveLength(1);
  expect(audit.llmSupervisorAssessments[0]).toMatchObject({
    status: "resolved", assessment: llmAssessment, dispatchedAt: expect.any(String),
  });
  expect((actual as SupervisorAssessment).flags).not.toContainEqual(llmAssessment.flags[0]);
  expect((actual as SupervisorAssessment).escalationRecommended).toBe(true);
});

test("default trigger is gated by deterministic flags, not LLM interest", async () => {
  let llmCalls = 0;
  const manager = makeManager({ assess: async () => { llmCalls += 1; return llmAssessment; } });
  const clean: SupervisorAssessment = { round: 1, flags: [], escalationRecommended: false };
  const augmented = createAugmentedSupervisor({ assess: async () => clean }, manager);
  expect(await augmented.assess(input())).toBe(clean);
  expect((await augmented.finalizeAudit(100)).llmSupervisorAssessments).toEqual([]);
  expect(llmCalls).toBe(0);
});

test("deterministic rejection propagates unchanged and never dispatches the LLM", async () => {
  let llmCalls = 0;
  const failure = new Error("deterministic failed");
  const augmented = createAugmentedSupervisor(
    { assess: async () => { throw failure; } },
    makeManager({ assess: async () => { llmCalls += 1; return llmAssessment; } }),
    { trigger: { kind: "every-round" } },
  );
  await expect(augmented.assess(input())).rejects.toBe(failure);
  expect(llmCalls).toBe(0);
  expect((await augmented.finalizeAudit(100)).llmSupervisorAssessments).toEqual([]);
});

test("LLM rejection cannot change the existing HumanGate assessment or decision", async () => {
  const manager = makeManager({ assess: async () => { throw new Error("LLM unavailable"); } });
  const augmented = createAugmentedSupervisor(
    { assess: async () => deterministicAssessment }, manager, { trigger: { kind: "every-round" } },
  );
  let rendered: unknown;
  let received: HumanGatePresentation | undefined;
  const gate = createSupervisedHumanGate(
    { async presentAndAwaitDecision(value) { received = value; return humanResponse; } },
    augmented,
    { invalidReviewRejectThreshold: 3, reopenRejectThreshold: 3, renderAssessment: (assessment) => { rendered = assessment; } },
  );
  const value = presentation();
  await expect(gate.presentAndAwaitDecision(value)).resolves.toBe(humanResponse);
  expect(received).toBe(value);
  expect(rendered).toBe(deterministicAssessment);
  expect(gate.getAccumulatedAssessments()).toEqual([deterministicAssessment]);
  const audit = await augmented.finalizeAudit(100);
  expect(audit.llmSupervisorAssessments[0]).toMatchObject({ status: "unavailable", reason: "LLM unavailable" });
  expect(audit.llmSupervisorAssessments[0].assessment).toBeUndefined();
});

test("LLM timeout does not delay HumanGate or change the human choice", async () => {
  const pending = deferred<SupervisorAssessment>();
  const manager = makeManager({ assess: () => pending.promise }, { timeoutMs: 5 });
  const augmented = createAugmentedSupervisor(
    { assess: async () => deterministicAssessment }, manager, { trigger: { kind: "every-round" } },
  );
  let humanCalls = 0;
  const gate = createSupervisedHumanGate(
    { async presentAndAwaitDecision() { humanCalls += 1; return humanResponse; } },
    augmented,
    { invalidReviewRejectThreshold: 3, reopenRejectThreshold: 3, renderAssessment: () => {} },
  );
  await expect(gate.presentAndAwaitDecision(presentation())).resolves.toBe(humanResponse);
  expect(humanCalls).toBe(1);
  expect(gate.getAccumulatedAssessments()).toEqual([deterministicAssessment]);
  const audit = await augmented.finalizeAudit(10);
  expect(audit.llmAuditFinalization.status).toBe("incomplete");
  expect(audit.llmSupervisorAssessments[0].status).toMatch(/pending|timed_out/);
  pending.resolve(llmAssessment);
});

test("degraded LLM session skips later triggered rounds without changing deterministic results", async () => {
  const recoveryEntered = deferred<void>();
  let llmCalls = 0;
  const manager = makeManager(
    { assess: async () => { llmCalls += 1; return { unavailable: true, round: 1, reason: "session lost" }; } },
    { checkReady: async () => { recoveryEntered.resolve(); return "login_required"; } },
  );
  const deterministic: Supervisor = {
    async assess(value) { return { ...deterministicAssessment, round: value.rounds.at(-1)!.roundNumber }; },
  };
  const augmented = createAugmentedSupervisor(deterministic, manager, { trigger: { kind: "every-round" } });
  expect(await augmented.assess(input(1))).toMatchObject({ round: 1, escalationRecommended: true });
  await recoveryEntered.promise;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(await augmented.assess(input(2))).toMatchObject({ round: 2, escalationRecommended: true });
  const audit = await augmented.finalizeAudit(100);
  expect(llmCalls).toBe(1);
  expect(audit.llmSupervisorAssessments.map((record) => record.status)).toEqual(["unavailable", "skipped"]);
  expect(audit.llmSessionStatus).toMatchObject({
    status: "degraded", sinceRound: 1, triggeringRecordId: audit.llmSupervisorAssessments[0].id,
  });
});

test("overlapping LLM triggers are skipped and audited without delaying deterministic assessment", async () => {
  const pending = deferred<SupervisorAssessment>();
  let calls = 0;
  const manager = makeManager({ assess: () => { calls += 1; return pending.promise; } });
  const augmented = createAugmentedSupervisor(
    { assess: async () => deterministicAssessment }, manager, { trigger: { kind: "every-round" } },
  );
  expect(await augmented.assess(input())).toBe(deterministicAssessment);
  expect(await augmented.assess(input())).toBe(deterministicAssessment);
  pending.resolve(llmAssessment);
  const audit = await augmented.finalizeAudit(100);
  expect(calls).toBe(1);
  expect(audit.llmSupervisorAssessments.map((record) => record.status)).toEqual(["resolved", "skipped"]);
});

test("final 6B audit is JSON serializable and preserves the 6A base outcome", async () => {
  const review = `BEGIN_STRUCTURED_REVIEW\n${JSON.stringify({
    reviewStatus: "CONTINUE", resolvedClaimIds: [], resolutionEvidence: {},
    stillOpenClaims: [], reopenedClaims: [], newClaims: [{
      severity: "HIGH", statement: "A material claim", rationale: "Needs support",
    }],
  })}\nEND_STRUCTURED_REVIEW`;
  const site = (responses: string[]): ConversationalSiteAdapter => {
    const queue = [...responses];
    return {
      name: "fake", url: "fake://site", checkReady: async () => "ready",
      captureTurnBaseline: async () => ({ count: 0, ids: new Set() }),
      sendPrompt: async () => {}, waitForGenerationStart: async () => "started",
      waitForGenerationComplete: async () => ({ outcome: "complete" }),
      getLatestAssistantResponse: async () => queue.shift() ?? "",
    };
  };
  const manager = makeManager({ assess: async (value) => ({ ...llmAssessment, round: value.rounds.at(-1)!.roundNumber }) });
  const augmented = createAugmentedSupervisor(createDeterministicSupervisor(), manager, { trigger: { kind: "every-round" } });
  const gate = createSupervisedHumanGate(
    { async presentAndAwaitDecision() { return humanResponse; } }, augmented,
    { invalidReviewRejectThreshold: 3, reopenRejectThreshold: 3, renderAssessment: () => {} },
  );
  const base = await runAuditedReviewLoop({
    originalTask: "Explain the task accurately.",
    chatgpt: { page: {} as Page, adapter: site(["G0", "G1"]) },
    claude: { page: {} as Page, adapter: site([review]) },
    humanGate: gate,
    options: { hardMaxRounds: 5, recommendedMaxRounds: 4 },
  });
  const supervised: SupervisedReviewResult = {
    schemaVersion: 1, base, supervisorAssessments: gate.getAccumulatedAssessments(),
  };
  const result = await augmented.finalizeResult(supervised, 100);
  expect(result.schemaVersion).toBe(2);
  expect(result.base).toEqual(base);
  expect(result.base.outcome).toBe("ACCEPTED");
  expect(result.base.rounds[0].humanDecision.outcome).toBe("ACCEPT");
  expect(result.supervisorAssessments).toEqual(supervised.supervisorAssessments);
  expect(result.llmSupervisorAssessments[0]).toMatchObject({ status: "resolved", assessment: llmAssessment });
  expect(result.llmAuditFinalization.status).toBe("complete");
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  expect(Object.isFrozen(result)).toBe(true);
});
