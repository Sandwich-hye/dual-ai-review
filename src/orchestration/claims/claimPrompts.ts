import type { ClaimLedgerEntry, Evidence } from "./types";

const claimLine = (entry: ClaimLedgerEntry): string =>
  `- ${entry.id} [${entry.severity}, confidence ${entry.confidence.toFixed(2)}, ${entry.status}] ${entry.claim.statement}: ${entry.claim.rationale}`;

const evidenceLines = (claim: ClaimLedgerEntry, evidence: Evidence[]): string[] => {
  const relevant = evidence.filter((item) => item.claimId === claim.id);
  const supporting = relevant.filter((item) => item.kind !== "CHALLENGING");
  const challenging = relevant.filter((item) => item.kind === "CHALLENGING");
  const format = (items: Evidence[]): string => items.length === 0
    ? "0"
    : items.map((item) => `${item.id} (${item.strength})`).join(", ");
  return [
    `    evidence for: ${format(supporting)}`,
    `    evidence against: ${format(challenging)}`,
  ];
};

export function buildClaimReviewClaudeReviewPrompt(
  task: string,
  answer: string,
  claimLedger: readonly ClaimLedgerEntry[],
  round: number,
): string {
  const schema = [
    "BEGIN_STRUCTURED_REVIEW",
    "{",
    '  "reviewStatus": "CONTINUE" or "CANDIDATE_CONVERGED",',
    '  "resolvedClaimIds": ["CLAIM-1"],',
    '  "resolutionEvidence": { "CLAIM-1": "specific resolution evidence" },',
    '  "stillOpenClaims": [{ "id": "CLAIM-2", "severityOverride": "HIGH" }],',
    '  "reopenedClaims": [{ "id": "CLAIM-3", "note": "why it reappeared", "severityOverride": "MEDIUM" }],',
    '  "newClaims": [{ "severity": "HIGH", "statement": "<claim>", "rationale": "<evidence>" }],',
    '  "reviewNotes": "<optional>"',
    "}",
    "END_STRUCTURED_REVIEW",
  ];

  if (round === 1) {
    return [
      "You are Claude. Review the following answer produced by ChatGPT.",
      "",
      "TASK:", "---", task, "---",
      "",
      "CURRENT CHATGPT ANSWER:", "---", answer, "---",
      "",
      "This is round 1. There is no prior claim ledger, so all claim-id arrays must be empty.",
      "Identify concrete claims that materially affect correctness, completeness, safety, or quality.",
      "Classify each new claim as HIGH, MEDIUM, or LOW. Do not invent speculative claims.",
      "",
      "Return exactly one structured block containing valid JSON:",
      "",
      ...schema,
      "",
      "Use CLAIM-<n> only for ids supplied by a later ledger. Use escaped \\n for line breaks inside JSON strings.",
      "Ordinary prose outside the block is ignored.",
    ].join("\n");
  }

  const ledgerLines = claimLedger.length === 0
    ? ["(the claim ledger is empty)"]
    : claimLedger.flatMap((entry) => [claimLine(entry), `    evidence refs: for=${entry.evidenceFor.join(", ") || "0"}; against=${entry.evidenceAgainst.join(", ") || "0"}`]);

  return [
    "You are Claude. Review the latest revised answer produced by ChatGPT.",
    "",
    "TASK:", "---", task, "---",
    "",
    "LATEST CHATGPT ANSWER:", "---", answer, "---",
    "",
    "CURRENT CLAIM LEDGER:",
    ...ledgerLines,
    "",
    "For each claim in the ledger, decide whether it is resolved or still open in the latest answer.",
    "Reference existing claims by id. If a resolved or rejected claim has returned, use reopenedClaims.",
    "List only genuinely new claims in newClaims. Any resolved claim must have non-empty resolutionEvidence.",
    "",
    "Return exactly one structured block containing valid JSON:",
    "",
    ...schema,
    "",
    "Only reference CLAIM-<n> ids listed in the current claim ledger. Use escaped \\n for line breaks inside JSON strings.",
    "Ordinary prose outside the block is ignored.",
  ].join("\n");
}

export function buildClaimReviewRevisionPrompt(
  task: string,
  previousAnswer: string,
  reviewerRawResponse: string,
  blockingClaims: readonly ClaimLedgerEntry[],
  relevantEvidence: readonly Evidence[],
): string {
  const claimLines = blockingClaims.flatMap((claim) => [
    claimLine(claim),
    ...evidenceLines(claim, [...relevantEvidence]),
  ]);

  return [
    "You are ChatGPT. Revise your previous answer to address the reviewer's unresolved claims.",
    "",
    "TASK:", "---", task, "---",
    "",
    "YOUR PREVIOUS ANSWER:", "---", previousAnswer, "---",
    "",
    "LATEST REVIEWER RESPONSE:", "---", reviewerRawResponse, "---",
    "",
    "UNRESOLVED HIGH/MEDIUM/DISPUTED CLAIMS YOU MUST ADDRESS:",
    ...(claimLines.length === 0 ? ["(there are no blocking claims)"] : claimLines),
    "",
    "Provide your COMPLETE revised, standalone answer to the original task.",
    "A DISPUTED claim has contested evidence; address the claim and, where relevant, the challenging evidence.",
    "Do not make a convergence, acceptance, or rejection decision. Return the answer itself only—no commentary, changelog, or structured review output.",
  ].join("\n");
}
