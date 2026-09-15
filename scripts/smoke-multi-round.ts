import { chromium } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import { createChatGPTConversationalAdapter } from "../src/sites/chatgptSite";
import { createClaudeConversationalAdapter } from "../src/sites/claudeSite";
import { FixedReviewLoopError, runFixedReviewLoop } from "../src/orchestration/runFixedReviewLoop";
import type { ConversationalSiteAdapter } from "../src/sites/siteTypes";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const TASK = "Give exactly three practical benefits of automated software testing, with one sentence of explanation for each.";
const reviewRounds = 2;

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
    const initialChatgptCount = (await chatgptAdapter.captureTurnBaseline(chatgpt)).count;
    const initialClaudeCount = (await claudeAdapter.captureTurnBaseline(claude)).count;
    const result = await runFixedReviewLoop({ originalTask: TASK, reviewRounds, chatgpt: { page: chatgpt, adapter: chatgptAdapter }, claude: { page: claude, adapter: claudeAdapter } });
    const finalChatgptCount = (await chatgptAdapter.captureTurnBaseline(chatgpt)).count;
    const finalClaudeCount = (await claudeAdapter.captureTurnBaseline(claude)).count;
    if (finalChatgptCount - initialChatgptCount !== reviewRounds + 1 || finalClaudeCount - initialClaudeCount !== reviewRounds) throw new Error("unexpected turn-count delta");
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
