import type { Page } from "playwright";
import { ConversationalSiteAdapter, GenerationOutcome, TurnBaseline } from "../sites/siteTypes";
import {
  buildConvergenceChatGptRevisionPrompt,
  buildConvergenceClaudeReviewPrompt,
  buildConvergenceInitialChatGptPrompt,
} from "./convergence/convergencePrompts";
import { applyConvergenceRound, createConvergenceState } from "./convergence/convergenceEngine";
import { InvalidLedgerIngestError } from "./convergence/objectionLedger";
import { parseStructuredReview } from "./convergence/structuredReviewParser";
import {
  ConvergenceDecision,
  ConvergenceOptions,
  ConvergenceState,
  ConvergedReviewResult,
  ConvergenceRoundRecord,
  ConvergenceHistory,
  DEFAULT_CONVERGENCE_OPTIONS,
  StructuredClaudeReview,
} from "./convergence/types";

export type TurnSite = "chatgpt" | "claude";
export type TurnKind = "initial" | "claude_review" | "chatgpt_revision";
export type TurnStep = "readiness" | "baseline" | "send" | "generation_start" | "generation_complete" | "extract";
export interface ConvergenceReviewLoopStage { round: number; turn: TurnKind; site: TurnSite; step: TurnStep }
export interface ConvergenceReviewLoopPartialResult {
  originalTask: string;
  maxRounds: number;
  initial?: ConvergedReviewResult["initial"];
  rounds: ConvergenceRoundRecord[];
  ledger: ConvergedReviewResult["ledger"];
  convergenceHistory: ConvergenceHistory;
}
export class ConvergenceReviewLoopError extends Error {
  constructor(
    public readonly stage: ConvergenceReviewLoopStage,
    message: string,
    public readonly partialResult: ConvergenceReviewLoopPartialResult,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConvergenceReviewLoopError";
  }
}
export interface ConvergenceReviewLoopSite { page: Page; adapter: ConversationalSiteAdapter; generationTimeoutMs?: number }
export interface ConvergenceReviewLoopInput {
  originalTask: string;
  generationStartTimeoutMs?: number;
  options?: Partial<ConvergenceOptions>;
  chatgpt: ConvergenceReviewLoopSite;
  claude: ConvergenceReviewLoopSite;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function wrapped(stage: ConvergenceReviewLoopStage, error: unknown, partial: ConvergenceReviewLoopPartialResult): ConvergenceReviewLoopError {
  return new ConvergenceReviewLoopError(stage, message(error), partial, error);
}
async function ready(site: ConvergenceReviewLoopSite, stage: ConvergenceReviewLoopStage, partial: ConvergenceReviewLoopPartialResult): Promise<void> {
  try { const status = await site.adapter.checkReady(site.page); if (status !== "ready") throw new Error(site.adapter.name + " reports " + status); }
  catch (error) { throw wrapped(stage, error, partial); }
}
async function capture(site: ConvergenceReviewLoopSite, stage: ConvergenceReviewLoopStage, partial: ConvergenceReviewLoopPartialResult): Promise<TurnBaseline> {
  try { return await site.adapter.captureTurnBaseline(site.page); }
  catch (error) { throw wrapped(stage, error, partial); }
}
async function send(site: ConvergenceReviewLoopSite, prompt: string, stage: ConvergenceReviewLoopStage, partial: ConvergenceReviewLoopPartialResult): Promise<void> {
  try { await site.adapter.sendPrompt(site.page, prompt); }
  catch (error) { throw wrapped(stage, error, partial); }
}
async function start(site: ConvergenceReviewLoopSite, baseline: TurnBaseline, timeoutMs: number, stage: ConvergenceReviewLoopStage, partial: ConvergenceReviewLoopPartialResult): Promise<void> {
  try { if (await site.adapter.waitForGenerationStart(site.page, baseline, { startTimeoutMs: timeoutMs }) !== "started") throw new Error(site.adapter.name + " generation did not start within the bounded startup timeout"); }
  catch (error) { throw wrapped(stage, error, partial); }
}
async function complete(site: ConvergenceReviewLoopSite, baseline: TurnBaseline, stage: ConvergenceReviewLoopStage, partial: ConvergenceReviewLoopPartialResult): Promise<void> {
  let outcome: GenerationOutcome;
  try { outcome = await site.adapter.waitForGenerationComplete(site.page, baseline, site.generationTimeoutMs ?? 180000); }
  catch (error) { throw wrapped(stage, error, partial); }
  if (outcome.outcome === "complete") return;
  throw wrapped(stage, new Error(outcome.outcome === "timeout" ? "Generation timed out; partial response was discarded." : "Generation failed: " + outcome.detail), partial);
}
async function extract(site: ConvergenceReviewLoopSite, baseline: TurnBaseline, stage: ConvergenceReviewLoopStage, partial: ConvergenceReviewLoopPartialResult): Promise<string> {
  try { return await site.adapter.getLatestAssistantResponse(site.page, baseline); }
  catch (error) { throw wrapped(stage, error, partial); }
}

type RoundEvaluation =
  | { valid: true; state: ConvergenceState; decision: ConvergenceDecision; structuredReview: StructuredClaudeReview }
  | { valid: false; state: ConvergenceState; decision: ConvergenceDecision; reason: string };

function evaluateRound(state: ConvergenceState, rawReview: string, round: number, options: ConvergenceOptions): RoundEvaluation {
  const parsed = parseStructuredReview(rawReview, { knownEntries: state.ledger.entries, round });
  if ("invalid" in parsed) {
    const result = applyConvergenceRound(state, parsed, round, options);
    return { valid: false, state: result.state, decision: result.decision, reason: parsed.reason };
  }
  try {
    const result = applyConvergenceRound(state, parsed, round, options);
    return { valid: true, state: result.state, decision: result.decision, structuredReview: parsed };
  } catch (error) {
    if (error instanceof InvalidLedgerIngestError) {
      const result = applyConvergenceRound(state, error.invalidReview, round, options);
      return { valid: false, state: result.state, decision: result.decision, reason: error.invalidReview.reason };
    }
    throw error;
  }
}

async function execute(input: ConvergenceReviewLoopInput): Promise<ConvergedReviewResult> {
  const options: ConvergenceOptions = { ...DEFAULT_CONVERGENCE_OPTIONS, ...input.options };
  if (!Number.isInteger(options.maxRounds) || options.maxRounds < 1) throw new Error("maxRounds must be an integer greater than or equal to 1");

  const partial: ConvergenceReviewLoopPartialResult = { originalTask: input.originalTask, maxRounds: options.maxRounds, rounds: [], ledger: [], convergenceHistory: { rounds: [] } };
  const initialStage = (step: TurnStep): ConvergenceReviewLoopStage => ({ round: 0, turn: "initial", site: "chatgpt", step });
  const initialPrompt = buildConvergenceInitialChatGptPrompt(input.originalTask);
  await ready(input.chatgpt, initialStage("readiness"), partial);
  const initialBaseline = await capture(input.chatgpt, initialStage("baseline"), partial);
  const initialStartedAt = new Date().toISOString();
  await send(input.chatgpt, initialPrompt, initialStage("send"), partial);
  await start(input.chatgpt, initialBaseline, input.generationStartTimeoutMs ?? 30000, initialStage("generation_start"), partial);
  await complete(input.chatgpt, initialBaseline, initialStage("generation_complete"), partial);
  const initialResponse = await extract(input.chatgpt, initialBaseline, initialStage("extract"), partial);
  partial.initial = { prompt: initialPrompt, response: initialResponse, startedAt: initialStartedAt, completedAt: new Date().toISOString() };

  let currentAnswer = initialResponse;
  let state: ConvergenceState = createConvergenceState();

  for (let round = 1; ; round += 1) {
    const claudeStage = (step: TurnStep): ConvergenceReviewLoopStage => ({ round, turn: "claude_review", site: "claude", step });
    const openEntries = state.ledger.entries.filter(entry => entry.status === "OPEN");
    const claudePrompt = buildConvergenceClaudeReviewPrompt(input.originalTask, currentAnswer, openEntries, round);
    await ready(input.claude, claudeStage("readiness"), partial);
    const claudeBaseline = await capture(input.claude, claudeStage("baseline"), partial);
    const claudeStartedAt = new Date().toISOString();
    await send(input.claude, claudePrompt, claudeStage("send"), partial);
    await start(input.claude, claudeBaseline, input.generationStartTimeoutMs ?? 30000, claudeStage("generation_start"), partial);
    await complete(input.claude, claudeBaseline, claudeStage("generation_complete"), partial);
    const rawReview = await extract(input.claude, claudeBaseline, claudeStage("extract"), partial);
    const claudeCompletedAt = new Date().toISOString();

    const evaluated = evaluateRound(state, rawReview, round, options);

    if (!evaluated.valid) {
      state = evaluated.state;
      partial.ledger = state.ledger.entries;
      partial.convergenceHistory = state.history;
      partial.rounds.push({ roundNumber: round, claudeReviewPrompt: claudePrompt, claudeReviewRawResponse: rawReview, claudeStructuredReview: null, decision: evaluated.decision, claudeStartedAt, claudeCompletedAt });
      return {
        originalTask: input.originalTask, maxRounds: options.maxRounds, stopReason: "INVALID_REVIEW", finalAnswer: currentAnswer,
        initial: partial.initial!, rounds: partial.rounds, ledger: state.ledger.entries, convergenceHistory: state.history,
        invalidReview: { round, rawText: rawReview, reason: evaluated.reason },
      };
    }

    state = evaluated.state;
    const decision = evaluated.decision;
    partial.ledger = state.ledger.entries;
    partial.convergenceHistory = state.history;

    if (decision.kind === "CONVERGED" || decision.kind === "MAX_ROUNDS_REACHED") {
      partial.rounds.push({ roundNumber: round, claudeReviewPrompt: claudePrompt, claudeReviewRawResponse: rawReview, claudeStructuredReview: evaluated.structuredReview, decision, claudeStartedAt, claudeCompletedAt });
      return {
        originalTask: input.originalTask, maxRounds: options.maxRounds, stopReason: decision.kind, finalAnswer: currentAnswer,
        initial: partial.initial!, rounds: partial.rounds, ledger: state.ledger.entries, convergenceHistory: state.history,
      };
    }

    const openHighMedium = state.ledger.entries.filter(entry => entry.status === "OPEN" && (entry.severity === "HIGH" || entry.severity === "MEDIUM"));
    const chatgptStage = (step: TurnStep): ConvergenceReviewLoopStage => ({ round, turn: "chatgpt_revision", site: "chatgpt", step });
    const revisionPrompt = buildConvergenceChatGptRevisionPrompt(input.originalTask, currentAnswer, rawReview, openHighMedium);
    await ready(input.chatgpt, chatgptStage("readiness"), partial);
    const revisionBaseline = await capture(input.chatgpt, chatgptStage("baseline"), partial);
    const chatgptStartedAt = new Date().toISOString();
    await send(input.chatgpt, revisionPrompt, chatgptStage("send"), partial);
    await start(input.chatgpt, revisionBaseline, input.generationStartTimeoutMs ?? 30000, chatgptStage("generation_start"), partial);
    await complete(input.chatgpt, revisionBaseline, chatgptStage("generation_complete"), partial);
    const revisedAnswer = await extract(input.chatgpt, revisionBaseline, chatgptStage("extract"), partial);
    const chatgptCompletedAt = new Date().toISOString();

    partial.rounds.push({
      roundNumber: round, claudeReviewPrompt: claudePrompt, claudeReviewRawResponse: rawReview, claudeStructuredReview: evaluated.structuredReview,
      decision, claudeStartedAt, claudeCompletedAt, chatgptRevisionPrompt: revisionPrompt, chatgptRevisionResponse: revisedAnswer, chatgptStartedAt, chatgptCompletedAt,
    });
    currentAnswer = revisedAnswer;
  }
}

export function runConvergenceReviewLoop(input: ConvergenceReviewLoopInput): Promise<ConvergedReviewResult> { return execute(input); }
