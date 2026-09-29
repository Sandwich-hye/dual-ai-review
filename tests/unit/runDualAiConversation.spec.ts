import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import {
  AuditedReviewLoopError,
  runAuditedReviewLoop,
  type AuditedReviewLoopInput,
} from "../../src/orchestration/runAuditedReviewLoop";
import type { AuditedReviewResult, HumanGateRawResponse } from "../../src/orchestration/claims/types";
import type { HumanGate } from "../../src/orchestration/humanGate/humanGate";
import { createDeterministicSupervisor } from "../../src/orchestration/supervisor/deterministicSupervisor";
import { createSupervisedHumanGate } from "../../src/orchestration/supervisor/supervisedHumanGate";
import { SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION } from "../../src/orchestration/supervisor/types";
import { runDualAiConversation } from "../../src/conversation/runDualAiConversation";
import { toJevConvergenceSignal, type ConversationState } from "../../src/conversation/conversationState";
import type { ConversationEvent } from "../../src/conversation/conversationEvents";
import { createTerminalConversationObserver } from "../../src/cli/renderConversationEvent";

const structuredReview = (newClaims: unknown[] = []): string =>
  `BEGIN_STRUCTURED_REVIEW\n${JSON.stringify({
    reviewStatus: "CONTINUE",
    resolvedClaimIds: [],
    resolutionEvidence: {},
    stillOpenClaims: [],
    reopenedClaims: [],
    newClaims,
  })}\nEND_STRUCTURED_REVIEW`;

class FakeAdapter {
  readonly name = "fake";
  readonly url = "fake://site";
  readonly prompts: string[] = [];
  constructor(private readonly responses: string[]) {}
  async checkReady(): Promise<"ready"> { return "ready"; }
  async captureTurnBaseline(): Promise<{ count: number; ids: ReadonlySet<string> }> {
    return { count: this.prompts.length, ids: new Set() };
  }
  async sendPrompt(_page: Page, prompt: string): Promise<void> { this.prompts.push(prompt); }
  async waitForGenerationStart(): Promise<"started"> { return "started"; }
  async waitForGenerationComplete(): Promise<{ outcome: "complete" }> { return { outcome: "complete" }; }
  async getLatestAssistantResponse(): Promise<string> { return this.responses.shift() ?? ""; }
}

function makeInput(decisions: HumanGateRawResponse["requestedOutcome"][] = ["REJECT"]): {
  input: AuditedReviewLoopInput;
  generator: FakeAdapter;
  reviewer: FakeAdapter;
  gateCalls: () => number;
} {
  const generator = new FakeAdapter(["Initial answer", "Revised answer"]);
  const reviewer = new FakeAdapter([
    structuredReview([{ severity: "HIGH", statement: "The answer lacks a guard", rationale: "A null input can throw." }]),
    structuredReview(),
  ]);
  let calls = 0;
  const humanGate: HumanGate = {
    async presentAndAwaitDecision() {
      const requestedOutcome = decisions[calls++];
      if (!requestedOutcome) throw new Error("No scripted human decision");
      return {
        requestedOutcome,
        ...(requestedOutcome === "REJECT" ? { rationale: "Human chose to reject." } : {}),
        decidedAt: "2026-09-24T00:00:00.000Z",
      };
    },
  };
  return {
    input: {
      originalTask: "Explain the task accurately.",
      options: { hardMaxRounds: 5, recommendedMaxRounds: 4 },
      chatgpt: { page: {} as Page, adapter: generator },
      claude: { page: {} as Page, adapter: reviewer },
      humanGate,
    },
    generator, reviewer,
    gateCalls: () => calls,
  };
}

async function oldSupervisedSmokeComposition(input: AuditedReviewLoopInput) {
  const supervisedGate = createSupervisedHumanGate(
    input.humanGate,
    createDeterministicSupervisor(),
    { invalidReviewRejectThreshold: 3, reopenRejectThreshold: 3 },
  );
  const base = await runAuditedReviewLoop({ ...input, humanGate: supervisedGate });
  return {
    schemaVersion: SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION,
    base,
    supervisorAssessments: supervisedGate.getAccumulatedAssessments(),
  };
}

function withoutClockFields(result: AuditedReviewResult): unknown {
  return {
    ...result,
    initial: { ...result.initial, startedAt: "", completedAt: "" },
    runAuditTrail: result.runAuditTrail.map((event) => ({ ...event, recordedAt: "" })),
  };
}

