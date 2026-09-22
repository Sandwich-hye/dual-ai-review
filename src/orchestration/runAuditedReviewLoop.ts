import type { Page } from "playwright";
import type { ConversationalSiteAdapter, GenerationOutcome, TurnBaseline } from "../sites/siteTypes";
import {
  AUDITED_REVIEW_SCHEMA_VERSION,
  AUDITED_ROUND_SCHEMA_VERSION,
  HUMAN_DECISION_RECORD_SCHEMA_VERSION,
  type AuditedReviewResult,
  type AuditedRoundRecord,
  type ClaimLedgerEntry,
  type DecisionRecommendation,
  type Evidence,
  type HumanGatePresentation,
  type HumanGateRawResponse,
  type HumanGateOutcome,
  type RunAuditEvent,
  type TerminalOutcomeOrigin,
} from "./claims/types";
import {
  attachEvidence,
  cloneClaimLedger,
  createEmptyClaimLedger,
  DEFAULT_CLAIM_LEDGER_OPTIONS,
  ingestClaimReview,
  type ClaimLedger,
  type ClaimLedgerOptions,
  type EvidenceInput,
} from "./claims/claimLedger";
import {
  buildClaimReviewClaudeReviewPrompt,
  buildClaimReviewRevisionPrompt,
} from "./claims/claimPrompts";
import { evaluateDecision } from "./claims/decisionAgent";
import { parseStructuredClaimReview } from "./claims/structuredClaimParser";
import type { HumanGate } from "./humanGate/humanGate";

export interface AuditedReviewLoopSite {
  page: Page;
  adapter: ConversationalSiteAdapter;
  generationTimeoutMs?: number;
}

export interface AuditedReviewLoopOptions {
  hardMaxRounds?: number;
  recommendedMaxRounds?: number;
  invalidReviewRejectThreshold?: number;
  stabilityWindowRounds?: number;
  reopenRejectThreshold?: number;
  resolutionConfidenceThreshold?: number;
  claimLedger?: Partial<ClaimLedgerOptions>;
}

/** Evidence supplied by a human interaction, already scoped to a claim. */
export type HumanSuppliedEvidence = Omit<EvidenceInput, "sourceRole"> & {
  sourceRole?: "HUMAN";
};

export interface AuditedReviewLoopInput {
  originalTask: string;
  generationStartTimeoutMs?: number;
  options?: AuditedReviewLoopOptions;
  chatgpt: AuditedReviewLoopSite;
  claude: AuditedReviewLoopSite;
  humanGate: HumanGate;
  /** Optional human-attached evidence collected by the gate-facing integration. */
  collectHumanEvidence?: (
    presentation: HumanGatePresentation,
    response: HumanGateRawResponse,
  ) => Promise<readonly HumanSuppliedEvidence[]>;
}

export type AuditedTurnSite = "chatgpt" | "claude" | "human";
export type AuditedTurnKind = "initial" | "claude_review" | "chatgpt_revision" | "human_gate";
export type AuditedTurnStep = "readiness" | "baseline" | "send" | "generation_start" | "generation_complete" | "extract";
export interface AuditedReviewLoopStage {
  round: number;
  turn: AuditedTurnKind;
  site: AuditedTurnSite;
  step: AuditedTurnStep;
}

export interface AuditedReviewLoopPartialResult {
  originalTask: string;
  hardMaxRounds: number;
  recommendedMaxRounds: number;
  initial?: AuditedReviewResult["initial"];
  rounds: AuditedRoundRecord[];
  claimLedger: ClaimLedgerEntry[];
  evidenceLog: Evidence[];
  runAuditTrail: RunAuditEvent[];
  currentAnswer?: string;
}

export class AuditedReviewLoopError extends Error {
  constructor(
    public readonly stage: AuditedReviewLoopStage,
    message: string,
    public readonly partialResult: AuditedReviewLoopPartialResult,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AuditedReviewLoopError";
  }
}

