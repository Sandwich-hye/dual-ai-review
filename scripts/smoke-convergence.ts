import { chromium, Page } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import { chatgptSelectors } from "../src/sites/selectors/chatgptSelectors";
import { claudeSelectors } from "../src/sites/selectors/claudeSelectors";
import { claudeUserMessageSelector } from "../src/sites/claudeUserTurns";
import { createChatGPTConversationalAdapter } from "../src/sites/chatgptSite";
import { checkChatGPTReady } from "../src/sites/chatgptSite";
import { createClaudeConversationalAdapter, checkClaudeReady, isClaudeSecurityVerificationVisible } from "../src/sites/claudeSite";
import type { ConversationalSiteAdapter } from "../src/sites/siteTypes";
import { ConvergenceReviewLoopError, runConvergenceReviewLoop } from "../src/orchestration/runConvergenceReviewLoop";
import type { ConvergedReviewResult } from "../src/orchestration/convergence/types";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const TASK = "Give exactly three practical benefits of automated software testing, with one sentence of explanation for each.";
const MAX_ROUNDS = 5;
const GENERATION_START_TIMEOUT_MS = 30000;
const GENERATION_TIMEOUT_MS = 180000;

type RoleIds = { user: Set<string>; assistant: Set<string> };

async function stableIds(page: Page, selectors: readonly string[], role: "user" | "assistant", claude: boolean): Promise<Set<string>> {
  let selector = "";
  for (const candidate of selectors) {
    if (await page.locator(candidate).count().catch(() => 0) > 0) { selector = candidate; break; }
  }
  if (!selector) return new Set();
  const ids = await page.locator(selector).evaluateAll((nodes, details) => nodes.map((node, index) => {
    const element = node as HTMLElement;
    if (details.claude) {
      const label = element.getAttribute("aria-label");
      const match = label?.match(/^Message\s+(\d+)\s+of\s+\d+$/i);
      if (!match) throw new Error(`Claude ${details.role} message ${index + 1} is missing a stable Message ordinal`);
      return `claude:message:${match[1]}`;
    }
    for (const attribute of ["data-message-id", "data-conversation-turn-id", "data-turn-id"]) {
      const value = element.getAttribute(attribute);
      if (value) return `chatgpt:${details.role}:${attribute}:${value}`;
    }
    const parent = element.closest("[data-testid*='conversation-turn' i], [data-conversation-turn-id], [data-turn-id]");
    if (parent) {
      for (const attribute of ["data-message-id", "data-conversation-turn-id", "data-turn-id", "data-testid"]) {
        const value = parent.getAttribute(attribute);
        if (value) return `chatgpt:${details.role}:parent-${attribute}:${value}`;
      }
    }
    throw new Error(`ChatGPT ${details.role} message ${index + 1} has no stable structural identity`);
  }), { role, claude });
  return new Set(ids);
}

async function captureRoleIds(page: Page, assistantSelectors: readonly string[], userSelector: string, claude: boolean): Promise<RoleIds> {
  return { user: await stableIds(page, [userSelector], "user", claude), assistant: await stableIds(page, assistantSelectors, "assistant", claude) };
}

function withStageLogging(adapter: ConversationalSiteAdapter, prefix: "G" | "C"): ConversationalSiteAdapter {
  let turn = 0;
  let label = `${prefix}?`;
  return {
    ...adapter,
    sendPrompt: async (page, prompt) => {
      label = `${prefix}${prefix === "G" ? turn++ : ++turn}`;
      console.log(`[${label}] send`);
      await adapter.sendPrompt(page, prompt);
    },
    waitForGenerationStart: async (page, baseline, options) => {
      console.log(`[${label}] generation start`);
      return adapter.waitForGenerationStart(page, baseline, options);
    },
    getLatestAssistantResponse: async (page, baseline) => {
      const response = await adapter.getLatestAssistantResponse(page, baseline);
      console.log(`[${label}] complete`);
      return response;
    },
  };
}

function assertBlankFreshTab(label: string, roles: RoleIds): void {
  if (roles.user.size !== 0 || roles.assistant.size !== 0) {
    throw new Error(`${label} tab is not a fresh blank conversation (user=${roles.user.size}, assistant=${roles.assistant.size}); open a fresh tab manually and rerun.`);
  }
}

