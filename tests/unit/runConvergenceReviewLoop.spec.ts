import { test, expect } from "@playwright/test";
import { Page } from "playwright";
import { ConvergenceReviewLoopError, runConvergenceReviewLoop, ConvergenceReviewLoopInput } from "../../src/orchestration/runConvergenceReviewLoop";
import { ConversationalSiteAdapter, GenerationOutcome } from "../../src/sites/siteTypes";

const task = "TASK: provide a safe answer";
const BEGIN = "BEGIN_STRUCTURED_REVIEW";
const END = "END_STRUCTURED_REVIEW";

function block(payload: Record<string, unknown>): string {
  return ["Some preamble.", BEGIN, JSON.stringify(payload, null, 2), END, "Some postamble."].join("\n");
}
function clean(): string {
  return block({ reviewStatus: "CONTINUE", resolvedObjectionIds: [], resolutionEvidence: {}, stillOpenObjections: [], reopenedObjections: [], newObjections: [] });
}
function withNew(severity: "HIGH" | "MEDIUM" | "LOW", summary: string, reason: string): string {
  return block({ reviewStatus: "CONTINUE", resolvedObjectionIds: [], resolutionEvidence: {}, stillOpenObjections: [], reopenedObjections: [], newObjections: [{ severity, summary, reason }] });
}
function withStillOpen(id: string): string {
  return block({ reviewStatus: "CONTINUE", resolvedObjectionIds: [], resolutionEvidence: {}, stillOpenObjections: [{ id }], reopenedObjections: [], newObjections: [] });
}
function withResolved(id: string, evidence: string): string {
  return block({ reviewStatus: "CANDIDATE_CONVERGED", resolvedObjectionIds: [id], resolutionEvidence: { [id]: evidence }, stillOpenObjections: [], reopenedObjections: [], newObjections: [] });
}

type Fake = { adapter: ConversationalSiteAdapter; sends: string[]; calls: string[] };
type Failure = { method: "sendPrompt" | "waitForGenerationStart" | "waitForGenerationComplete" | "getLatestAssistantResponse"; occurrence: number; outcome?: GenerationOutcome };

function fake(name: "chatgpt" | "claude", responses: string[], calls: string[], failure?: Failure): Fake {
  const sends: string[] = [];
  const counts = new Map<string, number>();
  const hit = (method: string): Failure | undefined => {
    const n = (counts.get(method) ?? 0) + 1;
    counts.set(method, n);
    return failure?.method === method && failure.occurrence === n ? failure : undefined;
  };
  const adapter: ConversationalSiteAdapter = {
    name, url: "https://example.test",
    checkReady: async () => { calls.push(name + ".ready"); return "ready"; },
    captureTurnBaseline: async () => { calls.push(name + ".baseline"); return { count: 0, ids: new Set() }; },
    sendPrompt: async (_page, prompt) => { calls.push(name + ".send"); sends.push(prompt); if (hit("sendPrompt")) throw new Error("ambiguous submission"); },
    waitForGenerationStart: async (_page, _baseline, _options) => { calls.push(name + ".start"); return hit("waitForGenerationStart") ? "not_observed" : "started"; },
    waitForGenerationComplete: async (): Promise<GenerationOutcome> => { calls.push(name + ".complete"); const f = hit("waitForGenerationComplete"); return f?.outcome ?? { outcome: "complete" }; },
    getLatestAssistantResponse: async () => { calls.push(name + ".extract"); if (hit("getLatestAssistantResponse")) throw new Error("ambiguous response"); const response = responses.shift(); if (response === undefined) throw new Error("response queue exhausted"); return response; },
  };
  return { adapter, sends, calls };
}
function input(chatgpt: Fake, claude: Fake, options: Partial<ConvergenceReviewLoopInput> = {}): ConvergenceReviewLoopInput {
  return { originalTask: task, chatgpt: { page: {} as Page, adapter: chatgpt.adapter }, claude: { page: {} as Page, adapter: claude.adapter }, ...options };
}
function sends(f: Fake): number { return f.calls.filter(call => call === f.adapter.name + ".send").length; }

test("two clean rounds converge without a trailing revision after the second", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0", "G1"], calls);
  const c = fake("claude", [clean(), clean()], calls);
  const result = await runConvergenceReviewLoop(input(g, c));
  expect(result.stopReason).toBe("CONVERGED");
  expect(result.finalAnswer).toBe("G1");
  expect(sends(g)).toBe(2);
  expect(sends(c)).toBe(2);
  expect(calls.filter(x => x.endsWith(".send"))).toEqual(["chatgpt.send", "claude.send", "chatgpt.send", "claude.send"]);
});

