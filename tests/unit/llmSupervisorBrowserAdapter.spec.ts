import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import type { ConversationalSiteAdapter, GenerationOutcome, SiteLoadStatus, TurnBaseline } from "../../src/sites/siteTypes";
import type { SupervisorInput } from "../../src/orchestration/supervisor/types";
import { createLlmSupervisorAdapter } from "../../src/orchestration/supervisor/llm/adapter";
import { LlmExecutionManager } from "../../src/orchestration/supervisor/llm/executionManager";
import { buildLlmSupervisorPrompt } from "../../src/orchestration/supervisor/llm/prompt";
import { parseLlmSupervisorResponse } from "../../src/orchestration/supervisor/llm/parser";
import { openDedicatedLlmSession, type LlmSupervisorSession } from "../../src/orchestration/supervisor/llm/session";

const input: SupervisorInput = {
  rounds: [1, 3].map((round) => ({
    roundNumber: round,
    recommendation: {
      round, triggeredBranch: "DEFAULT_CONTINUE", cleanStreak: 0,
      openHighCount: 1, openMediumCount: 0, disputedCount: 0,
      averageConfidence: 0.5, lowConfidenceResolutionCount: 0, invalidReviewStreak: 0,
    },
  })),
  invalidReviewRejectThreshold: 3,
  reopenRejectThreshold: 3,
};

function response(body: unknown): string {
  return `BEGIN_SUPERVISOR_ASSESSMENT\n${JSON.stringify(body)}\nEND_SUPERVISOR_ASSESSMENT`;
}

const validResponse = response({
  flags: [{ flag: "STAGNATION", detail: "Issue count unchanged", evidenceRounds: [1, 3] }],
  escalationRecommended: true,
  escalationReason: "Repeated issue load",
});

interface FakeOptions {
  calls: string[];
  ready?: SiteLoadStatus;
  raw?: unknown;
  start?: "started" | "not_observed";
  completion?: GenerationOutcome;
  throwAt?: "ready" | "baseline" | "send" | "start" | "complete" | "extract";
}

function fakeSite(options: FakeOptions): ConversationalSiteAdapter {
  const baseline: TurnBaseline = { count: 0, ids: new Set() };
  function hit(stage: FakeOptions["throwAt"]): void {
    options.calls.push(stage!);
    if (options.throwAt === stage) throw new Error(`${stage} failed`);
  }
  return {
    name: "chatgpt", url: "https://chatgpt.com/", 
    checkReady: async () => { hit("ready"); return options.ready ?? "ready"; },
    captureTurnBaseline: async () => { hit("baseline"); return baseline; },
    sendPrompt: async (_page, prompt) => { hit("send"); options.calls.push(`prompt:${prompt}`); },
    waitForGenerationStart: async () => { hit("start"); return options.start ?? "started"; },
    waitForGenerationComplete: async (_page, _baseline, timeoutMs) => {
      hit("complete"); options.calls.push(`timeout:${timeoutMs}`);
      return options.completion ?? { outcome: "complete" };
    },
    getLatestAssistantResponse: async () => { hit("extract"); return (options.raw ?? validResponse) as string; },
  };
}

function fakeSession(options: FakeOptions): LlmSupervisorSession {
  const adapter = fakeSite(options);
  return {
    page: {} as Page, adapter,
    checkReady: () => adapter.checkReady({} as Page),
    close: async () => {},
  };
}

test("one browser turn follows existing site-adapter order and returns a grounded assessment", async () => {
  const calls: string[] = [];
  const supervisor = createLlmSupervisorAdapter(fakeSession({ calls }), { generationTimeoutMs: 900 });
  await expect(supervisor.assess(input)).resolves.toEqual({
    round: 3,
    flags: [{ flag: "STAGNATION", detail: "Issue count unchanged", evidenceRounds: [1, 3] }],
    escalationRecommended: true,
    escalationReason: "Repeated issue load",
  });
  expect(calls.filter((call) => !call.startsWith("prompt:") && !call.startsWith("timeout:"))).toEqual([
    "ready", "baseline", "send", "start", "complete", "extract",
  ]);
  expect(calls.find((call) => call.startsWith("timeout:"))).toBe("timeout:900");
  expect(calls.filter((call) => call.startsWith("prompt:"))).toHaveLength(1);
});

