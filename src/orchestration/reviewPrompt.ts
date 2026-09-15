export function buildClaudeReviewPrompt(originalTask: string, chatgptResponse: string): string {
  return [
    "You are the reviewer.",
    "",
    "Original task:",
    "---",
    originalTask,
    "---",
    "",
    "ChatGPT's proposed answer:",
    "---",
    chatgptResponse,
    "---",
    "",
    "Review the proposed answer.",
    "",
    "Identify:",
    "- factual or logical errors",
    "- missing requirements",
    "- implementation risks",
    "- unnecessary complexity",
    "",
    "For this Milestone 3 test, return a concise review.",
  ].join("\n");
}

