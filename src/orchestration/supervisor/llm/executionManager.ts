import type { Supervisor, SupervisorInput } from "../types";
import type {
  LlmAuditFinalization,
  AuditableLlmSupervisor,
  LlmSessionStatus,
  LlmSupervisorAssessmentRecord,
  LlmSupervisorSettlement,
  LlmSupervisorTimedOutcome,
} from "./contracts";
import {
  DEFAULT_LLM_FINALIZATION_TIMEOUT_MS,
  MAX_LLM_FINALIZATION_TIMEOUT_MS,
} from "./contracts";
import { LlmPageLeaseGate } from "./lease";
import { classifyLlmSupervisorOutcome, classifyLlmSupervisorRejection } from "./outcomes";
import { probeLlmSessionIdle, type LlmRecoveryHealth } from "./recovery";
import type { LlmSupervisorSession } from "./session";

export interface LlmExecutionManagerOptions {
  timeoutMs: number;
  /** A read-only site-specific probe; defaults to the 6B idle-state probe. */
  recoveryProbe?: (session: LlmSupervisorSession) => Promise<LlmRecoveryHealth>;
}

export interface LlmAuditSnapshot {
  llmSupervisorAssessments: LlmSupervisorAssessmentRecord[];
  llmSessionStatus: LlmSessionStatus;
  llmAuditFinalization: LlmAuditFinalization;
}

export type LlmDispatchResult =
  | {
      kind: "dispatched";
      recordId: string;
      firstOutcome: Promise<LlmSupervisorTimedOutcome>;
      completion: Promise<void>;
    }
  | { kind: "skipped"; reason: string; recordId?: string };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

const timestamp = (): string => new Date().toISOString();
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

/** One run's audit-only LLM side channel. It never calls the deterministic supervisor. */
export class LlmExecutionManager {
  private readonly lease = new LlmPageLeaseGate();
  private readonly records: LlmSupervisorAssessmentRecord[] = [];
  private sequence = 0;
  private state: "open" | "finalizing" | "sealed" = "open";
  private sessionStatus: LlmSessionStatus = { status: "ready" };
  private finalizationPromise: Promise<LlmAuditSnapshot> | undefined;
  private sealedSnapshot: LlmAuditSnapshot | undefined;

