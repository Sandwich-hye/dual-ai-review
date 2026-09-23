import type { SupervisorInput, SupervisorRecommendationSignal } from "../types";
import type { LlmSupervisorSettlement } from "./contracts";
import { classifyLlmSupervisorOutcome, INVALID_SUPERVISOR_OUTCOME_REASON } from "./outcomes";

const BEGIN = "BEGIN_SUPERVISOR_ASSESSMENT";
const END = "END_SUPERVISOR_ASSESSMENT";

function invalid(): LlmSupervisorSettlement {
  return { kind: "failure", source: "invalid", reason: INVALID_SUPERVISOR_OUTCOME_REASON };
}

/** Strict sentinel/JSON parsing plus exact-round grounding; never trusts raw model text. */
export function parseLlmSupervisorResponse(
  raw: unknown,
  input: SupervisorInput,
  groundedSignals: readonly SupervisorRecommendationSignal[] = input.rounds.map((round) => round.recommendation),
): LlmSupervisorSettlement {
  try {
    if (typeof raw !== "string") return invalid();
    const lines = raw.split(/\r?\n/);
    const begins = lines.flatMap((line, index) => line.trim() === BEGIN ? [index] : []);
    const ends = lines.flatMap((line, index) => line.trim() === END ? [index] : []);
    if (begins.length !== 1 || ends.length !== 1 || begins[0] >= ends[0]) return invalid();
    if (lines.slice(0, begins[0]).some((line) => line.trim()) || lines.slice(ends[0] + 1).some((line) => line.trim())) return invalid();

    const parsed: unknown = JSON.parse(lines.slice(begins[0] + 1, ends[0]).join("\n"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalid();
    const body = parsed as Record<string, unknown>;
    const expectedRound = input.rounds.at(-1)?.roundNumber;
    if (expectedRound === undefined) return invalid();
    const permitted = body.unavailable === true
      ? ["unavailable", "round", "reason"]
      : ["round", "flags", "escalationRecommended", "escalationReason"];
    if (Object.keys(body).some((key) => !permitted.includes(key))) return invalid();

    const result = classifyLlmSupervisorOutcome(
      "round" in body ? body : { ...body, round: expectedRound }, expectedRound,
    );
    if (result.kind !== "assessment") return result;

    const suppliedRounds = new Set(groundedSignals.map((signal) => signal.round));
    if (result.assessment.flags.some((flag) => flag.evidenceRounds.some((round) => !suppliedRounds.has(round)))) {
      return invalid();
    }
    return result;
  } catch {
    return invalid();
  }
}
