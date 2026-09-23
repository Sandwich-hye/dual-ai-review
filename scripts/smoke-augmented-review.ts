import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium, type Browser, type Page } from "playwright";
import { runAuditedReviewLoop, type AuditedReviewLoopInput } from "../src/orchestration/runAuditedReviewLoop";
import type { HumanGate, HumanGatePresentation, HumanGateRawResponse } from "../src/orchestration/humanGate/humanGate";
import { createDeterministicSupervisor } from "../src/orchestration/supervisor/deterministicSupervisor";
import { createSupervisedHumanGate } from "../src/orchestration/supervisor/supervisedHumanGate";
import type {
  Supervisor,
  SupervisorInput,
  SupervisorAssessment,
  SupervisorUnavailable,
  SupervisedReviewResult,
} from "../src/orchestration/supervisor/types";
import { createLlmSupervisorAdapter } from "../src/orchestration/supervisor/llm/adapter";
import { createAugmentedSupervisor } from "../src/orchestration/supervisor/llm/augmentedSupervisor";
import type { AugmentedSupervisedReviewResult } from "../src/orchestration/supervisor/llm/contracts";
import { LlmExecutionManager } from "../src/orchestration/supervisor/llm/executionManager";
import { openDedicatedLlmSession, type LlmSupervisorSession } from "../src/orchestration/supervisor/llm/session";
import { createChatGPTConversationalAdapter, checkChatGPTReady } from "../src/sites/chatgptSite";
import { createClaudeConversationalAdapter, checkClaudeReady, isClaudeSecurityVerificationVisible } from "../src/sites/claudeSite";
import { chatgptSelectors } from "../src/sites/selectors/chatgptSelectors";
import { claudeSelectors } from "../src/sites/selectors/claudeSelectors";
import { claudeUserMessageSelector } from "../src/sites/claudeUserTurns";
import { validateIsolationAttestation, validateLlmCdpEndpoint } from "./augmentedReviewSmokeSupport";

// Attach a second Chrome process/profile on port 9223. Log in to ChatGPT there, disable
// memory/history reference, then set both LLM_SUPERVISOR_CDP_ENDPOINT and the dated
// LLM_SUPERVISOR_ISOLATION_ATTESTED_AT environment variable before running this smoke.
const REVIEW_CDP_ENDPOINT = "http://127.0.0.1:9222";
const LLM_SITE_URL = "https://chatgpt.com/";
const TASK = "Give exactly three practical benefits of automated software testing, with one sentence of explanation for each.";
const REVIEW_GENERATION_TIMEOUT_MS = 180_000;
const LLM_GENERATION_TIMEOUT_MS = 120_000;
const LLM_OPERATION_TIMEOUT_MS = 150_000;
const LLM_FINALIZATION_TIMEOUT_MS = 180_000;

function hostname(page: Page): string {
  try { return new URL(page.url()).hostname.toLowerCase(); }
  catch { return ""; }
}

function isChatGpt(host: string): boolean {
  return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com";
}

function isClaude(host: string): boolean {
  return host === "claude.ai" || host.endsWith(".claude.ai");
}

function exactlyOne(pages: readonly Page[], predicate: (page: Page) => boolean, label: string): Page {
  const matches = pages.filter(predicate);
  if (matches.length !== 1) throw new Error(`Expected exactly one fresh ${label} tab; found ${matches.length}.`);
  return matches[0];
}

async function assertFresh(page: Page, label: string, assistantSelectors: readonly string[], userSelector: string): Promise<void> {
  const assistantCount = await page.locator(assistantSelectors.join(",")).count();
  const userCount = await page.locator(userSelector).count();
  if (assistantCount !== 0 || userCount !== 0) {
    throw new Error(`${label} must be a fresh conversation (users=${userCount}, assistants=${assistantCount}).`);
  }
}

function terminalHumanGate(): HumanGate {
  return {
    async presentAndAwaitDecision(presentation: HumanGatePresentation): Promise<HumanGateRawResponse> {
      console.log(`\n=== HUMAN GATE: round ${presentation.round} ===`);
      console.log(`Recommendation: ${presentation.recommendation.kind}`);
      console.log(`Reason: ${presentation.recommendation.reason}`);
      console.log(`Allowed outcomes: ${presentation.legalOutcomes.join(", ")}`);
      const readline = createInterface({ input, output });
      try {
        let choice = "";
        while (!presentation.legalOutcomes.includes(choice as HumanGateRawResponse["requestedOutcome"])) {
          choice = (await readline.question(`Choose ${presentation.legalOutcomes.join("/")}: `)).trim().toUpperCase();
        }
        const rationale = choice === "REJECT" ? (await readline.question("Rationale (required): ")).trim() : undefined;
        if (choice === "REJECT" && !rationale) throw new Error("REJECT requires a rationale");
        return {
          requestedOutcome: choice as HumanGateRawResponse["requestedOutcome"],
          ...(rationale === undefined ? {} : { rationale }),
          decidedAt: new Date().toISOString(),
        };
      } finally {
        readline.close();
      }
    },
  };
}

