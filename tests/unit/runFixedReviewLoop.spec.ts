import { test, expect } from "@playwright/test";
import { Page } from "playwright";
import { FixedReviewLoopError, runFixedReviewLoop, FixedReviewLoopInput } from "../../src/orchestration/runFixedReviewLoop";
import { ConversationalSiteAdapter, GenerationOutcome } from "../../src/sites/siteTypes";

type Fake = { adapter: ConversationalSiteAdapter; sends: string[]; calls: string[]; startTimeouts: number[]; completionTimeouts: number[] };
type Failure = { method: "sendPrompt" | "waitForGenerationStart" | "waitForGenerationComplete" | "getLatestAssistantResponse"; occurrence: number; outcome?: GenerationOutcome };
const task = "TASK: provide a safe answer";

function fake(name: "chatgpt" | "claude", responses: string[], calls: string[], failure?: Failure): Fake {
  const sends: string[] = []; const startTimeouts: number[] = []; const completionTimeouts: number[] = []; const counts = new Map<string, number>();
  const hit = (method: string): Failure | undefined => { const n = (counts.get(method) ?? 0) + 1; counts.set(method, n); return failure?.method === method && failure.occurrence === n ? failure : undefined; };
  const adapter: ConversationalSiteAdapter = {
    name, url: "https://example.test",
    checkReady: async () => { calls.push(name + ".ready"); return "ready"; },
    captureTurnBaseline: async () => { calls.push(name + ".baseline"); return { count: counts.get("baseline") ?? 0, ids: new Set() }; },
    sendPrompt: async (_page, prompt) => { calls.push(name + ".send"); sends.push(prompt); if (hit("sendPrompt")) throw new Error("ambiguous submission"); },
    waitForGenerationStart: async (_page, _baseline, options) => { calls.push(name + ".start"); startTimeouts.push(options?.startTimeoutMs ?? -1); return hit("waitForGenerationStart") ? "not_observed" : "started"; },
    waitForGenerationComplete: async (_page, _baseline, timeoutMs): Promise<GenerationOutcome> => { calls.push(name + ".complete"); completionTimeouts.push(timeoutMs); const f = hit("waitForGenerationComplete"); return f?.outcome ?? { outcome: "complete" }; },
    getLatestAssistantResponse: async () => { calls.push(name + ".extract"); if (hit("getLatestAssistantResponse")) throw new Error("ambiguous response"); const response = responses.shift(); if (response === undefined) throw new Error("response queue exhausted"); return response; },
  };
  return { adapter, sends, calls, startTimeouts, completionTimeouts };
}

function input(rounds: number, chatgpt: Fake, claude: Fake, options: Pick<FixedReviewLoopInput, "generationStartTimeoutMs"> = {}): FixedReviewLoopInput { return { originalTask: task, reviewRounds: rounds, ...options, chatgpt: { page: {} as Page, adapter: chatgpt.adapter }, claude: { page: {} as Page, adapter: claude.adapter } }; }
function sends(fake: Fake): number { return fake.calls.filter(call => call === fake.adapter.name + ".send").length; }

test("reviewRounds=2 has exact G0 C1 G1 C2 G2 call order", async () => {
  const calls: string[] = []; const g = fake("chatgpt", ["G0", "G1", "G2"], calls); const c = fake("claude", ["C1", "C2"], calls);
  const result = await runFixedReviewLoop(input(2, g, c));
  expect(calls.filter(call => call.endsWith(".send"))).toEqual(["chatgpt.send", "claude.send", "chatgpt.send", "claude.send", "chatgpt.send"]);
  expect(result.initial.response).toBe("G0"); expect(result.rounds.map(r => [r.claudeReviewResponse, r.chatgptRevisionResponse])).toEqual([["C1", "G1"], ["C2", "G2"]]); expect(result.finalAnswer).toBe("G2");
});

test("reviewRounds=1 and other positive counts are configurable", async () => {
  for (const rounds of [1, 2, 3, 5]) { const calls: string[] = []; const g = fake("chatgpt", Array.from({ length: rounds + 1 }, (_, i) => "G" + i), calls); const c = fake("claude", Array.from({ length: rounds }, (_, i) => "C" + (i + 1)), calls); const result = await runFixedReviewLoop(input(rounds, g, c)); expect(result.rounds).toHaveLength(rounds); expect(sends(g)).toBe(rounds + 1); expect(sends(c)).toBe(rounds); }
});

test("uses a 30000ms default start timeout on every turn and keeps completion timeout separate", async () => {
  const calls: string[] = []; const g = fake("chatgpt", ["G0", "G1", "G2"], calls); const c = fake("claude", ["C1", "C2"], calls);
  await runFixedReviewLoop({ ...input(2, g, c), chatgpt: { page: {} as Page, adapter: g.adapter, generationTimeoutMs: 181000 }, claude: { page: {} as Page, adapter: c.adapter, generationTimeoutMs: 182000 } });
  expect(g.startTimeouts).toEqual([30000, 30000, 30000]); expect(c.startTimeouts).toEqual([30000, 30000]);
  expect(g.completionTimeouts).toEqual([181000, 181000, 181000]); expect(c.completionTimeouts).toEqual([182000, 182000]);
});

