import type { SupervisorInput, SupervisorUnavailable } from "../types";
import type { AuditableLlmSupervisor, LlmSupervisorAdapterObservation } from "./contracts";
import type { LlmSupervisorSession } from "./session";
import { buildLlmSupervisorPrompt } from "./prompt";
import { parseLlmSupervisorResponse } from "./parser";

export interface LlmSupervisorAdapterOptions {
  generationTimeoutMs: number;
}

function unavailable(round: number, reason: string): SupervisorUnavailable {
  return { unavailable: true, round, reason };
}

/** One browser turn only. The future composite owns locking, recovery, and finalization. */
export function createLlmSupervisorAdapter(
  session: LlmSupervisorSession,
  options: LlmSupervisorAdapterOptions,
): AuditableLlmSupervisor {
  if (!Number.isSafeInteger(options.generationTimeoutMs) || options.generationTimeoutMs <= 0) {
    throw new RangeError("generationTimeoutMs must be a positive integer");
  }

  const supervisor: AuditableLlmSupervisor = {
    async assess(input: SupervisorInput) {
      return (await supervisor.assessWithAudit(input)).outcome;
    },
    async assessWithAudit(input: SupervisorInput): Promise<LlmSupervisorAdapterObservation> {
      const round = input.rounds.at(-1)?.roundNumber;
      if (!Number.isSafeInteger(round) || round === undefined || round < 1) {
        return { outcome: unavailable(0, "invalid supervisor input") };
      }
      let sentPrompt: string | undefined;
      let rawResponse: string | undefined;
      const failed = (reason: string): LlmSupervisorAdapterObservation => ({
        outcome: unavailable(round, reason),
        ...(sentPrompt === undefined ? {} : { prompt: sentPrompt }),
        ...(rawResponse === undefined ? {} : { rawResponse }),
      });
      try {
        const ready = await session.checkReady();
        if (ready !== "ready") return failed(`llm session unavailable: ${ready}`);
        const prompt = buildLlmSupervisorPrompt(input);
        const groundedSignals = input.rounds.map((item) => ({ ...item.recommendation }));
        const baseline = await session.adapter.captureTurnBaseline(session.page);
        await session.adapter.sendPrompt(session.page, prompt);
        sentPrompt = prompt;
        const started = await session.adapter.waitForGenerationStart(session.page, baseline);
        if (started !== "started") return failed("llm generation did not start");

        const completion = await session.adapter.waitForGenerationComplete(
          session.page, baseline, options.generationTimeoutMs,
        );
        if (completion.outcome === "timeout") return failed("llm generation timed out");
        if (completion.outcome !== "complete") return failed("llm generation failed");

        const raw = await session.adapter.getLatestAssistantResponse(session.page, baseline);
        if (typeof raw === "string") rawResponse = raw;
        const parsed = parseLlmSupervisorResponse(raw, input, groundedSignals);
        return parsed.kind === "assessment"
          ? { outcome: parsed.assessment, prompt, rawResponse: raw, groundedSignals }
          : failed(parsed.reason);
      } catch {
        return failed("llm browser operation failed");
      }
    },
  };
  return supervisor;
}
