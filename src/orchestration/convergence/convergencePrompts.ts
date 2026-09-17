import type { ObjectionLedgerEntry } from "./types";

export function buildConvergenceInitialChatGptPrompt(task: string): string {
  return task;
}

export function buildConvergenceClaudeReviewPrompt(
  task: string,
  answer: string,
  openLedgerEntries: ObjectionLedgerEntry[],
  round: number,
): string {
  if (round === 1) {
    return [
      "You are Claude. Review the following answer produced by ChatGPT.", "",
      "TASK:", "---", task, "---", "",
      "CURRENT CHATGPT ANSWER:", "---", answer, "---", "",
      "This is round 1 of an iterative review. There is no prior objection ledger yet.", "",
      "Identify concrete objections that materially affect correctness, completeness, or",
      "quality. Classify each one:",
      "  HIGH   — a correctness or safety defect that must be fixed.",
      "  MEDIUM — a significant completeness or quality gap.",
      "  LOW    — a minor or stylistic point that does not need to block acceptance.",
      "Do not invent speculative objections merely to keep the review going.", "",
      "Respond with exactly one structured block, and nothing else inside it besides valid JSON:", "",
      "BEGIN_STRUCTURED_REVIEW",
      "{",
      "  \"reviewStatus\": \"CONTINUE\" or \"CANDIDATE_CONVERGED\",",
      "  \"resolvedObjectionIds\": [],",
      "  \"resolutionEvidence\": {},",
      "  \"stillOpenObjections\": [],",
      "  \"reopenedObjections\": [],",
      "  \"newObjections\": [",
      "    { \"severity\": \"HIGH\" or \"MEDIUM\" or \"LOW\", \"summary\": \"<one line>\", \"reason\": \"<evidence>\" }",
      "  ],",
      "  \"reviewNotes\": \"<optional>\"",
      "}",
      "END_STRUCTURED_REVIEW", "",
      "resolvedObjectionIds, stillOpenObjections, and reopenedObjections must all be empty",
      "arrays in round 1 — there is nothing yet to reference. Use escaped \\n for any line breaks",
      "inside a string. You may write ordinary prose before or after the block; only the block",
      "itself is read.",
    ].join("\n");
  }

  const ledgerLines = openLedgerEntries.map(
    entry => `- ${entry.id} [${entry.severity}] ${entry.summary} — ${entry.reason}`,
  );
  return [
    "You are Claude. Review the latest revised answer produced by ChatGPT.", "",
    "TASK:", "---", task, "---", "",
    "LATEST CHATGPT ANSWER:", "---", answer, "---", "",
    "OPEN OBJECTION LEDGER FROM PRIOR ROUNDS (RESOLVED/REJECTED objections are omitted):",
    ...ledgerLines, "",
    "For every open objection above, decide whether it is now resolved or still open in the",
    "latest answer, and reference it by id — do not restate it as a new objection. Separately,",
    "if you believe an objection you previously marked resolved or rejected has reappeared,",
    "reference its id under reopenedObjections with a note explaining why, rather than raising",
    "it again as new. Then list any genuinely new objections not already covered by an id",
    "above.", "",
    "Respond with exactly one structured block, and nothing else inside it besides valid JSON:", "",
    "BEGIN_STRUCTURED_REVIEW",
    "{",
    "  \"reviewStatus\": \"CONTINUE\" or \"CANDIDATE_CONVERGED\",",
    "  \"resolvedObjectionIds\": [\"OBJ-1\"],",
    "  \"resolutionEvidence\": {",
    "    \"OBJ-1\": \"the revised answer now addresses the cited failure mode\"",
    "  },",
    "  \"stillOpenObjections\": [{ \"id\": \"OBJ-3\" }],",
    "  \"reopenedObjections\": [],",
    "  \"newObjections\": [],",
    "  \"reviewNotes\": \"<optional>\"",
    "}",
    "END_STRUCTURED_REVIEW", "",
    "Only reference ids listed in the ledger above. Use escaped \\n for any line breaks inside",
    "a string. You may write ordinary prose before or after the block; only the block itself is",
    "read.",
  ].join("\n");
}

export function buildConvergenceChatGptRevisionPrompt(
  task: string,
  previousAnswer: string,
  claudeRawReview: string,
  openHighMediumObjections: ObjectionLedgerEntry[],
): string {
  const blockerLines = openHighMediumObjections.map(
    entry => `- [${entry.severity}] ${entry.summary}: ${entry.reason}`,
  );
  return [
    "You are ChatGPT. Revise your previous answer to address the reviewer's open objections.", "",
    "TASK:", "---", task, "---", "",
    "YOUR PREVIOUS ANSWER:", "---", previousAnswer, "---", "",
    "LATEST CLAUDE REVIEW:", "---", claudeRawReview, "---", "",
    "UNRESOLVED HIGH/MEDIUM OBJECTIONS YOU MUST ADDRESS:",
    ...blockerLines,
    "(if this list is empty, there are no blocking objections — keep your previous answer's",
    "substance unchanged unless a LOW-severity suggestion from the review clearly warrants a",
    "small, harmless improvement; do not make speculative or unrequested changes)", "",
    "Provide your COMPLETE revised, standalone answer to the original task. Return the answer",
    "itself, not commentary about the review, not a changelog, and not any structured review",
    "output.",
  ].join("\n");
}
