import { test, expect } from "@playwright/test";
import {
  buildConvergenceChatGptRevisionPrompt,
  buildConvergenceClaudeReviewPrompt,
  buildConvergenceInitialChatGptPrompt,
} from "../../src/orchestration/convergence/convergencePrompts";
import type { ObjectionLedgerEntry } from "../../src/orchestration/convergence/types";

const entry = (over: Partial<ObjectionLedgerEntry> = {}): ObjectionLedgerEntry => ({
  id: "OBJ-1", severity: "HIGH", highestSeveritySeen: "HIGH", summary: "missing validation", reason: "input is not validated",
  status: "OPEN", firstSeenRound: 1, lastSeenRound: 1, normalizedFingerprint: [], history: [], ...over,
});

test("the initial ChatGPT prompt is exactly the task", () => {
  expect(buildConvergenceInitialChatGptPrompt("do X")).toBe("do X");
});

test("round 1 Claude review prompt names Claude, carries the task and answer, and requires no prior OBJ ids", () => {
  const prompt = buildConvergenceClaudeReviewPrompt("TASK-A", "ANSWER-A", [], 1);
  expect(prompt).toContain("You are Claude.");
  expect(prompt).toContain("TASK-A");
  expect(prompt).toContain("ANSWER-A");
  expect(prompt).toContain("BEGIN_STRUCTURED_REVIEW");
  expect(prompt).toContain("END_STRUCTURED_REVIEW");
  expect(prompt).toContain("round 1");
  expect(prompt).not.toContain("OBJ-");
});

test("round N Claude review prompt lists exact open OBJ ids, severities, and summaries", () => {
  const entries = [
    entry({ id: "OBJ-1", severity: "HIGH", summary: "missing validation", reason: "input is not validated" }),
    entry({ id: "OBJ-3", severity: "MEDIUM", summary: "slow path", reason: "O(n^2) loop" }),
  ];
  const prompt = buildConvergenceClaudeReviewPrompt("TASK-A", "ANSWER-B", entries, 2);
  expect(prompt).toContain("OBJ-1");
  expect(prompt).toContain("OBJ-3");
  expect(prompt).toContain("[HIGH]");
  expect(prompt).toContain("[MEDIUM]");
  expect(prompt).toContain("missing validation");
  expect(prompt).toContain("slow path");
  expect(prompt).toContain("ANSWER-B");
});

test("the ChatGPT revision prompt names ChatGPT, requests a complete answer, and lists HIGH/MEDIUM blockers", () => {
  const blockers = [entry({ id: "OBJ-1", severity: "HIGH", summary: "missing validation", reason: "input is not validated" })];
  const prompt = buildConvergenceChatGptRevisionPrompt("TASK-A", "PREV-ANSWER", "RAW-REVIEW-TEXT", blockers);
  expect(prompt).toContain("You are ChatGPT.");
  expect(prompt).toContain("TASK-A");
  expect(prompt).toContain("PREV-ANSWER");
  expect(prompt).toContain("RAW-REVIEW-TEXT");
  expect(prompt).toContain("COMPLETE");
  expect(prompt).toContain("[HIGH] missing validation: input is not validated");
});

test("the ChatGPT revision prompt permits leaving the answer unchanged when there are no blocking objections", () => {
  const prompt = buildConvergenceChatGptRevisionPrompt("TASK-A", "PREV-ANSWER", "RAW-REVIEW-TEXT", []);
  expect(prompt).toContain("no blocking objections");
  expect(prompt).toContain("keep your previous answer's");
});

test("prompts never leak fixed-loop STATUS/convergence conventions", () => {
  const claudePrompt = buildConvergenceClaudeReviewPrompt("T", "A", [], 1);
  const chatgptPrompt = buildConvergenceChatGptRevisionPrompt("T", "A", "R", []);
  expect(claudePrompt).not.toContain("STATUS:");
  expect(chatgptPrompt).not.toContain("STATUS:");
});