const DEFAULTS = {
  hardMaxRounds: 10,
  recommendedMaxRounds: 6,
  invalidReviewRejectThreshold: 3,
  stabilityWindowRounds: 2,
  reopenRejectThreshold: 3,
  resolutionConfidenceThreshold: 0.75,
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const cloneEntries = (entries: readonly ClaimLedgerEntry[]): ClaimLedgerEntry[] =>
  cloneClaimLedger({ entries: [...entries], evidenceLog: [], nextClaimId: 1, nextEvidenceId: 1 }).entries;

const stageError = (
  stage: AuditedReviewLoopStage,
  error: unknown,
  partial: AuditedReviewLoopPartialResult,
): AuditedReviewLoopError => new AuditedReviewLoopError(stage, errorMessage(error), partial, error);

async function ready(site: AuditedReviewLoopSite, stage: AuditedReviewLoopStage, partial: AuditedReviewLoopPartialResult): Promise<void> {
  try {
    const status = await site.adapter.checkReady(site.page);
    if (status !== "ready") throw new Error(`${site.adapter.name} reports ${status}`);
  } catch (error) {
    throw stageError(stage, error, partial);
  }
}

async function capture(site: AuditedReviewLoopSite, stage: AuditedReviewLoopStage, partial: AuditedReviewLoopPartialResult): Promise<TurnBaseline> {
  try { return await site.adapter.captureTurnBaseline(site.page); }
  catch (error) { throw stageError(stage, error, partial); }
}

async function send(site: AuditedReviewLoopSite, prompt: string, stage: AuditedReviewLoopStage, partial: AuditedReviewLoopPartialResult): Promise<void> {
  try { await site.adapter.sendPrompt(site.page, prompt); }
  catch (error) { throw stageError(stage, error, partial); }
}

async function start(site: AuditedReviewLoopSite, baseline: TurnBaseline, timeoutMs: number, stage: AuditedReviewLoopStage, partial: AuditedReviewLoopPartialResult): Promise<void> {
  try {
    if (await site.adapter.waitForGenerationStart(site.page, baseline, { startTimeoutMs: timeoutMs }) !== "started") {
      throw new Error(`${site.adapter.name} generation did not start within the bounded startup timeout`);
    }
  } catch (error) { throw stageError(stage, error, partial); }
}

async function complete(site: AuditedReviewLoopSite, baseline: TurnBaseline, stage: AuditedReviewLoopStage, partial: AuditedReviewLoopPartialResult): Promise<void> {
  let outcome: GenerationOutcome;
  try { outcome = await site.adapter.waitForGenerationComplete(site.page, baseline, site.generationTimeoutMs ?? 180000); }
  catch (error) { throw stageError(stage, error, partial); }
  if (outcome.outcome === "complete") return;
  throw stageError(stage, new Error(outcome.outcome === "timeout" ? "Generation timed out; partial response was discarded." : `Generation failed: ${outcome.detail}`), partial);
}

async function extract(site: AuditedReviewLoopSite, baseline: TurnBaseline, stage: AuditedReviewLoopStage, partial: AuditedReviewLoopPartialResult): Promise<string> {
  try { return await site.adapter.getLatestAssistantResponse(site.page, baseline); }
  catch (error) { throw stageError(stage, error, partial); }
}

const recommendationOutcome = (kind: DecisionRecommendation["kind"]): HumanGateOutcome => {
  if (kind === "ACCEPT_RECOMMENDED") return "ACCEPT";
  if (kind === "REJECT_RECOMMENDED") return "REJECT";
  return "CONTINUE";
};

const isCleanLedger = (entries: readonly ClaimLedgerEntry[], resolutionThreshold: number): boolean =>
  entries.every((entry) =>
    !(entry.status === "OPEN" && (entry.severity === "HIGH" || entry.severity === "MEDIUM"))
    && entry.status !== "DISPUTED"
    && !(entry.status === "RESOLVED" && entry.confidence < resolutionThreshold),
  );

const relevantEvidence = (ledger: ClaimLedger, claimIds: readonly string[]): Evidence[] => {
  const ids = new Set(claimIds);
  return ledger.evidenceLog.filter((evidence) => ids.has(evidence.claimId)).map((evidence) => ({ ...evidence }));
};

const recordEvent = (trail: RunAuditEvent[], round: number, kind: RunAuditEvent["kind"], detail: string): void => {
  trail.push({ round, kind, detail, recordedAt: new Date().toISOString() });
};

const outcomeOrigin = (decision: AuditedRoundRecord["humanDecision"]): TerminalOutcomeOrigin => {
  if (decision.hardSafetyOverride) return "HARD_SAFETY_OVERRIDE";
  return decision.recommendationAgreement === "AGREED"
    ? "HUMAN_AGREED_WITH_RECOMMENDATION"
    : "HUMAN_OVERRODE_RECOMMENDATION";
};

const syncPartial = (partial: AuditedReviewLoopPartialResult, ledger: ClaimLedger, answer: string): void => {
  partial.claimLedger = cloneEntries(ledger.entries);
  partial.evidenceLog = ledger.evidenceLog.map((evidence) => ({ ...evidence }));
  partial.currentAnswer = answer;
};

async function execute(input: AuditedReviewLoopInput): Promise<AuditedReviewResult> {
  const options = { ...DEFAULTS, ...input.options };
  const ledgerOptions: ClaimLedgerOptions = { ...DEFAULT_CLAIM_LEDGER_OPTIONS, ...input.options?.claimLedger };
  if (!Number.isInteger(options.hardMaxRounds) || options.hardMaxRounds < 1) throw new Error("hardMaxRounds must be an integer greater than or equal to 1");
  if (!Number.isInteger(options.recommendedMaxRounds) || options.recommendedMaxRounds < 1) throw new Error("recommendedMaxRounds must be an integer greater than or equal to 1");

  let ledger = createEmptyClaimLedger();
  const partial: AuditedReviewLoopPartialResult = {
    originalTask: input.originalTask,
    hardMaxRounds: options.hardMaxRounds,
    recommendedMaxRounds: options.recommendedMaxRounds,
    rounds: [],
    claimLedger: [],
    evidenceLog: [],
    runAuditTrail: [],
  };
  const initialStage = (step: AuditedTurnStep): AuditedReviewLoopStage => ({ round: 0, turn: "initial", site: "chatgpt", step });
  const initialPrompt = input.originalTask;
  await ready(input.chatgpt, initialStage("readiness"), partial);
  const initialBaseline = await capture(input.chatgpt, initialStage("baseline"), partial);
  const initialStartedAt = new Date().toISOString();
  await send(input.chatgpt, initialPrompt, initialStage("send"), partial);
  await start(input.chatgpt, initialBaseline, input.generationStartTimeoutMs ?? 30000, initialStage("generation_start"), partial);
  await complete(input.chatgpt, initialBaseline, initialStage("generation_complete"), partial);
  const initialResponse = await extract(input.chatgpt, initialBaseline, initialStage("extract"), partial);
  const initial = { prompt: initialPrompt, response: initialResponse, startedAt: initialStartedAt, completedAt: new Date().toISOString() };
  partial.initial = initial;
  partial.currentAnswer = initialResponse;

  let currentAnswer = initialResponse;
  let invalidReviewStreak = 0;
  let cleanStreak = 0;
  let previousTriggeredBranch: DecisionRecommendation["triggeredBranch"] | null = null;

  for (let round = 1; ; round += 1) {
    const reviewStage = (step: AuditedTurnStep): AuditedReviewLoopStage => ({ round, turn: "claude_review", site: "claude", step });
    const reviewEntries = ledger.entries.filter((entry) => entry.status === "OPEN" || entry.status === "DISPUTED");
    const reviewerPrompt = buildClaimReviewClaudeReviewPrompt(input.originalTask, currentAnswer, reviewEntries, round);
    await ready(input.claude, reviewStage("readiness"), partial);
    const reviewerBaseline = await capture(input.claude, reviewStage("baseline"), partial);
    await send(input.claude, reviewerPrompt, reviewStage("send"), partial);
    await start(input.claude, reviewerBaseline, input.generationStartTimeoutMs ?? 30000, reviewStage("generation_start"), partial);
    await complete(input.claude, reviewerBaseline, reviewStage("generation_complete"), partial);
    const reviewerRawResponse = await extract(input.claude, reviewerBaseline, reviewStage("extract"), partial);

    const parsed = parseStructuredClaimReview(reviewerRawResponse, { knownEntries: ledger.entries, round });
    let invalidReview: { reason: string } | null = null;
    let touchedClaimIds: string[] = [];
    if ("invalid" in parsed) {
      invalidReview = { reason: parsed.reason };
      invalidReviewStreak += 1;
      recordEvent(partial.runAuditTrail, round, "INVALID_REVIEW_ENCOUNTERED", parsed.reason);
    } else {
      try {
        const mutation = ingestClaimReview(ledger, parsed, round, ledgerOptions);
        ledger = mutation.ledger;
        touchedClaimIds = mutation.touchedClaimIds;
        invalidReviewStreak = 0;
      } catch (error) {
        invalidReview = { reason: errorMessage(error) };
        invalidReviewStreak += 1;
        recordEvent(partial.runAuditTrail, round, "INVALID_REVIEW_ENCOUNTERED", invalidReview.reason);
      }
    }

    if (invalidReview === null) {
      cleanStreak = isCleanLedger(ledger.entries, options.resolutionConfidenceThreshold) ? cleanStreak + 1 : 0;
    } else {
      cleanStreak = 0;
    }
    syncPartial(partial, ledger, currentAnswer);

    const recommendation = evaluateDecision({
      claims: ledger.entries,
      round,
      hardMaxRounds: options.hardMaxRounds,
      recommendedMaxRounds: options.recommendedMaxRounds,
      stabilityWindowRounds: options.stabilityWindowRounds,
      reopenRejectThreshold: options.reopenRejectThreshold,
      invalidReviewRejectThreshold: options.invalidReviewRejectThreshold,
      resolutionConfidenceThreshold: options.resolutionConfidenceThreshold,
      cleanStreak,
      invalidReviewStreak,
      invalidReviewThisRound: invalidReview,
    });
    if (recommendation.triggeredBranch === "INVALID_REVIEW_STREAK" && previousTriggeredBranch !== "INVALID_REVIEW_STREAK") {
      recordEvent(partial.runAuditTrail, round, "INVALID_REVIEW_STREAK_THRESHOLD_REACHED", recommendation.reason);
    }
    previousTriggeredBranch = recommendation.triggeredBranch;

    const legalOutcomes: HumanGateOutcome[] = round >= options.hardMaxRounds
      ? ["ACCEPT", "REJECT"]
      : ["CONTINUE", "ACCEPT", "REJECT"];
    const relevantIds = [...new Set([...touchedClaimIds, ...ledger.entries.filter((entry) => entry.status === "DISPUTED").map((entry) => entry.id)])];
    const presentation: HumanGatePresentation = {
      round,
      currentAnswer,
      recommendation,
      disputedClaims: cloneEntries(ledger.entries.filter((entry) => entry.status === "DISPUTED")),
      claimLedgerDelta: cloneEntries(ledger.entries.filter((entry) => touchedClaimIds.includes(entry.id))),
      relevantEvidence: relevantEvidence(ledger, relevantIds),
      legalOutcomes,
    };
    let rawResponse: HumanGateRawResponse;
    try {
      rawResponse = await input.humanGate.presentAndAwaitDecision(presentation);
    } catch (error) {
      throw stageError({ round, turn: "human_gate", site: "human", step: "extract" }, error, partial);
    }
    const raw: HumanGateRawResponse = {
      requestedOutcome: rawResponse.requestedOutcome,
      ...(rawResponse.rationale === undefined ? {} : { rationale: rawResponse.rationale }),
      decidedAt: rawResponse.decidedAt,
    };
    let suppliedEvidence: readonly HumanSuppliedEvidence[] = [];
    if (input.collectHumanEvidence) {
      try {
        suppliedEvidence = await input.collectHumanEvidence(presentation, raw);
      } catch (error) {
        throw stageError({ round, turn: "human_gate", site: "human", step: "extract" }, error, partial);
      }
    }
    const recordedHumanEvidence: Evidence[] = [];
    for (const evidence of suppliedEvidence) {
      const mutation = attachEvidence(ledger, {
        ...evidence,
        sourceRole: "HUMAN",
      }, ledgerOptions);
      ledger = mutation.ledger;
      const added = ledger.evidenceLog.find((item) => mutation.newEvidenceIds.includes(item.id));
      if (added) recordedHumanEvidence.push({ ...added });
    }
    if (recordedHumanEvidence.length > 0) {
      recordEvent(partial.runAuditTrail, round, "HUMAN_EVIDENCE_ATTACHED", `${recordedHumanEvidence.length} evidence record(s) attached`);
    }

    const agrees = recommendationOutcome(recommendation.kind) === raw.requestedOutcome;
    const humanDecision: AuditedRoundRecord["humanDecision"] = {
      schemaVersion: HUMAN_DECISION_RECORD_SCHEMA_VERSION,
      raw,
      outcome: raw.requestedOutcome === "CONTINUE" && round >= options.hardMaxRounds ? "REJECT" : raw.requestedOutcome,
      recommendationAgreement: agrees ? "AGREED" : "OVERRODE",
      ...(raw.requestedOutcome === "CONTINUE" && round >= options.hardMaxRounds
        ? { hardSafetyOverride: { reason: `hardMaxRounds (${options.hardMaxRounds}) reached; a CONTINUE request past the ceiling was not honored` } }
        : {}),
    };
    if (!agrees) recordEvent(partial.runAuditTrail, round, "RECOMMENDATION_OVERRIDDEN_BY_HUMAN", raw.rationale ?? "human selected a different outcome");
    if (humanDecision.hardSafetyOverride) recordEvent(partial.runAuditTrail, round, "HARD_MAX_ROUNDS_OVERRIDE", humanDecision.hardSafetyOverride.reason);

    const roundRecord: AuditedRoundRecord = {
      schemaVersion: AUDITED_ROUND_SCHEMA_VERSION,
      roundNumber: round,
      reviewerPrompt,
      reviewerRawResponse,
      recommendation,
      ledgerSnapshot: cloneEntries(ledger.entries),
      humanDecision,
      ...(recordedHumanEvidence.length === 0 ? {} : { humanSuppliedEvidence: recordedHumanEvidence }),
    };
    partial.rounds.push(roundRecord);
    syncPartial(partial, ledger, currentAnswer);

    if (humanDecision.outcome !== "CONTINUE") {
      return {
        schemaVersion: AUDITED_REVIEW_SCHEMA_VERSION,
        originalTask: input.originalTask,
        outcome: humanDecision.outcome === "ACCEPT" ? "ACCEPTED" : "REJECTED",
        outcomeOrigin: outcomeOrigin(humanDecision),
        finalAnswer: currentAnswer,
        initial,
        rounds: partial.rounds,
        claimLedger: cloneEntries(ledger.entries),
        evidenceLog: ledger.evidenceLog.map((evidence) => ({ ...evidence })),
        runAuditTrail: [...partial.runAuditTrail],
        hardMaxRounds: options.hardMaxRounds,
        recommendedMaxRounds: options.recommendedMaxRounds,
        invalidReviewRejectThreshold: options.invalidReviewRejectThreshold,
      };
    }

    const revisionStage = (step: AuditedTurnStep): AuditedReviewLoopStage => ({ round, turn: "chatgpt_revision", site: "chatgpt", step });
    const unresolved = ledger.entries.filter((entry) =>
      entry.status === "OPEN" || entry.status === "DISPUTED",
    ).filter((entry) => entry.severity === "HIGH" || entry.severity === "MEDIUM");
    const revisionPrompt = buildClaimReviewRevisionPrompt(input.originalTask, currentAnswer, reviewerRawResponse, unresolved, ledger.evidenceLog);
    roundRecord.generatorPrompt = revisionPrompt;
    await ready(input.chatgpt, revisionStage("readiness"), partial);
    const revisionBaseline = await capture(input.chatgpt, revisionStage("baseline"), partial);
    await send(input.chatgpt, revisionPrompt, revisionStage("send"), partial);
    await start(input.chatgpt, revisionBaseline, input.generationStartTimeoutMs ?? 30000, revisionStage("generation_start"), partial);
    await complete(input.chatgpt, revisionBaseline, revisionStage("generation_complete"), partial);
    const revisedAnswer = await extract(input.chatgpt, revisionBaseline, revisionStage("extract"), partial);
    roundRecord.generatorResponse = revisedAnswer;
    currentAnswer = revisedAnswer;
    syncPartial(partial, ledger, currentAnswer);
  }
}

export function runAuditedReviewLoop(input: AuditedReviewLoopInput): Promise<AuditedReviewResult> {
  return execute(input);
}
