import type {
  HumanGatePresentation,
  HumanGateRawResponse,
} from "../claims/types";

export type { HumanGatePresentation, HumanGateRawResponse } from "../claims/types";

/**
 * Boundary for presenting a recommendation to a human and awaiting their raw
 * decision. The orchestrator remains responsible for interpreting the result.
 */
export interface HumanGate {
  presentAndAwaitDecision(
    presentation: HumanGatePresentation,
  ): Promise<HumanGateRawResponse>;
}
