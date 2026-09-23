import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import type { ConversationalSiteAdapter, SiteLoadStatus } from "../../src/sites/siteTypes";
import type { Supervisor, SupervisorAssessment, SupervisorInput, SupervisorUnavailable } from "../../src/orchestration/supervisor/types";
import { LlmExecutionManager, type LlmDispatchResult } from "../../src/orchestration/supervisor/llm/executionManager";
import { LlmPageLeaseGate } from "../../src/orchestration/supervisor/llm/lease";
import type { LlmSupervisorSession } from "../../src/orchestration/supervisor/llm/session";

const assessment: SupervisorAssessment = { round: 1, flags: [], escalationRecommended: false };
const input: SupervisorInput = {
  rounds: [{
    roundNumber: 1,
    recommendation: {
      round: 1, triggeredBranch: "DEFAULT_CONTINUE", cleanStreak: 0,
      openHighCount: 0, openMediumCount: 0, disputedCount: 0,
      averageConfidence: 0.5, lowConfidenceResolutionCount: 0, invalidReviewStreak: 0,
    },
  }],
  invalidReviewRejectThreshold: 3,
  reopenRejectThreshold: 3,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeSession(checkReady: () => Promise<SiteLoadStatus> = async () => "ready"): LlmSupervisorSession {
  return {
    page: {} as Page,
    adapter: {} as ConversationalSiteAdapter,
    checkReady,
    close: async () => {},
  };
}

function manager(supervisor: Supervisor, session = fakeSession(), timeoutMs = 1000) {
  return new LlmExecutionManager(supervisor, session, {
    timeoutMs,
    recoveryProbe: async () => ({ healthy: true }),
  });
}

function started(result: LlmDispatchResult): Extract<LlmDispatchResult, { kind: "dispatched" }> {
  expect(result.kind).toBe("dispatched");
  if (result.kind !== "dispatched") throw new Error("expected dispatch");
  return result;
}

test("a concurrent trigger is recorded as skipped until the owner completes", async () => {
  const call = deferred<SupervisorAssessment>();
  let calls = 0;
  const execution = manager({ assess: () => { calls += 1; return calls === 1 ? call.promise : Promise.resolve(assessment); } });
  const first = started(execution.dispatch(input));
  const second = execution.dispatch(input);
  expect(second).toMatchObject({ kind: "skipped", reason: `llm leg busy with record ${first.recordId}` });
  expect(calls).toBeLessThanOrEqual(1);
  call.resolve(assessment);
  await first.completion;
  const third = started(execution.dispatch(input));
  await third.completion;
  const audit = await execution.finalizeAudit(100);
  expect(audit.llmSupervisorAssessments.map((record) => record.status)).toEqual(["resolved", "skipped", "resolved"]);
  expect(new Set(audit.llmSupervisorAssessments.map((record) => record.id)).size).toBe(3);
});

test("only the current token can release a page lease", async () => {
  const gate = new LlmPageLeaseGate();
  const old = gate.acquire("llm-1", 1, Promise.resolve())!;
  expect(gate.releaseIfOwner(old)).toBe(true);
  const current = gate.acquire("llm-2", 1, Promise.resolve())!;
  expect(current).not.toBe(old);
  expect(gate.releaseIfOwner(old)).toBe(false);
  expect(gate.setPhaseIfOwner(old, "recovery")).toBe(false);
  expect(gate.active?.token).toBe(current);
  expect(gate.releaseIfOwner(current)).toBe(true);
  expect(gate.active).toBeUndefined();
});

test("timeout retains the lease and records a late success before release", async () => {
  const call = deferred<SupervisorAssessment>();
  const execution = manager({ assess: () => call.promise }, fakeSession(), 5);
  const attempt = started(execution.dispatch(input));
  await expect(attempt.firstOutcome).resolves.toEqual({ kind: "timeout", timeoutMs: 5 });
  expect(execution.inspectRecord(attempt.recordId)).toMatchObject({ status: "timed_out", reason: "exceeded 5ms" });
  expect(execution.inspectRecord(attempt.recordId)?.rawResponse).toBeUndefined();
  expect(execution.dispatch(input).kind).toBe("skipped");
  call.resolve(assessment);
  await attempt.completion;
  const audit = await execution.finalizeAudit(100);
  expect(audit.llmSupervisorAssessments[0]).toMatchObject({
    status: "timed_out", lateResolution: { kind: "success", assessment },
  });
  expect(audit.llmSupervisorAssessments[0].rawResponse).toBeUndefined();
  expect(audit.llmAuditFinalization.status).toBe("complete");
  expect(audit.llmSessionStatus.status).toBe("ready");
});

test("late rejection stays observed and holds the lease through recovery", async () => {
  const call = deferred<SupervisorAssessment>();
  const readiness = deferred<SiteLoadStatus>();
  const enteredRecovery = deferred<void>();
  const session = fakeSession(() => { enteredRecovery.resolve(); return readiness.promise; });
  const execution = manager({ assess: () => call.promise }, session, 5);
  const attempt = started(execution.dispatch(input));
  await attempt.firstOutcome;
  call.reject(new Error("late adapter failure"));
  await enteredRecovery.promise;
  expect(execution.dispatch(input).kind).toBe("skipped");
  readiness.resolve("ready");
  await attempt.completion;
  const audit = await execution.finalizeAudit(100);
  expect(audit.llmSupervisorAssessments[0]).toMatchObject({
    status: "timed_out", lateResolution: { kind: "failure", reason: "late adapter failure" },
  });
  expect(audit.llmSessionStatus.status).toBe("ready");
});

test("resolved SupervisorUnavailable follows failure recovery and degrades an unhealthy session", async () => {
  const unavailable: SupervisorUnavailable = { unavailable: true, round: 1, reason: "login expired" };
  let checks = 0;
  const session = fakeSession(async () => { checks += 1; return "login_required"; });
  const execution = manager({ assess: async () => unavailable }, session);
  const attempt = started(execution.dispatch(input));
  await expect(attempt.firstOutcome).resolves.toEqual({
    kind: "failure", source: "unavailable", reason: "login expired",
  });
  await attempt.completion;
  const skipped = execution.dispatch(input);
  expect(skipped).toMatchObject({ kind: "skipped", reason: "llm session degraded: recovery checkReady: login_required" });
  const audit = await execution.finalizeAudit(100);
  expect(checks).toBe(1);
  expect(audit.llmSupervisorAssessments.map((record) => record.status)).toEqual(["unavailable", "skipped"]);
  expect(audit.llmSessionStatus).toEqual({
    status: "degraded", detail: "recovery checkReady: login_required",
    sinceRound: 1, triggeringRecordId: attempt.recordId,
  });
});

test("a rejected or synchronously throwing adapter becomes a non-rejecting failure", async () => {
  for (const assess of [
    () => Promise.reject(new Error("adapter rejected")),
    () => { throw new Error("adapter threw"); },
  ]) {
    const execution = manager({ assess });
    const attempt = started(execution.dispatch(input));
    const first = await attempt.firstOutcome;
    expect(first).toMatchObject({ kind: "failure", source: "rejected" });
    await expect(attempt.completion).resolves.toBeUndefined();
    const audit = await execution.finalizeAudit(100);
    expect(audit.llmSupervisorAssessments[0].status).toBe("unavailable");
  }
});

test("malformed fulfilled adapter values fail with a stable content-independent reason", async () => {
  for (const value of [null, 5, { round: 2, flags: [], escalationRecommended: false }]) {
    const execution = manager({ assess: async () => value as SupervisorAssessment });
    const attempt = started(execution.dispatch(input));
    await expect(attempt.firstOutcome).resolves.toEqual({
      kind: "failure", source: "invalid", reason: "invalid supervisor outcome",
    });
    await attempt.completion;
    expect((await execution.finalizeAudit(100)).llmSupervisorAssessments[0]).toMatchObject({
      status: "unavailable", reason: "invalid supervisor outcome",
    });
  }
});

test("finalization waits for the real operation and seals a complete immutable audit", async () => {
  const call = deferred<SupervisorAssessment>();
  const execution = manager({ assess: () => call.promise });
  const attempt = started(execution.dispatch(input));
  const finalizing = execution.finalizeAudit(200);
  expect(execution.dispatch(input)).toEqual({ kind: "skipped", reason: "llm audit finalizing" });
  const race = await Promise.race([finalizing.then(() => "finalized"), new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 10))]);
  expect(race).toBe("waiting");
  call.resolve(assessment);
  await attempt.completion;
  const audit = await finalizing;
  expect(audit.llmAuditFinalization.status).toBe("complete");
  expect(audit.llmSupervisorAssessments).toHaveLength(1);
  expect(Object.isFrozen(audit)).toBe(true);
  expect(Object.isFrozen(audit.llmSupervisorAssessments[0])).toBe(true);
  expect(await execution.finalizeAudit(200)).toBe(audit);
});

