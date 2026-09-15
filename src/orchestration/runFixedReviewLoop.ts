import type { Page } from "playwright";
import { ConversationalSiteAdapter, GenerationOutcome, TurnBaseline } from "../sites/siteTypes";
import { buildChatGptRevisionPrompt, buildClaudeReviewPrompt, buildInitialChatGptPrompt } from "./fixedReviewPrompts";

export type TurnSite = "chatgpt" | "claude";
export type TurnKind = "initial" | "claude_review" | "chatgpt_revision";
export type TurnStep = "readiness" | "baseline" | "send" | "generation_start" | "generation_complete" | "extract";
export interface FixedReviewLoopStage { round: number; turn: TurnKind; site: TurnSite; step: TurnStep }
export interface InitialChatGptTurn { prompt: string; response: string; startedAt: string; completedAt: string }
export interface ReviewRoundRecord {
  roundNumber: number;
  claudeReviewPrompt: string;
  claudeReviewResponse: string;
  claudeStartedAt: string;
  claudeCompletedAt: string;
  chatgptRevisionPrompt: string;
  chatgptRevisionResponse: string;
  chatgptStartedAt: string;
  chatgptCompletedAt: string;
}
export interface FixedReviewLoopPartialResult { originalTask: string; reviewRounds: number; initial?: InitialChatGptTurn; rounds: ReviewRoundRecord[] }
export interface FixedReviewLoopResult extends FixedReviewLoopPartialResult { initial: InitialChatGptTurn; finalAnswer: string }
export class FixedReviewLoopError extends Error {
  constructor(public readonly stage: FixedReviewLoopStage, message: string, public readonly partialResult: FixedReviewLoopPartialResult, public readonly cause?: unknown) {
    super(message); this.name = "FixedReviewLoopError";
  }
}
export interface FixedReviewLoopSite { page: Page; adapter: ConversationalSiteAdapter; generationTimeoutMs?: number }
export interface FixedReviewLoopInput { originalTask: string; reviewRounds: number; generationStartTimeoutMs?: number; chatgpt: FixedReviewLoopSite; claude: FixedReviewLoopSite }

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function wrapped(stage: FixedReviewLoopStage, error: unknown, partial: FixedReviewLoopPartialResult): FixedReviewLoopError {
  return new FixedReviewLoopError(stage, message(error), partial, error);
}
async function ready(site: FixedReviewLoopSite, stage: FixedReviewLoopStage, partial: FixedReviewLoopPartialResult): Promise<void> {
  try { const status = await site.adapter.checkReady(site.page); if (status !== "ready") throw new Error(site.adapter.name + " reports " + status); }
  catch (error) { throw wrapped(stage, error, partial); }
}
async function capture(site: FixedReviewLoopSite, stage: FixedReviewLoopStage, partial: FixedReviewLoopPartialResult): Promise<TurnBaseline> {
  try { return await site.adapter.captureTurnBaseline(site.page); }
  catch (error) { throw wrapped(stage, error, partial); }
}
async function send(site: FixedReviewLoopSite, prompt: string, stage: FixedReviewLoopStage, partial: FixedReviewLoopPartialResult): Promise<void> {
  try { await site.adapter.sendPrompt(site.page, prompt); }
  catch (error) { throw wrapped(stage, error, partial); }
}
async function start(site: FixedReviewLoopSite, baseline: TurnBaseline, timeoutMs: number, stage: FixedReviewLoopStage, partial: FixedReviewLoopPartialResult): Promise<void> {
  try { if (await site.adapter.waitForGenerationStart(site.page, baseline, { startTimeoutMs: timeoutMs }) !== "started") throw new Error(site.adapter.name + " generation did not start within the bounded startup timeout"); }
  catch (error) { throw wrapped(stage, error, partial); }
}
async function complete(site: FixedReviewLoopSite, baseline: TurnBaseline, stage: FixedReviewLoopStage, partial: FixedReviewLoopPartialResult): Promise<void> {
  let outcome: GenerationOutcome;
  try { outcome = await site.adapter.waitForGenerationComplete(site.page, baseline, site.generationTimeoutMs ?? 180000); }
  catch (error) { throw wrapped(stage, error, partial); }
  if (outcome.outcome === "complete") return;
  throw wrapped(stage, new Error(outcome.outcome === "timeout" ? "Generation timed out; partial response was discarded." : "Generation failed: " + outcome.detail), partial);
}
async function extract(site: FixedReviewLoopSite, baseline: TurnBaseline, stage: FixedReviewLoopStage, partial: FixedReviewLoopPartialResult): Promise<string> {
  try { return await site.adapter.getLatestAssistantResponse(site.page, baseline); }
  catch (error) { throw wrapped(stage, error, partial); }
}

