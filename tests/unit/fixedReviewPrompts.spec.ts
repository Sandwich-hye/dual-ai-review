import { test, expect } from "@playwright/test";
import { buildInitialChatGptPrompt, buildClaudeReviewPrompt, buildChatGptRevisionPrompt } from "../../src/orchestration/fixedReviewPrompts";

test("fixed prompt builders preserve handoff content and exclude status logic", () => {
  const task = "TASK";
  expect(buildInitialChatGptPrompt(task)).toBe(task);
  const review = buildClaudeReviewPrompt(task, "G0");
  expect(review).toContain("You are Claude.");
  expect(review).toContain("answer produced by ChatGPT");
  expect(review).toContain("TASK"); expect(review).toContain("G0");
  expect(review).toContain("concrete errors"); expect(review).toContain("missing requirements");
  expect(review).toContain("risks"); expect(review).toContain("suggested fixes");
  expect(review).not.toContain("STATUS: CONTINUE"); expect(review).not.toContain("STATUS: CONVERGED");
  expect(review).not.toContain("another AI");
  const revision = buildChatGptRevisionPrompt(task, "G0", "C1");
  expect(revision).toContain("You are ChatGPT.");
  expect(revision).toContain("Claude's review");
  expect(revision).toContain("TASK"); expect(revision).toContain("G0"); expect(revision).toContain("C1");
  expect(revision).toContain("COMPLETE revised"); expect(revision).toContain("not commentary");
  expect(revision).toContain("not a change log"); expect(revision).toContain("not STATUS output");
  expect(revision).not.toContain("another AI");
});