function assertDecisionShape(result: ConvergedReviewResult): void {
  if (!result.initial.response.trim()) throw new Error("Initial ChatGPT answer is empty");
  if (result.rounds.length < 1) throw new Error("No Claude review rounds were returned");
  if (!result.finalAnswer.trim()) throw new Error("Final answer is empty");
  if (result.rounds.some((round, index) => round.roundNumber !== index + 1)) throw new Error("Round numbers are not sequential");
  for (const round of result.rounds) {
    const terminal = round.decision.kind === "CONVERGED" || round.decision.kind === "MAX_ROUNDS_REACHED" || round.decision.kind === "INVALID_REVIEW";
    if (terminal && round.chatgptRevisionResponse !== undefined) throw new Error(`Terminal round ${round.roundNumber} has a trailing ChatGPT revision`);
    if (round.decision.kind === "CONTINUE" && !round.chatgptRevisionResponse?.trim()) throw new Error(`CONTINUE round ${round.roundNumber} has no ChatGPT revision`);
  }
  if (result.rounds.length > result.maxRounds) throw new Error("Returned more rounds than maxRounds");
  JSON.stringify(result);
  const terminal = result.rounds[result.rounds.length - 1];
  if (result.stopReason === "INVALID_REVIEW") {
    const invalid = result.invalidReview;
    console.error(`INVALID_REVIEW at round ${invalid?.round ?? terminal.roundNumber}`);
    console.error(`Reason: ${invalid?.reason ?? "(invalidReview.reason missing)"}`);
    console.error("Raw Claude response:");
    console.error(invalid?.rawText ?? "(invalidReview.rawText missing)");
    throw new Error(`INVALID_REVIEW at round ${invalid?.round ?? terminal.roundNumber}`);
  }
  if (result.stopReason === "CONVERGED") {
    if (!result.convergenceHistory.rounds.at(-1)) throw new Error("Converged result has no terminal convergence history");
    if (terminal.decision.kind !== "CONVERGED" || terminal.decision.cleanStreak < 2 || terminal.decision.openHighCount !== 0 || terminal.decision.openMediumCount !== 0) {
      throw new Error("CONVERGED result does not satisfy clean-streak and open-objection requirements");
    }
    if (result.convergenceHistory.rounds.at(-1)!.decision.kind !== "CONVERGED") throw new Error("Terminal history decision is not CONVERGED");
  } else {
    if (result.stopReason !== "MAX_ROUNDS_REACHED") throw new Error(`Unexpected stopReason: ${result.stopReason}`);
    if (terminal.decision.kind !== "MAX_ROUNDS_REACHED" || result.rounds.length !== result.maxRounds) throw new Error("MAX_ROUNDS_REACHED result has the wrong round bound");
  }
}

function counts(result: ConvergedReviewResult): { high: number; medium: number } {
  return {
    high: result.ledger.filter(entry => entry.status === "OPEN" && entry.severity === "HIGH").length,
    medium: result.ledger.filter(entry => entry.status === "OPEN" && entry.severity === "MEDIUM").length,
  };
}

function diagnostic(error: unknown): void {
  if (error instanceof ConvergenceReviewLoopError) {
    const partial = error.partialResult;
    const currentAnswer = partial.rounds.at(-1)?.chatgptRevisionResponse ?? partial.initial?.response;
    console.error(JSON.stringify({
      model: error.stage.site,
      round: error.stage.round,
      stage: `${error.stage.turn}.${error.stage.step}`,
      stopReason: "ADAPTER_OR_STAGE_FAILURE",
      error: error.message,
      completedRounds: partial.rounds.length,
      currentAnswerPresent: Boolean(currentAnswer?.trim()),
      ledger: partial.ledger.map(entry => ({ id: entry.id, severity: entry.severity, status: entry.status })),
    }, null, 2));
  } else console.error(JSON.stringify({ stage: "precondition-or-validation", error: error instanceof Error ? error.message : String(error) }, null, 2));
}