test("uses the configured start timeout for G0 C1 G1 C2 G2", async () => {
  const calls: string[] = []; const g = fake("chatgpt", ["G0", "G1", "G2"], calls); const c = fake("claude", ["C1", "C2"], calls);
  await runFixedReviewLoop(input(2, g, c, { generationStartTimeoutMs: 42000 }));
  expect(g.startTimeouts).toEqual([42000, 42000, 42000]); expect(c.startTimeouts).toEqual([42000, 42000]);
});

test("a generation-start timeout stops safely without resending and retains prior rounds", async () => {
  const calls: string[] = []; const g = fake("chatgpt", ["G0", "G1", "unused"], calls); const c = fake("claude", ["C1", "unused"], calls, { method: "waitForGenerationStart", occurrence: 2 });
  const error = await runFixedReviewLoop(input(2, g, c)).catch(value => value as FixedReviewLoopError);
  expect(error).toBeInstanceOf(FixedReviewLoopError); expect(error.stage).toEqual({ round: 2, turn: "claude_review", site: "claude", step: "generation_start" });
  expect(error.partialResult.rounds).toHaveLength(1); expect(sends(g)).toBe(2); expect(sends(c)).toBe(2);
});
test("invalid reviewRounds values are rejected clearly", async () => {
  const g = fake("chatgpt", [], []); const c = fake("claude", [], []);
  for (const rounds of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) await expect(runFixedReviewLoop(input(rounds, g, c))).rejects.toThrow("reviewRounds must be an integer greater than or equal to 1");
});

test("every prompt contains the task and each handoff uses the immediately prior turn", async () => {
  const calls: string[] = []; const g = fake("chatgpt", ["G0", "G1", "G2"], calls); const c = fake("claude", ["C1", "C2"], calls); await runFixedReviewLoop(input(2, g, c));
  for (const prompt of [...g.sends, ...c.sends]) expect(prompt).toContain(task);
  expect(c.sends[0]).toContain("G0"); expect(c.sends[0]).not.toContain("G1"); expect(c.sends[1]).toContain("G1"); expect(c.sends[1]).not.toContain("G2");
  expect(g.sends[1]).toContain("C1"); expect(g.sends[2]).toContain("C2"); expect(g.sends[1]).toContain("COMPLETE revised");
});

test("Claude round 2 failure stops immediately and keeps round 1", async () => {
  const calls: string[] = []; const g = fake("chatgpt", ["G0", "G1", "unused"], calls); const c = fake("claude", ["C1", "unused"], calls, { method: "getLatestAssistantResponse", occurrence: 2 });
  const error = await runFixedReviewLoop(input(3, g, c)).catch(value => value as FixedReviewLoopError);
  expect(error).toBeInstanceOf(FixedReviewLoopError); expect(error.stage).toEqual({ round: 2, turn: "claude_review", site: "claude", step: "extract" }); expect(error.partialResult.initial?.response).toBe("G0"); expect(error.partialResult.rounds).toHaveLength(1); expect(sends(g)).toBe(2); expect(sends(c)).toBe(2);
});

test("ChatGPT revision failure stops immediately and does not call Claude again", async () => {
  const calls: string[] = []; const timeout: GenerationOutcome = { outcome: "timeout", partialText: "partial", diagnostics: { generationActiveVisible: true, newResponseFound: true, textLength: 7, textStableForMs: 0, sendVisible: false } }; const g = fake("chatgpt", ["G0", "partial"], calls, { method: "waitForGenerationComplete", occurrence: 2, outcome: timeout }); const c = fake("claude", ["C1", "unused"], calls);
  const error = await runFixedReviewLoop(input(2, g, c)).catch(value => value as FixedReviewLoopError);
  expect(error.stage).toEqual({ round: 1, turn: "chatgpt_revision", site: "chatgpt", step: "generation_complete" }); expect(error.partialResult.initial?.response).toBe("G0"); expect(error.partialResult.rounds).toHaveLength(0); expect(sends(c)).toBe(1);
});

test("send failure is never resubmitted and no convergence/status behavior exists", async () => {
  const calls: string[] = []; const g = fake("chatgpt", [], calls, { method: "sendPrompt", occurrence: 1 }); const c = fake("claude", [], calls); const error = await runFixedReviewLoop(input(1, g, c)).catch(value => value as FixedReviewLoopError);
  expect(error.stage).toEqual({ round: 0, turn: "initial", site: "chatgpt", step: "send" }); expect(sends(g)).toBe(1); expect(sends(c)).toBe(0);
  const okCalls: string[] = []; const okG = fake("chatgpt", ["G0", "G1"], okCalls); const okC = fake("claude", ["C1"], okCalls); const result = await runFixedReviewLoop(input(1, okG, okC)); expect(JSON.stringify(result)).not.toContain("STATUS:"); expect(JSON.stringify(result)).not.toContain("converged");
});
