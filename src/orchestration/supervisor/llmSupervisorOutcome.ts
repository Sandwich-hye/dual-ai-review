import type { SupervisorAssessment, SupervisorUnavailable } from "./types";

export type SettledSupervisorOutcome =
  | { kind: "resolved"; value: SupervisorAssessment }
  | { kind: "rejected"; error: unknown };

export type TimedSupervisorOutcome =
  | SettledSupervisorOutcome
  | { kind: "timeout"; awaitRealSettlement: () => Promise<SettledSupervisorOutcome> };

/** A resolved unavailable result is a failed LLM leg, just like a rejected call. */
export function toSafeSupervisorOutcome(
  real: Promise<SupervisorAssessment | SupervisorUnavailable>,
): Promise<SettledSupervisorOutcome> {
  return real.then(
    (value): SettledSupervisorOutcome => "unavailable" in value
      ? { kind: "rejected", error: value.reason }
      : { kind: "resolved", value },
    (error): SettledSupervisorOutcome => ({ kind: "rejected", error }),
  );
}

/** A timeout does not cancel the browser operation; the caller retains its settlement. */
export function raceWithTimeout(
  real: Promise<SupervisorAssessment | SupervisorUnavailable>,
  timeoutMs: number,
): Promise<TimedSupervisorOutcome> {
  const safeReal = toSafeSupervisorOutcome(real);
  const safeTimeout = new Promise<{ kind: "timeout-signal" }>((resolve) => {
    setTimeout(() => resolve({ kind: "timeout-signal" }), timeoutMs);
  });

  return Promise.race([safeReal, safeTimeout]).then((first) =>
    first.kind === "timeout-signal"
      ? { kind: "timeout", awaitRealSettlement: () => safeReal }
      : first,
  );
}