test("unsettled operation produces an incomplete, sealed audit without inventing success", async () => {
  const call = deferred<SupervisorAssessment>();
  const execution = manager({ assess: () => call.promise }, fakeSession(), 1);
  const attempt = started(execution.dispatch(input));
  await attempt.firstOutcome;
  const audit = await execution.finalizeAudit(5);
  expect(audit.llmAuditFinalization).toMatchObject({
    status: "incomplete", activeRecordId: attempt.recordId, phase: "operation",
    reason: "finalization_deadline_exceeded",
  });
  expect(audit.llmSupervisorAssessments[0]).toMatchObject({
    status: "timed_out", finalizationIncomplete: { phase: "operation" },
  });
  expect(audit.llmSupervisorAssessments[0].lateResolution).toBeUndefined();
  expect(audit.llmSessionStatus).toMatchObject({
    status: "degraded", triggeringRecordId: attempt.recordId,
  });
  const serialized = JSON.stringify(audit);
  expect(execution.dispatch(input).kind).toBe("skipped");
  call.resolve(assessment);
  await attempt.completion;
  expect(JSON.stringify(audit)).toBe(serialized);
  expect(await execution.finalizeAudit(5)).toBe(audit);
});

test("finalization may expire before the per-call timeout without claiming an outcome", async () => {
  const call = deferred<SupervisorAssessment>();
  const execution = manager({ assess: () => call.promise }, fakeSession(), 100);
  const attempt = started(execution.dispatch(input));
  const audit = await execution.finalizeAudit(5);
  expect(audit.llmAuditFinalization).toMatchObject({ status: "incomplete", phase: "operation" });
  expect(audit.llmSupervisorAssessments[0]).toMatchObject({
    status: "pending", finalizationIncomplete: { phase: "operation" },
  });
  expect(audit.llmSupervisorAssessments[0].assessment).toBeUndefined();
  const serialized = JSON.stringify(audit);
  call.reject(new Error("late failure after seal"));
  await attempt.completion;
  expect(JSON.stringify(audit)).toBe(serialized);
});