test("successful browser assessment preserves the exact prompt, raw response, and validation signals", async () => {
  const calls: string[] = [];
  const session = fakeSession({ calls, raw: validResponse });
  const execution = new LlmExecutionManager(
    createLlmSupervisorAdapter(session, { generationTimeoutMs: 900 }), session,
    { timeoutMs: 1000, recoveryProbe: async () => ({ healthy: true }) },
  );
  const dispatched = execution.dispatch(input);
  expect(dispatched.kind).toBe("dispatched");
  if (dispatched.kind !== "dispatched") throw new Error("expected dispatch");
  await dispatched.completion;
  const record = (await execution.finalizeAudit(100)).llmSupervisorAssessments[0];
  expect(record.status).toBe("resolved");
  expect(record.prompt).toBe(buildLlmSupervisorPrompt(input));
  expect(calls.find((call) => call.startsWith("prompt:"))).toBe(`prompt:${record.prompt}`);
  expect(record.rawResponse).toBe(validResponse);
  expect(record.groundedSignals).toEqual(input.rounds.map((round) => round.recommendation));
  expect(JSON.parse(JSON.stringify(record))).toEqual(record);
});

test("malformed extracted text remains an audit failure with only observed evidence", async () => {
  const raw = "not JSON";
  const session = fakeSession({ calls: [], raw });
  const execution = new LlmExecutionManager(
    createLlmSupervisorAdapter(session, { generationTimeoutMs: 900 }), session,
    { timeoutMs: 1000, recoveryProbe: async () => ({ healthy: true }) },
  );
  const dispatched = execution.dispatch(input);
  expect(dispatched.kind).toBe("dispatched");
  if (dispatched.kind !== "dispatched") throw new Error("expected dispatch");
  await dispatched.completion;
  const record = (await execution.finalizeAudit(100)).llmSupervisorAssessments[0];
  expect(record).toMatchObject({
    status: "unavailable", reason: "invalid supervisor outcome",
    prompt: buildLlmSupervisorPrompt(input), rawResponse: raw,
  });
  expect(record.assessment).toBeUndefined();
  expect(record.groundedSignals).toBeUndefined();
});

test("browser generation timeout never invents a raw response", async () => {
  const calls: string[] = [];
  const session = fakeSession({ calls, completion: { outcome: "timeout" } });
  const execution = new LlmExecutionManager(
    createLlmSupervisorAdapter(session, { generationTimeoutMs: 25 }), session,
    { timeoutMs: 1000, recoveryProbe: async () => ({ healthy: true }) },
  );
  const dispatched = execution.dispatch(input);
  expect(dispatched.kind).toBe("dispatched");
  if (dispatched.kind !== "dispatched") throw new Error("expected dispatch");
  await dispatched.completion;
  const record = (await execution.finalizeAudit(100)).llmSupervisorAssessments[0];
  expect(record).toMatchObject({ status: "unavailable", reason: "llm generation timed out" });
  expect(record.prompt).toBe(buildLlmSupervisorPrompt(input));
  expect(record.rawResponse).toBeUndefined();
  expect(record.groundedSignals).toBeUndefined();
  expect(calls).not.toContain("extract");
});

test("the prompt contains only projected structured input data", () => {
  const widened = {
    ...input,
    secretReviewProse: "DO NOT LEAK THIS REVIEW",
    rounds: input.rounds.map((round) => ({ ...round, secretReviewProse: "PRIVATE CLAIM TEXT" })),
  };
  const prompt = buildLlmSupervisorPrompt(widened);
  expect(prompt).toContain('"roundNumber":3');
  expect(prompt).toContain("advisory only");
  expect(prompt).not.toContain("DO NOT LEAK THIS REVIEW");
  expect(prompt).not.toContain("PRIVATE CLAIM TEXT");
});

test("malformed, ambiguous, and ungrounded responses are unavailable without partial assessment", async () => {
  const malformed = [
    "not JSON",
    response(null),
    response({ flags: [], escalationRecommended: "yes" }),
    response({ flags: [{ flag: "UNKNOWN", detail: "x", evidenceRounds: [1] }], escalationRecommended: false }),
    response({ flags: [{ flag: "STAGNATION", detail: "x", evidenceRounds: [2] }], escalationRecommended: false }),
    `${validResponse}\n${validResponse}`,
  ];
  for (const raw of malformed) {
    const parsed = parseLlmSupervisorResponse(raw, input);
    expect(parsed).toEqual({ kind: "failure", source: "invalid", reason: "invalid supervisor outcome" });
    const supervisor = createLlmSupervisorAdapter(fakeSession({ calls: [], raw }), { generationTimeoutMs: 900 });
    await expect(supervisor.assess(input)).resolves.toEqual({
      unavailable: true, round: 3, reason: "invalid supervisor outcome",
    });
  }
});