test("new entry point matches the existing supervised smoke composition", async () => {
  const oldRun = makeInput(["CONTINUE", "REJECT"]);
  const newRun = makeInput(["CONTINUE", "REJECT"]);
  const oldResult = await oldSupervisedSmokeComposition(oldRun.input);
  const newResult = await runDualAiConversation(newRun.input);

  expect(newResult.review.schemaVersion).toBe(oldResult.schemaVersion);
  expect(withoutClockFields(newResult.review.base)).toEqual(withoutClockFields(oldResult.base));
  expect(newResult.review.supervisorAssessments).toEqual(oldResult.supervisorAssessments);
  expect(newRun.generator.prompts).toEqual(oldRun.generator.prompts);
  expect(newRun.reviewer.prompts).toEqual(oldRun.reviewer.prompts);
  expect(newRun.gateCalls()).toBe(oldRun.gateCalls());
  expect(newResult.lifecycle).toMatchObject({ schemaVersion: 1, roundsCompleted: 2, terminalOutcome: "REJECTED" });
});

test("observers have no decision authority and cannot break the Human Gate", async () => {
  const run = makeInput(["REJECT"]);
  const states: ConversationState[] = [];
  const result = await runDualAiConversation({
    ...run.input,
    onStateChange(state) {
      states.push(state);
      if (state.status === "awaiting_human") {
        Object.assign(state, { status: "complete", humanRequestedOutcome: "ACCEPT" });
      }
      if (state.status === "human_decision_submitted") return Promise.reject(new Error("renderer rejected"));
    },
  });

  expect(states.map((state) => state.status)).toEqual(["awaiting_human", "human_decision_submitted", "complete"]);
  expect(states.map((state) => state.roundsCompleted)).toEqual([0, 0, 1]);
  expect(states[0].latestJevSignal).toMatchObject({ available: true, riskLevel: "none", flags: [] });
  expect(result.review.base.outcome).toBe("REJECTED");
  expect(result.review.base.rounds[0].humanDecision.raw.requestedOutcome).toBe("REJECT");
  expect(result.review.base.rounds[0].humanDecision.outcome).toBe("REJECT");
  expect(run.gateCalls()).toBe(1);
});

test("existing audit schemas and supervisor assessment count remain intact", async () => {
  const run = makeInput(["CONTINUE", "REJECT"]);
  const result = await runDualAiConversation(run.input);
  const base = result.review.base;

  expect(result.review.supervisorAssessments).toHaveLength(base.rounds.length);
  expect(base.schemaVersion).toBe(1);
  expect(base.rounds.every((round) => round.schemaVersion === 1 && round.humanDecision.schemaVersion === 1)).toBe(true);
  expect(base.rounds[0].generatorResponse).toBe("Revised answer");
  expect(base.rounds[1].generatorResponse).toBeUndefined();
  expect(base.outcomeOrigin).toBe("HUMAN_OVERRODE_RECOMMENDATION");
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});

test("a failing underlying adapter still propagates the existing audited-loop error", async () => {
  const run = makeInput();
  run.generator.checkReady = async () => { throw new Error("site unavailable"); };
  await expect(runDualAiConversation(run.input)).rejects.toMatchObject({
    name: AuditedReviewLoopError.name,
    stage: { round: 0, turn: "initial", site: "chatgpt", step: "readiness" },
  });
  expect(run.gateCalls()).toBe(0);
});

test("JEV lifecycle signal only relabels existing advisory assessments", () => {
  expect(toJevConvergenceSignal({ unavailable: true, round: 1, reason: "browser unavailable" })).toEqual({
    available: false, reason: "browser unavailable",
  });
  const assessment = {
    round: 2,
    flags: [{ flag: "STAGNATION" as const, detail: "No progress", evidenceRounds: [1, 2] }],
    escalationRecommended: true,
  };
  const signal = toJevConvergenceSignal(assessment);
  expect(signal).toEqual({ available: true, flags: ["STAGNATION"], riskLevel: "elevated", detail: ["No progress"] });
  expect(assessment).toEqual({
    round: 2,
    flags: [{ flag: "STAGNATION", detail: "No progress", evidenceRounds: [1, 2] }],
    escalationRecommended: true,
  });
});