  constructor(
    private readonly supervisor: Supervisor,
    private readonly session: LlmSupervisorSession,
    private readonly options: LlmExecutionManagerOptions,
  ) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
        options.timeoutMs > MAX_NODE_TIMER_DELAY_MS) {
      throw new RangeError("timeoutMs must fit a positive Node timer delay");
    }
  }

  dispatch(input: SupervisorInput): LlmDispatchResult {
    if (this.state !== "open") return { kind: "skipped", reason: "llm audit finalizing" };
    let round = 0;
    try { round = input.rounds.at(-1)?.roundNumber ?? 0; } catch { /* malformed input is not dispatched */ }
    const id = `llm-${++this.sequence}`;

    if (this.sessionStatus.status === "degraded") {
      return this.skip(id, round, `llm session degraded: ${this.sessionStatus.detail}`);
    }
    const active = this.lease.active;
    if (active) return this.skip(id, round, `llm leg busy with record ${active.recordId}`);
    if (!Number.isSafeInteger(round) || round < 1) return this.skip(id, round, "invalid supervisor input");

    const record: LlmSupervisorAssessmentRecord = {
      id, round, status: "pending", dispatchedAt: timestamp(),
    };
    const completion = deferred<void>();
    const token = this.lease.acquire(id, round, completion.promise);
    if (!token) return this.skip(id, round, "llm leg busy");
    this.records.push(record);
    const first = deferred<LlmSupervisorTimedOutcome>();
    void this.runLease(token, record, input, first.resolve, completion.resolve).catch(() => {
      // Defensive observer only. Never release a lease or mutate a sealed audit here.
    });
    return { kind: "dispatched", recordId: id, firstOutcome: first.promise, completion: completion.promise };
  }

  /** Audit a trigger that could not safely reach dispatch, without touching the page. */
  recordSkippedDispatch(round: number, reason: string): LlmDispatchResult {
    if (this.state !== "open") return { kind: "skipped", reason: "llm audit finalizing" };
    const safeRound = Number.isSafeInteger(round) && round > 0 ? round : 0;
    return this.skip(`llm-${++this.sequence}`, safeRound, reason);
  }

  private skip(id: string, round: number, reason: string): LlmDispatchResult {
    const record: LlmSupervisorAssessmentRecord = { id, round, status: "skipped", reason };
    this.records.push(record);
    return { kind: "skipped", reason, recordId: id };
  }

  /** Diagnostic read only. Final result assembly must use finalizeAudit's atomic snapshot. */
  inspectRecord(recordId: string): Readonly<LlmSupervisorAssessmentRecord> | undefined {
    const record = this.records.find((item) => item.id === recordId);
    return record ? freezeDeep(JSON.parse(JSON.stringify(record)) as LlmSupervisorAssessmentRecord) : undefined;
  }

  private canRecord(): boolean { return this.state !== "sealed"; }

  private recordEvidence(record: LlmSupervisorAssessmentRecord, settled: LlmSupervisorSettlement): void {
    if (settled.prompt !== undefined) record.prompt = settled.prompt;
    if (settled.rawResponse !== undefined) record.rawResponse = settled.rawResponse;
    if (settled.kind === "assessment" && settled.groundedSignals !== undefined) {
      record.groundedSignals = settled.groundedSignals;
    }
  }

  private recordSettlement(record: LlmSupervisorAssessmentRecord, settled: LlmSupervisorSettlement): void {
    if (!this.canRecord()) return;
    record.resolvedAt = timestamp();
    this.recordEvidence(record, settled);
    if (settled.kind === "assessment") {
      record.status = "resolved";
      record.assessment = settled.assessment;
    } else {
      record.status = "unavailable";
      record.reason = settled.reason;
    }
  }

  private recordLate(record: LlmSupervisorAssessmentRecord, settled: LlmSupervisorSettlement): void {
    if (!this.canRecord()) return;
    this.recordEvidence(record, settled);
    record.lateResolution = settled.kind === "assessment"
      ? { kind: "success", resolvedAt: timestamp(), assessment: settled.assessment }
      : { kind: "failure", resolvedAt: timestamp(), reason: settled.reason };
  }

  private degrade(record: LlmSupervisorAssessmentRecord, detail: string): void {
    if (!this.canRecord() || this.sessionStatus.status === "degraded") return;
    this.sessionStatus = {
      status: "degraded", detail, sinceRound: record.round, triggeringRecordId: record.id,
    };
  }

  private async recover(token: symbol, record: LlmSupervisorAssessmentRecord): Promise<void> {
    if (this.state === "sealed") return;
    this.lease.setPhaseIfOwner(token, "recovery");
    try {
      const ready = await this.session.checkReady();
      if (ready !== "ready") {
        this.degrade(record, `recovery checkReady: ${ready}`);
        return;
      }
      const health = await (this.options.recoveryProbe ?? probeLlmSessionIdle)(this.session);
      if (!health.healthy) this.degrade(record, `recovery idle probe: ${health.detail}`);
    } catch {
      this.degrade(record, "recovery could not be verified");
    }
  }

  private async runLease(
    token: symbol,
    record: LlmSupervisorAssessmentRecord,
    input: SupervisorInput,
    publishFirst: (outcome: LlmSupervisorTimedOutcome) => void,
    resolveCompletion: () => void,
  ): Promise<void> {
    let safeReal: Promise<LlmSupervisorSettlement> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let published = false;
    const publish = (outcome: LlmSupervisorTimedOutcome): void => {
      if (published) return;
      published = true;
      publishFirst(outcome);
    };
    try {
      safeReal = Promise.resolve()
        .then(async () => {
          const auditable = this.supervisor as Partial<AuditableLlmSupervisor>;
          if (typeof auditable.assessWithAudit !== "function") {
            return classifyLlmSupervisorOutcome(await this.supervisor.assess(input), record.round);
          }
          const observed = await auditable.assessWithAudit(input);
          const settled = classifyLlmSupervisorOutcome(observed.outcome, record.round);
          if (settled.kind === "assessment") {
            if (typeof observed.prompt !== "string" || typeof observed.rawResponse !== "string" ||
                !("groundedSignals" in observed) || !Array.isArray(observed.groundedSignals)) {
              return { kind: "failure", source: "invalid", reason: "invalid supervisor outcome" } as const;
            }
            return {
              ...settled,
              prompt: observed.prompt,
              rawResponse: observed.rawResponse,
              groundedSignals: observed.groundedSignals,
            };
          }
          return {
            ...settled,
            ...(typeof observed.prompt === "string" ? { prompt: observed.prompt } : {}),
            ...(typeof observed.rawResponse === "string" ? { rawResponse: observed.rawResponse } : {}),
          };
        })
        .then(
          (value) => value,
          (error) => classifyLlmSupervisorRejection(error),
        )
        .catch(() => ({ kind: "failure", source: "invalid", reason: "invalid supervisor outcome" } as const));
      const timeout = new Promise<{ kind: "timeout-signal" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout-signal" }), this.options.timeoutMs);
      });
      const first = await Promise.race([safeReal, timeout]);
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }

      if (first.kind === "timeout-signal") {
        if (this.canRecord()) {
          record.status = "timed_out";
          record.reason = `exceeded ${this.options.timeoutMs}ms`;
        }
        publish({ kind: "timeout", timeoutMs: this.options.timeoutMs });
        const late = await safeReal;
        this.recordLate(record, late);
        await this.recover(token, record);
      } else {
        this.recordSettlement(record, first);
        publish(first);
        if (first.kind === "failure") await this.recover(token, record);
      }
    } catch {
      // Never release while an already-started browser operation is still active.
      if (safeReal) await safeReal;
      const failure: LlmSupervisorSettlement = {
        kind: "failure", source: "invalid", reason: "llm execution failed",
      };
      this.recordSettlement(record, failure);
      publish(failure);
      await this.recover(token, record);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!published) publish({ kind: "failure", source: "invalid", reason: "llm execution failed" });
      this.lease.releaseIfOwner(token);
      resolveCompletion();
    }
  }

  finalizeAudit(timeoutMs = DEFAULT_LLM_FINALIZATION_TIMEOUT_MS): Promise<LlmAuditSnapshot> {
    if (this.finalizationPromise) return this.finalizationPromise;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_LLM_FINALIZATION_TIMEOUT_MS) {
      throw new RangeError("finalization timeout must be a positive integer within the maximum");
    }
    this.state = "finalizing";
    this.finalizationPromise = this.finalizeInternal(timeoutMs).catch(() => this.sealSnapshot(true));
    return this.finalizationPromise;
  }

  private async finalizeInternal(timeoutMs: number): Promise<LlmAuditSnapshot> {
    const active = this.lease.active;
    if (active) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => resolve("deadline"), timeoutMs);
        });
        const winner = await Promise.race([
          active.completion.then(() => "complete" as const, () => "deadline" as const),
          deadline,
        ]);
        if (winner === "deadline" || this.lease.active) return this.sealSnapshot(true);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    return this.sealSnapshot(false);
  }

  private sealSnapshot(incomplete: boolean): LlmAuditSnapshot {
    if (this.sealedSnapshot) return this.sealedSnapshot;
    const active = this.lease.active;
    const at = timestamp();
    if (incomplete && active) {
      const record = this.records.find((item) => item.id === active.recordId)!;
      record.finalizationIncomplete = { phase: active.phase, at };
      this.degrade(record, "unverified at finalization");
    }
    const finalization: LlmAuditFinalization = incomplete && active
      ? {
          status: "incomplete", finalizedAt: at, activeRecordId: active.recordId,
          phase: active.phase, reason: "finalization_deadline_exceeded",
        }
      : { status: "complete", finalizedAt: at };
    this.state = "sealed";
    const plain = JSON.parse(JSON.stringify({
      llmSupervisorAssessments: this.records,
      llmSessionStatus: this.sessionStatus,
      llmAuditFinalization: finalization,
    })) as LlmAuditSnapshot;
    this.sealedSnapshot = freezeDeep(plain);
    return this.sealedSnapshot;
  }
}