async function run(): Promise<number> {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const pages = browser.contexts().flatMap(context => context.pages());
    const { chatgpt, claude } = discoverSitePages(pages);
    if (!chatgpt) throw new Error("No existing ChatGPT tab was found; manually open a fresh blank ChatGPT chat.");
    if (!claude) throw new Error("No existing Claude tab was found; manually open a fresh blank Claude chat.");
    if (await isClaudeSecurityVerificationVisible(claude)) throw new Error("Claude security verification is visible; complete it manually in attached Chrome and rerun.");
    const chatgptReady = await checkChatGPTReady(chatgpt);
    if (chatgptReady !== "ready") throw new Error(`ChatGPT is ${chatgptReady}; complete security/login manually and rerun.`);
    const claudeReady = await checkClaudeReady(claude);
    if (claudeReady !== "ready") throw new Error(`Claude is ${claudeReady}; complete security/login manually and rerun.`);

    const initialChatgptRoles = await captureRoleIds(chatgpt, chatgptSelectors.assistantMessage, '[data-message-author-role="user"]', false);
    const initialClaudeRoles = await captureRoleIds(claude, claudeSelectors.assistantMessage, claudeUserMessageSelector, true);
    assertBlankFreshTab("ChatGPT", initialChatgptRoles);
    assertBlankFreshTab("Claude", initialClaudeRoles);
    console.log("Attached to ready, fresh ChatGPT and Claude tabs.");

    const result = await runConvergenceReviewLoop({
      originalTask: TASK,
      generationStartTimeoutMs: GENERATION_START_TIMEOUT_MS,
      options: { maxRounds: MAX_ROUNDS },
      chatgpt: { page: chatgpt, adapter: withStageLogging(createChatGPTConversationalAdapter(chatgpt.url()), "G"), generationTimeoutMs: GENERATION_TIMEOUT_MS },
      claude: { page: claude, adapter: withStageLogging(createClaudeConversationalAdapter(claude.url()), "C"), generationTimeoutMs: GENERATION_TIMEOUT_MS },
    });
    assertDecisionShape(result);
    for (const round of result.rounds) {
      console.log(`[C${round.roundNumber}] decision=${round.decision.kind}`);
      console.log(`[C${round.roundNumber}] cleanStreak=${round.decision.cleanStreak}`);
      console.log(`[C${round.roundNumber}] openHigh=${round.decision.openHighCount}`);
      console.log(`[C${round.roundNumber}] openMedium=${round.decision.openMediumCount}`);
    }

    const finalChatgptRoles = await captureRoleIds(chatgpt, chatgptSelectors.assistantMessage, '[data-message-author-role="user"]', false);
    const finalClaudeRoles = await captureRoleIds(claude, claudeSelectors.assistantMessage, claudeUserMessageSelector, true);
    const expectedChatgptTurns = 1 + result.rounds.filter(round => round.decision.kind === "CONTINUE").length;
    if ([...finalChatgptRoles.user].filter(id => !initialChatgptRoles.user.has(id)).length !== expectedChatgptTurns || [...finalChatgptRoles.assistant].filter(id => !initialChatgptRoles.assistant.has(id)).length !== expectedChatgptTurns || [...finalClaudeRoles.user].filter(id => !initialClaudeRoles.user.has(id)).length !== result.rounds.length || [...finalClaudeRoles.assistant].filter(id => !initialClaudeRoles.assistant.has(id)).length !== result.rounds.length) {
      throw new Error(`stable identity turn verification failed (expected ChatGPT=${expectedChatgptTurns}, Claude=${result.rounds.length})`);
    }
    const open = counts(result);
    console.log(`Original task: ${TASK}`);
    console.log(`Rounds consumed: ${result.rounds.length}`);
    console.log(`Stop reason: ${result.stopReason}`);
    console.log(`Converged: ${result.stopReason === "CONVERGED"}`);
    console.log(`Final cleanStreak: ${result.rounds.at(-1)!.decision.cleanStreak}`);
    console.log(`Remaining OPEN HIGH: ${open.high}`);
    console.log(`Remaining OPEN MEDIUM: ${open.medium}`);
    console.log(`Final answer:\n${result.finalAnswer}`);
    console.log("CONVERGENCE SMOKE TEST PASSED");
    return 0;
  } catch (error) {
    console.error("CONVERGENCE SMOKE TEST FAILED");
    diagnostic(error);
    return 1;
  } finally {
    // The attached Chrome is owned by the human; never close it here.
    void browser;
  }
}

run().then(code => { process.exitCode = code; setTimeout(() => process.exit(code), 0); });
