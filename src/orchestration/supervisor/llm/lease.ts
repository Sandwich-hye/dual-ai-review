/** The token is run-local identity, never an audit round or serialized value. */
export interface LlmPageLease {
  readonly token: symbol;
  readonly recordId: string;
  readonly round: number;
  readonly completion: Promise<void>;
  phase: "operation" | "recovery";
}

/** Synchronous, non-queueing ownership gate for a single dedicated LLM page. */
export class LlmPageLeaseGate {
  private activeLease: LlmPageLease | undefined;

  get active(): Readonly<LlmPageLease> | undefined {
    return this.activeLease;
  }

  acquire(recordId: string, round: number, completion: Promise<void>): symbol | undefined {
    if (this.activeLease) return undefined;
    const token = Symbol(recordId);
    this.activeLease = { token, recordId, round, completion, phase: "operation" };
    return token;
  }

  setPhaseIfOwner(token: symbol, phase: LlmPageLease["phase"]): boolean {
    if (this.activeLease?.token !== token) return false;
    this.activeLease.phase = phase;
    return true;
  }

  releaseIfOwner(token: symbol): boolean {
    if (this.activeLease?.token !== token) return false;
    this.activeLease = undefined;
    return true;
  }
}