test("conversation events follow the existing two-round lifecycle in deterministic order", async () => {
  const run = makeInput(["CONTINUE", "REJECT"]);
  const events: ConversationEvent[] = [];
  const result = await runDualAiConversation({
    ...run.input,
    eventObserver: { onEvent: (event) => { events.push(event); } },
  });

  expect(events.map((event) => event.type)).toEqual([
    "conversation_started",
    "generator_completed",
    "round_started",
    "reviewer_completed",
    "jev_advisory_generated",
    "human_gate_waiting",
    "generator_completed",
    "round_started",
    "reviewer_completed",
    "jev_advisory_generated",
    "human_gate_waiting",
    "conversation_completed",
  ]);
  expect(events.map((event) => event.sequence)).toEqual(Array.from({ length: events.length }, (_, index) => index + 1));
  expect(events.filter((event) => event.type === "round_started").map((event) => event.round)).toEqual([1, 2]);
  expect(events.filter((event) => event.type === "generator_completed").map((event) => event.round)).toEqual([0, 1]);
  expect(events.filter((event) => event.type === "reviewer_completed").map((event) => event.round)).toEqual([1, 2]);
  expect(events.filter((event) => event.type === "jev_advisory_generated").map((event) => event.signal)).toEqual(
    result.review.supervisorAssessments.map(toJevConvergenceSignal),
  );
  expect(events.at(-1)).toMatchObject({ type: "conversation_completed", roundsCompleted: 2, outcome: "REJECTED" });
});

test("event observation does not change the existing audit or outcome", async () => {
  const plain = makeInput(["CONTINUE", "REJECT"]);
  const observed = makeInput(["CONTINUE", "REJECT"]);
  const plainResult = await runDualAiConversation(plain.input);
  const observedResult = await runDualAiConversation({
    ...observed.input,
    eventObserver: { onEvent: () => undefined },
  });

  expect(withoutClockFields(observedResult.review.base)).toEqual(withoutClockFields(plainResult.review.base));
  expect(observedResult.review.supervisorAssessments).toEqual(plainResult.review.supervisorAssessments);
  expect(observedResult.review.base.rounds).toEqual(plainResult.review.base.rounds);
  expect(observedResult.review.base.runAuditTrail.map(({ recordedAt, ...event }) => event)).toEqual(
    plainResult.review.base.runAuditTrail.map(({ recordedAt, ...event }) => event),
  );
  expect(observed.gateCalls()).toBe(plain.gateCalls());
});

test("throwing, rejecting, and mutating event observers cannot affect a human decision", async () => {
  const run = makeInput(["REJECT"]);
  const seen: string[] = [];
  const result = await runDualAiConversation({
    ...run.input,
    eventObserver: {
      onEvent(event) {
        seen.push(event.type);
        if (event.type === "conversation_started") throw new Error("observer threw");
        if (event.type === "reviewer_completed") return Promise.reject(new Error("observer rejected"));
        if (event.type === "human_gate_waiting") Object.assign(event, { recommendationKind: "ACCEPT_RECOMMENDED" });
      },
    },
  });

  expect(seen).toContain("conversation_completed");
  expect(result.review.base.outcome).toBe("REJECTED");
  expect(result.review.base.rounds[0].humanDecision.raw.requestedOutcome).toBe("REJECT");
  expect(run.gateCalls()).toBe(1);
});

test("a failed extraction never emits a completed turn or conversation", async () => {
  const run = makeInput();
  run.generator.getLatestAssistantResponse = async () => { throw new Error("extract failed"); };
  const events: ConversationEvent[] = [];
  await expect(runDualAiConversation({
    ...run.input,
    eventObserver: { onEvent: (event) => { events.push(event); } },
  })).rejects.toBeInstanceOf(AuditedReviewLoopError);
  expect(events.map((event) => event.type)).toEqual(["conversation_started"]);
  expect(run.gateCalls()).toBe(0);
});

test("terminal lifecycle rendering preserves the old audited outcome and audit records", async () => {
  const baseline = makeInput(["CONTINUE", "REJECT"]);
  const displayed = makeInput(["CONTINUE", "REJECT"]);
  const oldResult = await oldSupervisedSmokeComposition(baseline.input);
  const lines: string[] = [];
  const newResult = await runDualAiConversation({
    ...displayed.input,
    eventObserver: createTerminalConversationObserver((line) => { lines.push(line); }),
  });

  expect(withoutClockFields(newResult.review.base)).toEqual(withoutClockFields(oldResult.base));
  expect(newResult.review.supervisorAssessments).toEqual(oldResult.supervisorAssessments);
  expect(displayed.gateCalls()).toBe(baseline.gateCalls());
  expect(lines).toHaveLength(12);
  expect(lines[0]).toBe("[Conversation] Started.");
  expect(lines.at(-1)).toContain("Completed: REJECTED after 2 rounds");
});