test("a MEDIUM blocker prevents convergence until resolved, then requires one more clean round", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0", "G1", "G2"], calls);
  const c = fake("claude", [withNew("MEDIUM", "missing validation", "no input validation"), withResolved("OBJ-1", "added validation"), clean()], calls);
  const result = await runConvergenceReviewLoop(input(g, c));
  expect(result.stopReason).toBe("CONVERGED");
  expect(result.finalAnswer).toBe("G2");
  expect(sends(g)).toBe(3);
  expect(sends(c)).toBe(3);
});

test("a new blocker after one clean round resets the stability streak", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0", "G1", "G2", "G3"], calls);
  const c = fake("claude", [clean(), withNew("MEDIUM", "new gap", "found after revision"), withResolved("OBJ-1", "fixed"), clean()], calls);
  const result = await runConvergenceReviewLoop(input(g, c));
  expect(result.stopReason).toBe("CONVERGED");
  expect(result.finalAnswer).toBe("G3");
  expect(sends(c)).toBe(4);
});

test("LOW-only objections never block; two rounds of LOW churn still converge on schedule", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0", "G1"], calls);
  const c = fake("claude", [withNew("LOW", "style nit", "cosmetic"), withNew("LOW", "another nit", "cosmetic 2")], calls);
  const result = await runConvergenceReviewLoop(input(g, c));
  expect(result.stopReason).toBe("CONVERGED");
  expect(result.finalAnswer).toBe("G1");
});

test("maxRounds stops after the final permitted Claude review with no trailing ChatGPT revision", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0", "G1", "G2"], calls);
  const c = fake("claude", [withNew("HIGH", "bug1", "reason1"), withNew("HIGH", "bug2", "reason2"), withNew("HIGH", "bug3", "reason3")], calls);
  const result = await runConvergenceReviewLoop(input(g, c, { options: { maxRounds: 3 } }));
  expect(result.stopReason).toBe("MAX_ROUNDS_REACHED");
  expect(sends(g)).toBe(3);
  expect(sends(c)).toBe(3);
  expect(result.finalAnswer).toBe("G2");
});

test("final round convergence takes priority over MAX_ROUNDS_REACHED", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0", "G1"], calls);
  const c = fake("claude", [clean(), clean()], calls);
  const result = await runConvergenceReviewLoop(input(g, c, { options: { maxRounds: 2 } }));
  expect(result.stopReason).toBe("CONVERGED");
});

test("a malformed Claude review stops safely as INVALID_REVIEW without a trailing revision", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0"], calls);
  const c = fake("claude", ["not a structured review at all"], calls);
  const result = await runConvergenceReviewLoop(input(g, c));
  expect(result.stopReason).toBe("INVALID_REVIEW");
  expect(result.finalAnswer).toBe("G0");
  expect(result.invalidReview?.reason).toContain("delimiters");
  expect(sends(g)).toBe(1);
  expect(sends(c)).toBe(1);
});

test("INVALID_REVIEW at maxRounds wins over MAX_ROUNDS_REACHED", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0", "G1"], calls);
  const c = fake("claude", [withNew("HIGH", "bug", "reason"), "malformed final review"], calls);
  const result = await runConvergenceReviewLoop(input(g, c, { options: { maxRounds: 2 } }));
  expect(result.stopReason).toBe("INVALID_REVIEW");
  expect(result.stopReason).not.toBe("MAX_ROUNDS_REACHED");
  expect(result.stopReason).not.toBe("CONVERGED");
  expect(result.finalAnswer).toBe("G1");
  expect(sends(g)).toBe(2);
  expect(sends(c)).toBe(2);
  expect(result.rounds).toHaveLength(2);
  expect(result.rounds[1].decision.kind).toBe("INVALID_REVIEW");
  expect(result.convergenceHistory.rounds).toHaveLength(2);
  expect(result.convergenceHistory.rounds[1].decision).toEqual(result.rounds[1].decision);
  expect(result.convergenceHistory.rounds[1].ledgerSnapshot).toEqual(result.ledger);
  expect(result.convergenceHistory.rounds[1].decision.cleanStreak).toBe(0);
  expect(result.ledger[0].status).toBe("OPEN");
});