function assertAugmentedResult(
  result: AugmentedSupervisedReviewResult,
  deterministicOutcomes: readonly (SupervisorAssessment | SupervisorUnavailable)[],
  deterministicInputs: readonly SupervisorInput[],
): void {
  if (result.schemaVersion !== 2) throw new Error("Unexpected 6B result schema");
  if (result.base.rounds.length !== deterministicOutcomes.length ||
      JSON.stringify(result.supervisorAssessments) !== JSON.stringify(deterministicOutcomes)) {
    throw new Error("Augmented supervision changed the deterministic assessment or round count");
  }
  if (result.llmAuditFinalization.status !== "complete") throw new Error("LLM audit finalization is incomplete");
  if (result.llmSessionStatus.status !== "ready") throw new Error(`LLM session is ${result.llmSessionStatus.status}`);
  const dispatched = result.llmSupervisorAssessments.filter((record) => record.dispatchedAt !== undefined);
  const successes = dispatched.filter((record) => record.status === "resolved");
  if (dispatched.length === 0 || successes.length === 0) throw new Error("No successful real LLM assessment was audited");
  for (const record of successes) {
    const source = deterministicInputs.find((entry) => entry.rounds.at(-1)?.roundNumber === record.round);
    if (!source || !record.assessment || !record.prompt || !record.rawResponse ||
        JSON.stringify(record.groundedSignals) !== JSON.stringify(source.rounds.map((round) => round.recommendation))) {
      throw new Error(`LLM audit evidence is incomplete for round ${record.round}`);
    }
  }
  if (JSON.stringify(JSON.parse(JSON.stringify(result))) !== JSON.stringify(result)) {
    throw new Error("Final 6B audit is not JSON round-trip stable");
  }
}

/** A closed real session and delayed readiness force a logical timeout, then degradation. */
async function assertTimeoutAndDegradation(session: LlmSupervisorSession, supervisorInput: SupervisorInput): Promise<void> {
  await session.close();
  const delayedClosedSession: LlmSupervisorSession = {
    page: session.page,
    adapter: session.adapter,
    async checkReady() {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return session.checkReady();
    },
    close: () => session.close(),
  };
  const manager = new LlmExecutionManager(
    createLlmSupervisorAdapter(delayedClosedSession, { generationTimeoutMs: LLM_GENERATION_TIMEOUT_MS }),
    delayedClosedSession,
    { timeoutMs: 1 },
  );
  const first = manager.dispatch(supervisorInput);
  if (first.kind !== "dispatched") throw new Error("Timeout probe was not dispatched");
  const timed = await first.firstOutcome;
  if (timed.kind !== "timeout") throw new Error("Timeout probe did not reach the logical timeout path");
  await first.completion;
  const skipped = manager.dispatch(supervisorInput);
  if (skipped.kind !== "skipped" || !skipped.reason.includes("degraded")) {
    throw new Error("A degraded LLM session allowed another dispatch");
  }
  const audit = await manager.finalizeAudit(1_000);
  const record = audit.llmSupervisorAssessments[0];
  if (audit.llmAuditFinalization.status !== "complete" || audit.llmSessionStatus.status !== "degraded" ||
      record.status !== "timed_out" || record.lateResolution?.kind !== "failure" ||
      record.rawResponse !== undefined || record.assessment !== undefined) {
    throw new Error("Timeout/degradation audit is incomplete or claims an unobserved response");
  }
}

