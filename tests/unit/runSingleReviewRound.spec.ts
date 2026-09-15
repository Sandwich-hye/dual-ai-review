import { test, expect } from "@playwright/test";
import { runSingleReviewRound, SingleReviewRoundError } from "../../src/orchestration/runSingleReviewRound";
import { ConversationalSiteAdapter, GenerationOutcome, TurnBaseline, SiteLoadStatus } from "../../src/sites/siteTypes";
import { Page } from "playwright";

type FakeOptions = {
  name: string;
  response: string;
  calls: string[];
  ready?: SiteLoadStatus;
  failure?: string;
};

function fakeAdapter(options: FakeOptions): ConversationalSiteAdapter {
  const baseline: TurnBaseline = { count: 0, ids: new Set() };
  const fail = (stage: string): never => { throw new Error(options.failure ?? stage + " failed"); };
  return {
    name: options.name,
    url: "https://example.test",
    checkReady: async () => { options.calls.push(options.name + ".checkReady"); return options.ready ?? "ready"; },
    captureTurnBaseline: async () => { options.calls.push(options.name + ".baseline"); return baseline; },
    sendPrompt: async (page, prompt) => { void page; options.calls.push(options.name + ".send:" + prompt); if (options.failure === "send") fail("send"); },
    waitForGenerationStart: async () => { options.calls.push(options.name + ".start"); if (options.failure === "start") fail("start"); return "started"; },
    waitForGenerationComplete: async (): Promise<GenerationOutcome> => {
      options.calls.push(options.name + ".complete");
      if (options.failure === "timeout") return { outcome: "timeout", partialText: "partial", diagnostics: { generationActiveVisible: true, newResponseFound: true, textLength: 7, textStableForMs: 0, sendVisible: false } };
      if (options.failure === "complete") return { outcome: "error_banner", detail: "failed" };
      return { outcome: "complete" };
    },
    getLatestAssistantResponse: async () => { options.calls.push(options.name + ".extract"); if (options.failure === "extract") fail("extract"); return options.response; },
  };
}

function input(chatgpt: FakeOptions, claude: FakeOptions) {
  return {
    originalTask: "Give exactly three practical benefits of automated software testing.",
    chatgpt: { page: {} as Page, adapter: fakeAdapter(chatgpt) },
    claude: { page: {} as Page, adapter: fakeAdapter(claude) },
  };
}

test("runs exactly one ChatGPT to Claude handoff in order", async () => {
  const calls: string[] = [];
  const result = await runSingleReviewRound(input(
    { name: "chatgpt", response: "three benefits", calls },
    { name: "claude", response: "concise review", calls },
  ));
  expect(result).toEqual({
    originalTask: "Give exactly three practical benefits of automated software testing.",
    chatgptResponse: "three benefits",
    claudeReview: "concise review",
  });
  expect(calls.map(call => call.split(":")[0])).toEqual([
    "chatgpt.checkReady", "chatgpt.baseline", "chatgpt.send", "chatgpt.start",
    "chatgpt.complete", "chatgpt.extract", "claude.checkReady", "claude.baseline",
    "claude.send", "claude.start", "claude.complete", "claude.extract",
  ]);
  expect(calls.filter(call => call.startsWith("chatgpt.send:"))).toHaveLength(1);
  expect(calls.filter(call => call.startsWith("claude.send:"))).toHaveLength(1);
});

test("preserves the original task and inserts ChatGPT output in the Claude prompt", async () => {
  const calls: string[] = [];
  await runSingleReviewRound(input(
    { name: "chatgpt", response: "PROPOSED ANSWER", calls },
    { name: "claude", response: "REVIEW", calls },
  ));
  const prompt = calls.find(call => call.startsWith("claude.send:")) ?? "";
  expect(prompt).toContain("Give exactly three practical benefits of automated software testing.");
  expect(prompt).toContain("PROPOSED ANSWER");
  expect(prompt).toContain("You are the reviewer.");
});

test("ChatGPT failure prevents Claude send", async () => {
  const calls: string[] = [];
  await expect(runSingleReviewRound(input(
    { name: "chatgpt", response: "", calls, failure: "timeout" },
    { name: "claude", response: "must not run", calls },
  ))).rejects.toMatchObject<Partial<SingleReviewRoundError>>({ stage: "waiting for ChatGPT generation completion" });
  expect(calls.some(call => call.startsWith("claude.send:"))).toBe(false);
});

test("Claude failure is reported at the Claude stage", async () => {
  const calls: string[] = [];
  await expect(runSingleReviewRound(input(
    { name: "chatgpt", response: "answer", calls },
    { name: "claude", response: "", calls, failure: "complete" },
  ))).rejects.toMatchObject<Partial<SingleReviewRoundError>>({ stage: "waiting for Claude generation completion" });
  expect(calls.filter(call => call.startsWith("chatgpt.send:"))).toHaveLength(1);
  expect(calls.filter(call => call.startsWith("claude.send:"))).toHaveLength(1);
});

test("readiness failure stops safely before that site sends", async () => {
  const calls: string[] = [];
  await expect(runSingleReviewRound(input(
    { name: "chatgpt", response: "answer", calls },
    { name: "claude", response: "", calls, ready: "login_required" },
  ))).rejects.toMatchObject<Partial<SingleReviewRoundError>>({ stage: "checking Claude readiness" });
  expect(calls.some(call => call.startsWith("claude.send:"))).toBe(false);
});