test("a ChatGPT revision failure exposes the ingested Claude state in partialResult", async () => {
  const calls: string[] = [];
  const timeout: GenerationOutcome = { outcome: "timeout", partialText: "partial", diagnostics: { generationActiveVisible: true, newResponseFound: true, textLength: 7, textStableForMs: 0, sendVisible: false } };
  const g = fake("chatgpt", ["G0", "discarded"], calls, { method: "waitForGenerationComplete", occurrence: 2, outcome: timeout });
  const c = fake("claude", [withNew("MEDIUM", "issue", "reason")], calls);
  const error = await runConvergenceReviewLoop(input(g, c)).catch(e => e as ConvergenceReviewLoopError);
  expect(error.stage).toEqual({ round: 1, turn: "chatgpt_revision", site: "chatgpt", step: "generation_complete" });
  expect(sends(g)).toBe(2);
  expect(sends(c)).toBe(1);
  expect(error.partialResult.initial?.response).toBe("G0");
  expect(error.partialResult.rounds).toHaveLength(0);
  expect(error.partialResult.ledger).toHaveLength(1);
  expect(error.partialResult.ledger[0].status).toBe("OPEN");
  expect(error.partialResult.convergenceHistory.rounds).toHaveLength(1);
  expect(error.partialResult.convergenceHistory.rounds[0].decision.kind).toBe("CONTINUE");
  expect(error.partialResult.convergenceHistory.rounds[0].ledgerSnapshot).toEqual(error.partialResult.ledger);
});
test("an unknown objection id in a later round stops safely as INVALID_REVIEW", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0", "G1"], calls);
  const c = fake("claude", [withNew("HIGH", "bug", "reason"), withStillOpen("OBJ-9")], calls);
  const result = await runConvergenceReviewLoop(input(g, c));
  expect(result.stopReason).toBe("INVALID_REVIEW");
  expect(result.invalidReview?.reason).toContain("OBJ-9");
  expect(sends(g)).toBe(2);
  expect(sends(c)).toBe(2);
});

test("a newObjections entry that fingerprint-matches an id already referenced elsewhere in the same review is INVALID_REVIEW", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0", "G1"], calls);
  const summary = "retry timeout handling missing backoff";
  const reason = "retry timeout handling missing exponential backoff logic";
  const c = fake("claude", [
    withNew("MEDIUM", summary, reason),
    block({ reviewStatus: "CONTINUE", resolvedObjectionIds: ["OBJ-1"], resolutionEvidence: { "OBJ-1": "fixed" }, stillOpenObjections: [], reopenedObjections: [], newObjections: [{ severity: "MEDIUM", summary, reason }] }),
  ], calls);
  const result = await runConvergenceReviewLoop(input(g, c));
  expect(result.stopReason).toBe("INVALID_REVIEW");
  expect(result.invalidReview?.reason).toContain("OBJ-1");
});

test("a ChatGPT generation-start failure stops without a duplicate send", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0"], calls, { method: "waitForGenerationStart", occurrence: 1 });
  const c = fake("claude", [], calls);
  const error = await runConvergenceReviewLoop(input(g, c)).catch(e => e as ConvergenceReviewLoopError);
  expect(error).toBeInstanceOf(ConvergenceReviewLoopError);
  expect(error.stage).toEqual({ round: 0, turn: "initial", site: "chatgpt", step: "generation_start" });
  expect(sends(g)).toBe(1);
});

test("a Claude generation-start failure stops without a duplicate send", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0"], calls);
  const c = fake("claude", ["unused"], calls, { method: "waitForGenerationStart", occurrence: 1 });
  const error = await runConvergenceReviewLoop(input(g, c)).catch(e => e as ConvergenceReviewLoopError);
  expect(error.stage).toEqual({ round: 1, turn: "claude_review", site: "claude", step: "generation_start" });
  expect(sends(c)).toBe(1);
});

test("a ChatGPT generation-completion failure stops without a duplicate send", async () => {
  const calls: string[] = [];
  const timeout: GenerationOutcome = { outcome: "timeout", partialText: "partial", diagnostics: { generationActiveVisible: true, newResponseFound: true, textLength: 7, textStableForMs: 0, sendVisible: false } };
  const g = fake("chatgpt", ["G0", "partial"], calls, { method: "waitForGenerationComplete", occurrence: 2, outcome: timeout });
  const c = fake("claude", [withNew("MEDIUM", "issue", "reason")], calls);
  const error = await runConvergenceReviewLoop(input(g, c)).catch(e => e as ConvergenceReviewLoopError);
  expect(error.stage).toEqual({ round: 1, turn: "chatgpt_revision", site: "chatgpt", step: "generation_complete" });
  expect(sends(g)).toBe(2);
  expect(sends(c)).toBe(1);
});

