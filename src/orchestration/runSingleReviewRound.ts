import { Page } from "playwright";
import { ConversationalSiteAdapter, GenerationOutcome, TurnBaseline } from "../sites/siteTypes";
import { buildClaudeReviewPrompt } from "./reviewPrompt";

export type SingleRoundStage =
  | "checking ChatGPT readiness"
  | "capturing ChatGPT baseline"
  | "sending task to ChatGPT"
  | "waiting for ChatGPT generation start"
  | "waiting for ChatGPT generation completion"
  | "extracting ChatGPT response"
  | "checking Claude readiness"
  | "capturing Claude baseline"
  | "sending review prompt to Claude"
  | "waiting for Claude generation start"
  | "waiting for Claude generation completion"
  | "extracting Claude response";

export interface SingleRoundSite {
  page: Page;
  adapter: ConversationalSiteAdapter;
  generationTimeoutMs?: number;
}

export interface SingleReviewRoundInput {
  originalTask: string;
  chatgpt: SingleRoundSite;
  claude: SingleRoundSite;
}

export interface SingleReviewRoundResult {
  originalTask: string;
  chatgptResponse: string;
  claudeReview: string;
}

export class SingleReviewRoundError extends Error {
  constructor(
    public readonly stage: SingleRoundStage,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SingleReviewRoundError";
  }
}

function stageFailure(stage: SingleRoundStage, error: unknown): SingleReviewRoundError {
  return new SingleReviewRoundError(stage, error instanceof Error ? error.message : String(error), error);
}

async function ensureReady(site: SingleRoundSite, stage: SingleRoundStage): Promise<void> {
  try {
    const readiness = await site.adapter.checkReady(site.page);
    if (readiness !== "ready") throw new Error(site.adapter.name + " reports " + readiness);
  } catch (error) {
    throw stageFailure(stage, error);
  }
}

async function captureBaseline(site: SingleRoundSite, stage: SingleRoundStage): Promise<TurnBaseline> {
  try {
    return await site.adapter.captureTurnBaseline(site.page);
  } catch (error) {
    throw stageFailure(stage, error);
  }
}

async function send(site: SingleRoundSite, prompt: string, stage: SingleRoundStage): Promise<void> {
  try {
    await site.adapter.sendPrompt(site.page, prompt);
  } catch (error) {
    throw stageFailure(stage, error);
  }
}

async function waitStart(site: SingleRoundSite, baseline: TurnBaseline, stage: SingleRoundStage): Promise<void> {
  try {
    if (await site.adapter.waitForGenerationStart(site.page, baseline) !== "started") {
      throw new Error(site.adapter.name + " generation did not start within the bounded startup timeout");
    }
  } catch (error) {
    throw stageFailure(stage, error);
  }
}

async function waitComplete(site: SingleRoundSite, baseline: TurnBaseline, stage: SingleRoundStage): Promise<void> {
  let completion: GenerationOutcome;
  try {
    completion = await site.adapter.waitForGenerationComplete(site.page, baseline, site.generationTimeoutMs ?? 180000);
  } catch (error) {
    throw stageFailure(stage, error);
  }
  if (completion.outcome === "complete") return;
  if (completion.outcome === "timeout") {
    throw new SingleReviewRoundError(stage, "Generation timed out; partial response was discarded.", completion);
  }
  throw new SingleReviewRoundError(stage, "Generation failed: " + completion.detail, completion);
}

async function extract(site: SingleRoundSite, baseline: TurnBaseline, stage: SingleRoundStage): Promise<string> {
  try {
    return await site.adapter.getLatestAssistantResponse(site.page, baseline);
  } catch (error) {
    throw stageFailure(stage, error);
  }
}

export async function runSingleReviewRound(input: SingleReviewRoundInput): Promise<SingleReviewRoundResult> {
  await ensureReady(input.chatgpt, "checking ChatGPT readiness");
  const chatgptBaseline = await captureBaseline(input.chatgpt, "capturing ChatGPT baseline");
  await send(input.chatgpt, input.originalTask, "sending task to ChatGPT");
  await waitStart(input.chatgpt, chatgptBaseline, "waiting for ChatGPT generation start");
  await waitComplete(input.chatgpt, chatgptBaseline, "waiting for ChatGPT generation completion");
  const chatgptResponse = await extract(input.chatgpt, chatgptBaseline, "extracting ChatGPT response");

  await ensureReady(input.claude, "checking Claude readiness");
  const claudePrompt = buildClaudeReviewPrompt(input.originalTask, chatgptResponse);
  const claudeBaseline = await captureBaseline(input.claude, "capturing Claude baseline");
  await send(input.claude, claudePrompt, "sending review prompt to Claude");
  await waitStart(input.claude, claudeBaseline, "waiting for Claude generation start");
  await waitComplete(input.claude, claudeBaseline, "waiting for Claude generation completion");
  const claudeReview = await extract(input.claude, claudeBaseline, "extracting Claude response");

  return { originalTask: input.originalTask, chatgptResponse, claudeReview };
}