async function run(): Promise<number> {
  let reviewBrowser: Browser | undefined;
  let llmBrowser: Browser | undefined;
  let llmSession: LlmSupervisorSession | undefined;
  try {
    const attestation = validateIsolationAttestation(process.env.LLM_SUPERVISOR_ISOLATION_ATTESTED_AT);
    const llmEndpoint = validateLlmCdpEndpoint(process.env.LLM_SUPERVISOR_CDP_ENDPOINT, REVIEW_CDP_ENDPOINT);
    console.log(`LLM profile isolation attested at ${attestation.isolationAttestedAt}; verifying separate local browser endpoints.`);

    reviewBrowser = await chromium.connectOverCDP(REVIEW_CDP_ENDPOINT);
    llmBrowser = await chromium.connectOverCDP(llmEndpoint);
    const reviewPages = reviewBrowser.contexts().flatMap((context) => context.pages());
    const chatgpt = exactlyOne(reviewPages, (page) => isChatGpt(hostname(page)), "review ChatGPT");
    const claude = exactlyOne(reviewPages, (page) => isClaude(hostname(page)), "review Claude");
    if (await checkChatGPTReady(chatgpt) !== "ready" || await checkClaudeReady(claude) !== "ready" ||
        await isClaudeSecurityVerificationVisible(claude)) {
      throw new Error("Review tabs require login, security verification, or readiness setup");
    }
    await assertFresh(chatgpt, "Review ChatGPT", chatgptSelectors.assistantMessage, '[data-message-author-role="user"]');
    await assertFresh(claude, "Review Claude", claudeSelectors.assistantMessage, claudeUserMessageSelector);

    const llmContexts = llmBrowser.contexts();
    if (llmContexts.length !== 1) throw new Error("Expected exactly one context in the dedicated LLM browser profile");
    llmSession = await openDedicatedLlmSession(
      { newPage: () => llmContexts[0].newPage() },
      createChatGPTConversationalAdapter(LLM_SITE_URL),
      30_000,
    );
    if (await llmSession.checkReady() !== "ready") throw new Error("Dedicated LLM supervisor session is not ready");
    await assertFresh(llmSession.page, "LLM supervisor", chatgptSelectors.assistantMessage, '[data-message-author-role="user"]');

    const observedInputs: SupervisorInput[] = [];
    const observedOutcomes: (SupervisorAssessment | SupervisorUnavailable)[] = [];
    const deterministic = createDeterministicSupervisor();
    const observedDeterministic: Supervisor = {
      async assess(value) {
        const outcome = await deterministic.assess(value);
        observedInputs.push(structuredClone(value));
        observedOutcomes.push(structuredClone(outcome));
        return outcome;
      },
    };
    const execution = new LlmExecutionManager(
      createLlmSupervisorAdapter(llmSession, { generationTimeoutMs: LLM_GENERATION_TIMEOUT_MS }),
      llmSession,
      { timeoutMs: LLM_OPERATION_TIMEOUT_MS },
    );
    const augmented = createAugmentedSupervisor(observedDeterministic, execution, { trigger: { kind: "every-round" } });
    const gate = createSupervisedHumanGate(terminalHumanGate(), augmented, {
      invalidReviewRejectThreshold: 3,
      reopenRejectThreshold: 3,
    });
    const loopInput: AuditedReviewLoopInput = {
      originalTask: TASK,
      generationStartTimeoutMs: 30_000,
      options: { hardMaxRounds: 3, recommendedMaxRounds: 2 },
      chatgpt: { page: chatgpt, adapter: createChatGPTConversationalAdapter(chatgpt.url()), generationTimeoutMs: REVIEW_GENERATION_TIMEOUT_MS },
      claude: { page: claude, adapter: createClaudeConversationalAdapter(claude.url()), generationTimeoutMs: REVIEW_GENERATION_TIMEOUT_MS },
      humanGate: gate,
    };
    const base = await runAuditedReviewLoop(loopInput);
    const supervised: SupervisedReviewResult = {
      schemaVersion: 1,
      base,
      supervisorAssessments: gate.getAccumulatedAssessments(),
    };
    const result = await augmented.finalizeResult(supervised, LLM_FINALIZATION_TIMEOUT_MS);
    assertAugmentedResult(result, observedOutcomes, observedInputs);
    await assertTimeoutAndDegradation(llmSession, observedInputs[0]);

    console.log(`Audited rounds: ${result.base.rounds.length}`);
    console.log(`Deterministic assessments: ${result.supervisorAssessments.length}`);
    console.log(`LLM audit records: ${result.llmSupervisorAssessments.length}`);
    console.log(`Final outcome: ${result.base.outcome}`);
    console.log("AUGMENTED REVIEW SMOKE TEST PASSED");
    return 0;
  } catch (error) {
    console.error("AUGMENTED REVIEW SMOKE TEST FAILED");
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    // Only the newly opened LLM tab belongs to this smoke. Both Chrome processes belong to the operator.
    if (llmSession) await llmSession.close().catch(() => undefined);
    void reviewBrowser;
    void llmBrowser;
  }
}

run().then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 0); });