test("finalization waits for recovery even after a failure record is already written", async () => {
  const readiness = deferred<SiteLoadStatus>();
  const enteredRecovery = deferred<void>();
  const session = fakeSession(() => { enteredRecovery.resolve(); return readiness.promise; });
  const execution = manager({ assess: async () => { throw new Error("failed"); } }, session);
  const attempt = started(execution.dispatch(input));
  await attempt.firstOutcome;
  await enteredRecovery.promise;
  expect(execution.inspectRecord(attempt.recordId)?.status).toBe("unavailable");
  const finalizing = execution.finalizeAudit(200);
  const race = await Promise.race([finalizing.then(() => "finalized"), new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 10))]);
  expect(race).toBe("waiting");
  readiness.resolve("login_required");
  const audit = await finalizing;
  expect(audit.llmAuditFinalization.status).toBe("complete");
  expect(audit.llmSessionStatus).toMatchObject({ status: "degraded", triggeringRecordId: attempt.recordId });
});

test("deadline during recovery reports recovery phase and quarantines the session", async () => {
  const readiness = deferred<SiteLoadStatus>();
  const enteredRecovery = deferred<void>();
  const session = fakeSession(() => { enteredRecovery.resolve(); return readiness.promise; });
  const execution = manager({ assess: async () => { throw new Error("failed"); } }, session);
  const attempt = started(execution.dispatch(input));
  await enteredRecovery.promise;
  const audit = await execution.finalizeAudit(5);
  expect(audit.llmAuditFinalization).toMatchObject({
    status: "incomplete", activeRecordId: attempt.recordId, phase: "recovery",
  });
  expect(audit.llmSupervisorAssessments[0]).toMatchObject({
    status: "unavailable", finalizationIncomplete: { phase: "recovery" },
  });
  expect(audit.llmSessionStatus).toMatchObject({ status: "degraded", triggeringRecordId: attempt.recordId });
  const serialized = JSON.stringify(audit);
  readiness.resolve("ready");
  await attempt.completion;
  expect(JSON.stringify(audit)).toBe(serialized);
});

test("the barrier waits for the read-only idle probe after checkReady succeeds", async () => {
  const idle = deferred<{ healthy: true }>();
  const enteredProbe = deferred<void>();
  const execution = new LlmExecutionManager(
    { assess: async () => ({ unavailable: true, round: 1, reason: "browser failure" }) },
    fakeSession(),
    { timeoutMs: 100, recoveryProbe: () => { enteredProbe.resolve(); return idle.promise; } },
  );
  const attempt = started(execution.dispatch(input));
  await enteredProbe.promise;
  const finalizing = execution.finalizeAudit(200);
  const race = await Promise.race([finalizing.then(() => "finalized"), new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 10))]);
  expect(race).toBe("waiting");
  idle.resolve({ healthy: true });
  const audit = await finalizing;
  expect(audit.llmAuditFinalization.status).toBe("complete");
  expect(audit.llmSessionStatus.status).toBe("ready");
  expect(audit.llmSupervisorAssessments[0].status).toBe("unavailable");
  await attempt.completion;
});
