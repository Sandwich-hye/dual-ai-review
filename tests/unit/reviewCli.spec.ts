import { expect, test } from "@playwright/test";
import type { AuditedReviewResult } from "../../src/orchestration/claims/types";
import { completeReviewAudit, failedReviewAudit } from "../../src/cli/reviewAudit";
import { buildOriginalTask, parseReviewArgs } from "../../src/cli/reviewInput";
import { renderTerminalReport } from "../../src/cli/renderTerminalReport";

test("CLI input keeps task and diff while requiring explicit Ollama model", () => {
  expect(parseReviewArgs(["--task", "Check this change", "--provider", "ollama", "--model", "test-model"])).toEqual({
    task: "Check this change", provider: "ollama", model: "test-model",
  });
  expect(() => parseReviewArgs(["--task", "Check", "--provider", "ollama"])).toThrow("--model is required");
  expect(() => parseReviewArgs(["--task", "Check", "--provider", "browser", "--model", "test-model"])).toThrow("only valid");
  expect(buildOriginalTask({ task: "Check", diff: "-old\n+new" })).toContain("<code_diff>\n-old\n+new\n</code_diff>");
});

test("terminal report uses explicit provider provenance, not legacy loop slot names", () => {
  const result = {
    outcome: "ACCEPTED", outcomeOrigin: "HUMAN_AGREED_WITH_RECOMMENDATION", finalAnswer: "The answer.",
    rounds: [], claimLedger: [], evidenceLog: [],
  } as unknown as AuditedReviewResult;
  const rendered = renderTerminalReport(result, {
    generator: { providerName: "ollama", modelName: "test-model", executionMode: "local_http" },
    reviewer: { providerName: "ollama", modelName: "test-model", executionMode: "local_http" },
  }, "audit.json");
  expect(rendered).toContain("Generator LLM: ollama / test-model / local_http");
  expect(rendered).toContain("Reviewer LLM: ollama / test-model / local_http");
  expect(rendered).toContain("Audit JSON: audit.json");
  expect(rendered).not.toContain("ChatGPT");
  expect(rendered).not.toContain("Claude");
});

test("complete and failed audit envelopes preserve explicit provenance with one schema", () => {
  const providers = {
    generator: { providerName: "ollama", modelName: "test-model", executionMode: "local_http" as const },
    reviewer: { providerName: "ollama", modelName: "test-model", executionMode: "local_http" as const },
  };
  const review = { schemaVersion: 1, outcome: "ACCEPTED" } as AuditedReviewResult;
  const complete = JSON.parse(JSON.stringify(completeReviewAudit("ollama", providers, review)));
  const failed = JSON.parse(JSON.stringify(failedReviewAudit(
    "ollama", providers,
    { stage: { round: 1, turn: "claude_review", site: "claude", step: "extract" }, message: "Malformed review" },
    { originalTask: "Task", hardMaxRounds: 10, recommendedMaxRounds: 6, rounds: [], claimLedger: [], evidenceLog: [], runAuditTrail: [] },
  )));
  expect(complete).toMatchObject({ schemaVersion: 2, status: "complete", providerMode: "ollama", providers, review: { schemaVersion: 1 } });
  expect(failed).toMatchObject({ schemaVersion: 2, status: "failed", providerMode: "ollama", providers, failure: { message: "Malformed review" } });
  expect(complete).not.toHaveProperty("partialReview");
  expect(failed).not.toHaveProperty("review");
  expect(failed.partialReview).not.toHaveProperty("schemaVersion");
  expect(() => completeReviewAudit("browser", providers, review)).toThrow("provider provenance does not match browser mode");
});
