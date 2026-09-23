import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_LLM_FINALIZATION_TIMEOUT_MS,
  ISOLATION_ATTESTATION_MAX_AGE_DAYS,
  LLM_SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION,
  MAX_LLM_FINALIZATION_TIMEOUT_MS,
} from "../../src/orchestration/supervisor/llm/contracts";
import type {
  LlmAuditFinalization,
  LlmIsolationAttestation,
  LlmSessionStatus,
  LlmSupervisorAssessmentRecord,
  LlmSupervisorTimedOutcome,
  LlmTimeoutSettings,
} from "../../src/orchestration/supervisor/llm/contracts";
import {
  classifyLlmSupervisorOutcome,
  classifyLlmSupervisorRejection,
  INVALID_SUPERVISOR_OUTCOME_REASON,
} from "../../src/orchestration/supervisor/llm/outcomes";
import { SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION } from "../../src/orchestration/supervisor/types";
import type { SupervisorAssessment, SupervisorUnavailable } from "../../src/orchestration/supervisor/types";

const assessment: SupervisorAssessment = {
  round: 2,
  flags: [{ flag: "STAGNATION", detail: "No progress", evidenceRounds: [1, 2] }],
  escalationRecommended: true,
  escalationReason: "Repeated stagnation",
};

test("6B audit contracts serialize complete and incomplete snapshots", () => {
  const attestation: LlmIsolationAttestation = { isolationAttestedAt: "2026-09-23T00:00:00.000Z" };
  const timeout: LlmTimeoutSettings = { timeoutMs: 20_000, finalizationTimeoutMs: 60_000 };
  const timedOutcome: LlmSupervisorTimedOutcome = { kind: "timeout", timeoutMs: timeout.timeoutMs };
  const record: LlmSupervisorAssessmentRecord = {
    id: "round-2",
    round: 2,
    status: "timed_out",
    dispatchedAt: "2026-09-23T00:00:01.000Z",
    reason: "exceeded 20000ms",
    lateResolution: { kind: "failure", resolvedAt: "2026-09-23T00:00:22.000Z", reason: "session lost" },
  };
  const session: LlmSessionStatus = {
    status: "degraded", detail: "session lost", sinceRound: 2, triggeringRecordId: record.id,
  };
  const complete: LlmAuditFinalization = { status: "complete", finalizedAt: "2026-09-23T00:00:23.000Z" };
  const snapshot = { attestation, timeout, timedOutcome, records: [record], session, finalization: complete };

  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  expect(session.status === "degraded" && snapshot.records.some((item) => item.id === session.triggeringRecordId)).toBe(true);

  const incompleteRecord: LlmSupervisorAssessmentRecord = {
    id: "round-3", round: 3, status: "pending",
    finalizationIncomplete: { phase: "operation", at: "2026-09-23T00:01:00.000Z" },
  };
  const incomplete: LlmAuditFinalization = {
    status: "incomplete", finalizedAt: "2026-09-23T00:01:00.000Z",
    activeRecordId: incompleteRecord.id, phase: "operation", reason: "finalization_deadline_exceeded",
  };
  expect(JSON.parse(JSON.stringify({ record: incompleteRecord, finalization: incomplete }))).toEqual({
    record: incompleteRecord, finalization: incomplete,
  });
});

test("6B contracts are isolated from the frozen 6A schema and browser dependencies", () => {
  expect(SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION).toBe(1);
  expect(LLM_SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION).toBe(2);
  expect(ISOLATION_ATTESTATION_MAX_AGE_DAYS).toBe(30);
  expect(DEFAULT_LLM_FINALIZATION_TIMEOUT_MS).toBe(60_000);
  expect(MAX_LLM_FINALIZATION_TIMEOUT_MS).toBe(300_000);

  for (const name of ["contracts.ts", "outcomes.ts"]) {
    const source = readFileSync(resolve(process.cwd(), "src/orchestration/supervisor/llm", name), "utf8");
    expect(source).not.toMatch(/from\s+["'](?:playwright|.*\/browser|.*\/sites)["']/i);
    expect(source).not.toMatch(/\b(?:Page|Browser|Locator)\b/);
    expect(source).not.toMatch(/\b(?:goto|click|fill|evaluate)\s*\(/);
  }
  const contractsSource = readFileSync(resolve(process.cwd(), "src/orchestration/supervisor/llm/contracts.ts"), "utf8");
  expect(contractsSource).toContain("import type {");
  expect(contractsSource).toContain('from "../types"');
});

test("a normal SupervisorAssessment is the only successful resolved outcome", () => {
  expect(classifyLlmSupervisorOutcome(assessment, 2)).toEqual({ kind: "assessment", assessment });
});

test("resolved SupervisorUnavailable and rejected errors share the failure branch", () => {
  const unavailable: SupervisorUnavailable = { unavailable: true, round: 2, reason: "session lost" };
  const resolved = classifyLlmSupervisorOutcome(unavailable, 2);
  const rejected = classifyLlmSupervisorRejection(new Error("adapter failed"));
  expect(resolved).toEqual({ kind: "failure", source: "unavailable", reason: "session lost" });
  expect(rejected).toEqual({ kind: "failure", source: "rejected", reason: "adapter failed" });
  expect(resolved.kind).toBe(rejected.kind);
});

test("malformed resolved outcomes fail safely with content-independent reasons", () => {
  const malformed: unknown[] = [
    null,
    undefined,
    "not an assessment",
    0,
    [],
    { unavailable: true, round: 2 },
    { unavailable: false, round: 2, reason: "bad" },
    { unavailable: true, round: 3, reason: "wrong round" },
    { round: 2, escalationRecommended: false },
    { round: 3, flags: [], escalationRecommended: false },
    { round: 2, flags: null, escalationRecommended: false },
    { round: 2, flags: [{ flag: "UNKNOWN", detail: "bad", evidenceRounds: [2] }], escalationRecommended: false },
    { round: 2, flags: [{ flag: "STAGNATION", detail: "bad", evidenceRounds: [3] }], escalationRecommended: false },
    { round: 2, flags: [], escalationRecommended: "false" },
    new Proxy({}, { get() { throw new Error("sensitive value"); } }),
  ];
  for (const value of malformed) {
    expect(classifyLlmSupervisorOutcome(value, 2)).toEqual({
      kind: "failure", source: "invalid", reason: INVALID_SUPERVISOR_OUTCOME_REASON,
    });
  }
  expect(classifyLlmSupervisorRejection(null)).toEqual({
    kind: "failure", source: "rejected", reason: "supervisor assessment failed",
  });
});