test("a Claude generation-completion failure stops without a duplicate send", async () => {
  const calls: string[] = [];
  const timeout: GenerationOutcome = { outcome: "timeout", partialText: "partial", diagnostics: { generationActiveVisible: true, newResponseFound: true, textLength: 7, textStableForMs: 0, sendVisible: false } };
  const g = fake("chatgpt", ["G0"], calls);
  const c = fake("claude", ["partial"], calls, { method: "waitForGenerationComplete", occurrence: 1, outcome: timeout });
  const error = await runConvergenceReviewLoop(input(g, c)).catch(e => e as ConvergenceReviewLoopError);
  expect(error.stage).toEqual({ round: 1, turn: "claude_review", site: "claude", step: "generation_complete" });
  expect(sends(c)).toBe(1);
});

test("an extraction failure never causes a duplicate send", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0"], calls);
  const c = fake("claude", ["unused"], calls, { method: "getLatestAssistantResponse", occurrence: 1 });
  const error = await runConvergenceReviewLoop(input(g, c)).catch(e => e as ConvergenceReviewLoopError);
  expect(error.stage).toEqual({ round: 1, turn: "claude_review", site: "claude", step: "extract" });
  expect(sends(c)).toBe(1);
});

test("reviewStatus is advisory only and never decides convergence", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0", "G1"], calls);
  const c = fake("claude", [
    block({ reviewStatus: "CANDIDATE_CONVERGED", resolvedObjectionIds: [], resolutionEvidence: {}, stillOpenObjections: [], reopenedObjections: [], newObjections: [{ severity: "HIGH", summary: "bug", reason: "reason" }] }),
    clean(),
  ], calls);
  const result = await runConvergenceReviewLoop(input(g, c, { options: { maxRounds: 2 } }));
  expect(result.stopReason).toBe("MAX_ROUNDS_REACHED");
});

test("round 1 Claude prompt carries no OBJ ids and a later round carries the exact known id", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0", "G1", "G2"], calls);
  const c = fake("claude", [withNew("HIGH", "bug", "reason"), withResolved("OBJ-1", "fixed"), clean()], calls);
  await runConvergenceReviewLoop(input(g, c));
  expect(c.sends[0]).not.toContain("OBJ-");
  expect(c.sends[1]).toContain("OBJ-1");
});

test("the ChatGPT revision prompt requests a complete answer and carries the task and prior answer", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0", "G1", "G2"], calls);
  const c = fake("claude", [withNew("HIGH", "bug", "reason"), withResolved("OBJ-1", "fixed"), clean()], calls);
  await runConvergenceReviewLoop(input(g, c));
  expect(g.sends[1]).toContain("COMPLETE");
  expect(g.sends[1]).toContain(task);
  expect(g.sends[1]).toContain("G0");
});

test("maxRounds=1 stops after the single permitted Claude review", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0"], calls);
  const c = fake("claude", [withNew("HIGH", "bug", "reason")], calls);
  const result = await runConvergenceReviewLoop(input(g, c, { options: { maxRounds: 1 } }));
  expect(result.stopReason).toBe("MAX_ROUNDS_REACHED");
  expect(sends(g)).toBe(1);
  expect(sends(c)).toBe(1);
  expect(result.finalAnswer).toBe("G0");
});

test("default maxRounds is 10 when not specified", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", Array.from({ length: 10 }, (_, i) => "G" + i), calls);
  const c = fake("claude", [withNew("HIGH", "bug", "reason"), ...Array.from({ length: 9 }, () => withStillOpen("OBJ-1"))], calls);
  const result = await runConvergenceReviewLoop(input(g, c));
  expect(result.stopReason).toBe("MAX_ROUNDS_REACHED");
  expect(sends(c)).toBe(10);
  expect(sends(g)).toBe(10);
});

test("an invalid maxRounds value is rejected before any send", async () => {
  for (const maxRounds of [0, -1, 1.5, Number.NaN]) {
    const calls: string[] = [];
    const g = fake("chatgpt", [], calls);
    const c = fake("claude", [], calls);
    await expect(runConvergenceReviewLoop(input(g, c, { options: { maxRounds } }))).rejects.toThrow("maxRounds must be an integer greater than or equal to 1");
    expect(sends(g)).toBe(0);
    expect(sends(c)).toBe(0);
  }
});

test("the final result and convergence history are JSON serializable", async () => {
  const calls: string[] = [];
  const g = fake("chatgpt", ["G0", "G1"], calls);
  const c = fake("claude", [clean(), clean()], calls);
  const result = await runConvergenceReviewLoop(input(g, c));
  expect(() => JSON.stringify(result)).not.toThrow();
  expect(() => JSON.stringify(result.convergenceHistory)).not.toThrow();
});