test("a well-formed SupervisorUnavailable response follows the failure path", async () => {
  const raw = response({ unavailable: true, round: 3, reason: "model unavailable" });
  expect(parseLlmSupervisorResponse(raw, input)).toEqual({
    kind: "failure", source: "unavailable", reason: "model unavailable",
  });
  const supervisor = createLlmSupervisorAdapter(fakeSession({ calls: [], raw }), { generationTimeoutMs: 900 });
  await expect(supervisor.assess(input)).resolves.toEqual({
    unavailable: true, round: 3, reason: "model unavailable",
  });
});

test("login or unavailable session prevents any prompt dispatch", async () => {
  for (const ready of ["login_required", "unknown_state", "navigation_failed"] as const) {
    const calls: string[] = [];
    const supervisor = createLlmSupervisorAdapter(fakeSession({ calls, ready }), { generationTimeoutMs: 900 });
    await expect(supervisor.assess(input)).resolves.toEqual({
      unavailable: true, round: 3, reason: `llm session unavailable: ${ready}`,
    });
    expect(calls).toEqual(["ready"]);
  }
});

test("site generation timeout returns unavailable and discards partial text", async () => {
  const calls: string[] = [];
  const supervisor = createLlmSupervisorAdapter(fakeSession({
    calls,
    completion: { outcome: "timeout", partialText: "private partial", diagnostics: {
      generationActiveVisible: true, newResponseFound: true, textLength: 15,
      textStableForMs: 0, sendVisible: false,
    } },
  }), { generationTimeoutMs: 25 });
  await expect(supervisor.assess(input)).resolves.toEqual({
    unavailable: true, round: 3, reason: "llm generation timed out",
  });
  expect(calls).not.toContain("extract");
  expect(calls).toContain("timeout:25");
});

test("browser failure at every stage returns unavailable instead of rejecting", async () => {
  for (const throwAt of ["ready", "baseline", "send", "start", "complete", "extract"] as const) {
    const calls: string[] = [];
    const supervisor = createLlmSupervisorAdapter(fakeSession({ calls, throwAt }), { generationTimeoutMs: 900 });
    await expect(supervisor.assess(input)).resolves.toEqual({
      unavailable: true, round: 3, reason: "llm browser operation failed",
    });
    expect(calls).toContain(throwAt);
  }
});

test("new-page session navigates once, reports readiness, and closes idempotently", async () => {
  const calls: string[] = [];
  let closed = false;
  const page = {
    goto: async (url: string, options: { timeout: number }) => { calls.push(`goto:${url}:${options.timeout}`); },
    isClosed: () => closed,
    close: async () => { closed = true; calls.push("close"); },
  } as unknown as Page;
  const session = await openDedicatedLlmSession(
    { newPage: async () => { calls.push("newPage"); return page; } },
    fakeSite({ calls }), 5000,
  );
  expect(await session.checkReady()).toBe("ready");
  await session.close();
  await session.close();
  expect(await session.checkReady()).toBe("unknown_state");
  expect(calls).toEqual(["newPage", "goto:https://chatgpt.com/:5000", "ready", "close"]);
});

test("failed navigation makes the dedicated session unavailable without sending", async () => {
  const calls: string[] = [];
  const page = {
    goto: async () => { throw new Error("navigation failed"); },
    isClosed: () => false,
    close: async () => {},
  } as unknown as Page;
  const session = await openDedicatedLlmSession(
    { newPage: async () => page }, fakeSite({ calls }), 5000,
  );
  expect(await session.checkReady()).toBe("navigation_failed");
  const supervisor = createLlmSupervisorAdapter(session, { generationTimeoutMs: 900 });
  await expect(supervisor.assess(input)).resolves.toEqual({
    unavailable: true, round: 3, reason: "llm session unavailable: navigation_failed",
  });
  expect(calls).toEqual([]);
  await session.close();
});