async function execute(input: FixedReviewLoopInput): Promise<FixedReviewLoopResult> {
  if (!Number.isInteger(input.reviewRounds) || input.reviewRounds < 1) throw new Error("reviewRounds must be an integer greater than or equal to 1");
  const partial: FixedReviewLoopPartialResult = { originalTask: input.originalTask, reviewRounds: input.reviewRounds, rounds: [] };
  const initialStage = (step: TurnStep): FixedReviewLoopStage => ({ round: 0, turn: "initial", site: "chatgpt", step });
  const initialPrompt = buildInitialChatGptPrompt(input.originalTask);
  await ready(input.chatgpt, initialStage("readiness"), partial);
  const initialBaseline = await capture(input.chatgpt, initialStage("baseline"), partial);
  const initialStartedAt = new Date().toISOString();
  await send(input.chatgpt, initialPrompt, initialStage("send"), partial);
  await start(input.chatgpt, initialBaseline, input.generationStartTimeoutMs ?? 30000, initialStage("generation_start"), partial);
  await complete(input.chatgpt, initialBaseline, initialStage("generation_complete"), partial);
  const initialResponse = await extract(input.chatgpt, initialBaseline, initialStage("extract"), partial);
  partial.initial = { prompt: initialPrompt, response: initialResponse, startedAt: initialStartedAt, completedAt: new Date().toISOString() };
  let currentAnswer = initialResponse;
  for (let round = 1; round <= input.reviewRounds; round += 1) {
    const claudeStage = (step: TurnStep): FixedReviewLoopStage => ({ round, turn: "claude_review", site: "claude", step });
    const claudePrompt = buildClaudeReviewPrompt(input.originalTask, currentAnswer);
    await ready(input.claude, claudeStage("readiness"), partial);
    const claudeBaseline = await capture(input.claude, claudeStage("baseline"), partial);
    const claudeStartedAt = new Date().toISOString();
    await send(input.claude, claudePrompt, claudeStage("send"), partial);
    await start(input.claude, claudeBaseline, input.generationStartTimeoutMs ?? 30000, claudeStage("generation_start"), partial);
    await complete(input.claude, claudeBaseline, claudeStage("generation_complete"), partial);
    const claudeReview = await extract(input.claude, claudeBaseline, claudeStage("extract"), partial);
    const chatgptStage = (step: TurnStep): FixedReviewLoopStage => ({ round, turn: "chatgpt_revision", site: "chatgpt", step });
    const revisionPrompt = buildChatGptRevisionPrompt(input.originalTask, currentAnswer, claudeReview);
    await ready(input.chatgpt, chatgptStage("readiness"), partial);
    const revisionBaseline = await capture(input.chatgpt, chatgptStage("baseline"), partial);
    const chatgptStartedAt = new Date().toISOString();
    await send(input.chatgpt, revisionPrompt, chatgptStage("send"), partial);
    await start(input.chatgpt, revisionBaseline, input.generationStartTimeoutMs ?? 30000, chatgptStage("generation_start"), partial);
    await complete(input.chatgpt, revisionBaseline, chatgptStage("generation_complete"), partial);
    const revisedAnswer = await extract(input.chatgpt, revisionBaseline, chatgptStage("extract"), partial);
    partial.rounds.push({ roundNumber: round, claudeReviewPrompt: claudePrompt, claudeReviewResponse: claudeReview, claudeStartedAt, claudeCompletedAt: new Date().toISOString(), chatgptRevisionPrompt: revisionPrompt, chatgptRevisionResponse: revisedAnswer, chatgptStartedAt, chatgptCompletedAt: new Date().toISOString() });
    currentAnswer = revisedAnswer;
  }
  return { ...partial, initial: partial.initial!, finalAnswer: currentAnswer };
}

export function runFixedReviewLoop(input: FixedReviewLoopInput): Promise<FixedReviewLoopResult> { return execute(input); }
