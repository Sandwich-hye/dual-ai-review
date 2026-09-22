import { evaluateSupervisorState } from "./supervisorEngine";
import type { Supervisor } from "./types";

/** Creates the default deterministic, advisory-only supervisor. */
export function createDeterministicSupervisor(): Supervisor {
  return {
    async assess(input) {
      return evaluateSupervisorState(input);
    },
  };
}
