import type { AuditedReviewResult } from "../orchestration/claims/types";
import type { ProviderProvenance } from "../providers/llmProvider";

export interface ReviewProvenance {
  generator: Readonly<ProviderProvenance>;
  reviewer: Readonly<ProviderProvenance>;
}

function providerLabel(value: ProviderProvenance): string {
  return `${value.providerName} / ${value.modelName} / ${value.executionMode}`;
}

export function renderTerminalReport(result: AuditedReviewResult, providers: ReviewProvenance, auditPath: string): string {
  const lines = [
    `Outcome: ${result.outcome} (${result.outcomeOrigin})`,
    `Generator LLM: ${providerLabel(providers.generator)}`,
    `Reviewer LLM: ${providerLabel(providers.reviewer)}`,
    `Rounds: ${result.rounds.length}; claims: ${result.claimLedger.length}; evidence: ${result.evidenceLog.length}`,
  ];
  for (const round of result.rounds) {
    const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const claim of round.ledgerSnapshot) counts[claim.severity] += 1;
    lines.push(`Round ${round.roundNumber}: ${round.recommendation.kind}; human ${round.humanDecision.outcome} (${round.humanDecision.recommendationAgreement})`);
    lines.push(`  Claims: ${counts.HIGH} high, ${counts.MEDIUM} medium, ${counts.LOW} low; branch: ${round.recommendation.triggeredBranch}`);
    if (round.recommendation.invalidReview) lines.push(`  Invalid reviewer output: ${round.recommendation.invalidReview.reason}`);
    if (round.humanDecision.hardSafetyOverride) lines.push(`  Safety override: ${round.humanDecision.hardSafetyOverride.reason}`);
  }
  if (result.claimLedger.length > 0) {
    lines.push("Final claim ledger:");
    for (const claim of result.claimLedger) lines.push(`  ${claim.id} [${claim.severity}/${claim.status}] ${claim.claim.statement}`);
  }
  lines.push("Final answer:", result.finalAnswer, `Audit JSON: ${auditPath}`);
  return lines.join("\n");
}
