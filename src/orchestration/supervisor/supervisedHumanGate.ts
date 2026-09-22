import type {
  HumanGate,
  HumanGatePresentation,
  HumanGateRawResponse,
} from "../humanGate/humanGate";
import {
  toSupervisorRoundSignal,
  type Supervisor,
  type SupervisorAssessmentRecord,
  type SupervisorInput,
  toSupervisorRecommendationSignal,
} from "./types";

export interface SupervisedHumanGateOptions {
  invalidReviewRejectThreshold: number;
  reopenRejectThreshold: number;
  renderAssessment?: (
    assessment: SupervisorAssessmentRecord,
    presentation: HumanGatePresentation,
  ) => void | Promise<void>;
}

export type SupervisedHumanGate = HumanGate & {
  getAccumulatedAssessments(): SupervisorAssessmentRecord[];
};

const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

const defaultRenderer = (assessment: SupervisorAssessmentRecord): void => {
  if ("unavailable" in assessment) return;
  if (assessment.flags.length === 0) return;
  console.warn(`[JEV] ${assessment.escalationReason ?? "Supervisor advisory flags raised"}`);
};

export function createSupervisedHumanGate(
  inner: HumanGate,
  supervisor: Supervisor,
  options: SupervisedHumanGateOptions,
): SupervisedHumanGate {
  const rounds: SupervisorInput["rounds"] = [];
  const assessmentRecords: SupervisorAssessmentRecord[] = [];
  const render = options.renderAssessment ?? defaultRenderer;

  return {
    async presentAndAwaitDecision(presentation: HumanGatePresentation): Promise<HumanGateRawResponse> {
      const supervisorInput: SupervisorInput = {
        rounds: [
          ...rounds.map((round) => ({
            roundNumber: round.roundNumber,
            recommendation: { ...round.recommendation },
            ...(round.recommendationAgreement === undefined ? {} : { recommendationAgreement: round.recommendationAgreement }),
            ...(round.hardSafetyOverrideInferred === undefined ? {} : { hardSafetyOverrideInferred: round.hardSafetyOverrideInferred }),
            ...(round.outcome === undefined ? {} : { outcome: round.outcome }),
          })),
          {
            roundNumber: presentation.round,
            recommendation: toSupervisorRecommendationSignal(presentation.recommendation),
          },
        ],
        invalidReviewRejectThreshold: options.invalidReviewRejectThreshold,
        reopenRejectThreshold: options.reopenRejectThreshold,
      };

      let assessment: SupervisorAssessmentRecord;
      try {
        assessment = await supervisor.assess(supervisorInput);
      } catch (error) {
        assessment = { unavailable: true, round: presentation.round, reason: describeError(error) };
      }

      let recordedAssessment = assessment;
      try {
        await render(assessment, presentation);
      } catch (error) {
        recordedAssessment = {
          ...assessment,
          renderingFailure: { reason: describeError(error) },
        };
        try {
          console.warn(`[JEV] rendering failed: ${describeError(error)}`);
        } catch {
          // Rendering failures and fallback-notice failures are isolated from the gate.
        }
      }
      assessmentRecords.push(recordedAssessment);

      // The delegated call is intentionally outside the JEV failure boundaries.
      const rawResponse = await inner.presentAndAwaitDecision(presentation);
      rounds.push(toSupervisorRoundSignal(presentation, rawResponse));
      return rawResponse;
    },
    getAccumulatedAssessments(): SupervisorAssessmentRecord[] {
      return assessmentRecords.map((assessment) => ({
        ...assessment,
        ...( "flags" in assessment ? { flags: assessment.flags.map((flag) => ({ ...flag, evidenceRounds: [...flag.evidenceRounds] })) } : {}),
      }));
    },
  };
}
