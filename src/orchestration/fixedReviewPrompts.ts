export function buildInitialChatGptPrompt(task: string): string {
  return task;
}

export function buildClaudeReviewPrompt(task: string, chatgptAnswer: string): string {
  return [
    "You are Claude. Review the following answer produced by ChatGPT.", "",
    "Original task:", "---", task, "---", "",
    "Current ChatGPT answer:", "---", chatgptAnswer, "---", "",
    "Review it critically but fairly. Identify concrete errors, missing requirements, risks,",
    "and suggested fixes. Focus on actionable feedback. Do not include STATUS output or a",
    "convergence verdict; return only the review.",
  ].join("\n");
}

export function buildChatGptRevisionPrompt(task: string, previousAnswer: string, claudeReview: string): string {
  return [
    "You are ChatGPT. Revise your answer based on Claude's review below.", "",
    "Original task:", "---", task, "---", "",
    "Your previous ChatGPT answer:", "---", previousAnswer, "---", "",
    "Latest Claude review:", "---", claudeReview, "---", "",
    "Return a COMPLETE revised, standalone answer to the original task.",
    "Return the answer itself, not commentary about the review, not a change log, and not STATUS output.",
  ].join("\n");
}
