import { chromium } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import { createChatGPTConversationalAdapter } from "../src/sites/chatgptSite";
import { createClaudeConversationalAdapter } from "../src/sites/claudeSite";
import { countForSelectorGroup } from "../src/browser/domUtil";
import { chatgptSelectors } from "../src/sites/selectors/chatgptSelectors";
import { claudeSelectors } from "../src/sites/selectors/claudeSelectors";
import { claudeUserMessageSelector } from "../src/sites/claudeUserTurns";
import { FixedReviewLoopError, runFixedReviewLoop } from "../src/orchestration/runFixedReviewLoop";
import type { ConversationalSiteAdapter } from "../src/sites/siteTypes";
import { newStableIds } from "./smokeTurnIdentity";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const TASK = "Give exactly three practical benefits of automated software testing, with one sentence of explanation for each.";
const reviewRounds = 2;

type RoleIds = { user: Set<string>; assistant: Set<string> };

async function stableIds(page: import("playwright").Page, selectors: readonly string[], role: "user" | "assistant", claude: boolean): Promise<Set<string>> {
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

async function captureRoleIds(page: import("playwright").Page, assistantSelectors: readonly string[], userSelector: string, claude: boolean): Promise<RoleIds> {
  return { user: await stableIds(page, [userSelector], "user", claude), assistant: await stableIds(page, assistantSelectors, "assistant", claude) };
}

function withStageTiming(adapter: ConversationalSiteAdapter, labels: readonly string[]): ConversationalSiteAdapter {
  let turn = 0; let label = "";
  return {
    ...adapter,
    waitForGenerationStart: async (page, baseline, options) => {
      label = labels[turn++] ?? "unknown"; const started = Date.now();
      const timeoutMs = options?.startTimeoutMs ?? 5000;
      console.log(`[${label}] generation start wait began timeoutMs=${timeoutMs}`);
      try { return await adapter.waitForGenerationStart(page, baseline, options); }
      finally { console.log(`[${label}] generation start wait ended elapsedMs=${Date.now() - started}`); }
    },
    waitForGenerationComplete: async (page, baseline, timeoutMs) => {
      const started = Date.now();
      console.log(`[${label}] generation complete wait began timeoutMs=${timeoutMs}`);
      try { return await adapter.waitForGenerationComplete(page, baseline, timeoutMs); }
      finally { console.log(`[${label}] generation complete wait ended elapsedMs=${Date.now() - started}`); }
    },
  };
}

async function run(): Promise<number> {
  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const pages = browser.contexts().flatMap(context => context.pages());
    const { chatgpt, claude } = discoverSitePages(pages);
    if (!chatgpt) throw new Error("No existing ChatGPT tab was found by hostname.");
    if (!claude) throw new Error("No existing Claude tab was found by hostname.");
    process.env.DUAL_AI_REVIEW_CLAUDE_TIMING = "1";
    const chatgptAdapter = withStageTiming(createChatGPTConversationalAdapter(chatgpt.url()), ["G0", "G1", "G2"]);
    const claudeAdapter = withStageTiming(createClaudeConversationalAdapter(claude.url()), ["C1", "C2"]);
    const initialChatgptRoles = await captureRoleIds(chatgpt, chatgptSelectors.assistantMessage, '[data-message-author-role="user"]', false);
    const initialClaudeRoles = await captureRoleIds(claude, claudeSelectors.assistantMessage, claudeUserMessageSelector, true);
    const result = await runFixedReviewLoop({ originalTask: TASK, reviewRounds, chatgpt: { page: chatgpt, adapter: chatgptAdapter }, claude: { page: claude, adapter: claudeAdapter } });
    const finalChatgptRoles = await captureRoleIds(chatgpt, chatgptSelectors.assistantMessage, '[data-message-author-role="user"]', false);
    const finalClaudeRoles = await captureRoleIds(claude, claudeSelectors.assistantMessage, claudeUserMessageSelector, true);
    const expectedChatgpt = reviewRounds + 1; const expectedClaude = reviewRounds;
    const chatgptNewUsers = newStableIds(initialChatgptRoles.user, [...finalChatgptRoles.user]);
    const chatgptNewAssistants = newStableIds(initialChatgptRoles.assistant, [...finalChatgptRoles.assistant]);
    const claudeNewUsers = newStableIds(initialClaudeRoles.user, [...finalClaudeRoles.user]);
    const claudeNewAssistants = newStableIds(initialClaudeRoles.assistant, [...finalClaudeRoles.assistant]);
    if (chatgptNewUsers.length !== expectedChatgpt || chatgptNewAssistants.length !== expectedChatgpt || claudeNewUsers.length !== expectedClaude || claudeNewAssistants.length !== expectedClaude) {
      console.error("Turn-count diagnostics:");
      console.error(`ChatGPT: user baseline=${initialChatgptRoles.user.size} current=${finalChatgptRoles.user.size} new=${chatgptNewUsers.length} expected=${expectedChatgpt}; assistant baseline=${initialChatgptRoles.assistant.size} current=${finalChatgptRoles.assistant.size} new=${chatgptNewAssistants.length} expected=${expectedChatgpt}`);
      console.error(`Claude: user baseline=${initialClaudeRoles.user.size} current=${finalClaudeRoles.user.size} new=${claudeNewUsers.length} expected=${expectedClaude}; assistant baseline=${initialClaudeRoles.assistant.size} current=${finalClaudeRoles.assistant.size} new=${claudeNewAssistants.length} expected=${expectedClaude}`);
      console.error("Classifiers: ChatGPT user=[data-message-author-role=\"user\"]; ChatGPT assistant=first non-empty selector group " + JSON.stringify(chatgptSelectors.assistantMessage) + "; Claude user=" + claudeUserMessageSelector + "; Claude assistant=first non-empty selector group " + JSON.stringify(claudeSelectors.assistantMessage));
      throw new Error("unexpected turn-count delta");
    }
    console.log("Original task:"); console.log(result.originalTask);
    console.log("\nInitial ChatGPT answer:"); console.log(result.initial.response);
    for (const round of result.rounds) { console.log(`\nRound ${round.roundNumber} Claude review:`); console.log(round.claudeReviewResponse); console.log(`\nRound ${round.roundNumber} ChatGPT revision:`); console.log(round.chatgptRevisionResponse); }
    console.log("\nFinal answer:"); console.log(result.finalAnswer); console.log("\nMULTI-ROUND SMOKE TEST PASSED"); return 0;
  } catch (error) {
    console.error(error instanceof Error && error.message === "unexpected turn-count delta" ? "MULTI-ROUND SMOKE TEST FAILED: unexpected turn-count delta" : "MULTI-ROUND SMOKE TEST FAILED");
    if (error instanceof FixedReviewLoopError) { console.error("Failed stage: " + JSON.stringify(error.stage)); console.error("Details: " + error.message); console.error("Completed rounds: " + error.partialResult.rounds.length); }
    else if (!(error instanceof Error && error.message === "unexpected turn-count delta")) console.error("Details: " + (error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

run().then(code => { process.exitCode = code; setTimeout(() => process.exit(code), 0); });