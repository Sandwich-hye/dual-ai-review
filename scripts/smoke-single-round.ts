import { chromium } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import { createChatGPTConversationalAdapter } from "../src/sites/chatgptSite";
import { createClaudeConversationalAdapter } from "../src/sites/claudeSite";
import { runSingleReviewRound, SingleReviewRoundError } from "../src/orchestration/runSingleReviewRound";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const TASK = "Give exactly three practical benefits of automated software testing.";

async function run(): Promise<number> {
  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const pages = browser.contexts().flatMap(context => context.pages());
    const { chatgpt, claude } = discoverSitePages(pages);
    if (!chatgpt) throw new Error("No existing ChatGPT tab was found by hostname.");
    if (!claude) throw new Error("No existing Claude tab was found by hostname.");

    const result = await runSingleReviewRound({
      originalTask: TASK,
      chatgpt: { page: chatgpt, adapter: createChatGPTConversationalAdapter(chatgpt.url()) },
      claude: { page: claude, adapter: createClaudeConversationalAdapter(claude.url()) },
    });

    console.log("Original task:");
    console.log(result.originalTask);
    console.log("\nChatGPT response:");
    console.log(result.chatgptResponse);
    console.log("\nClaude review:");
    console.log(result.claudeReview);
    console.log("\nSINGLE-ROUND SMOKE TEST PASSED");
    return 0;
  } catch (error) {
    console.error("SINGLE-ROUND SMOKE TEST FAILED");
    if (error instanceof SingleReviewRoundError) {
      console.error("Failed stage: " + error.stage);
      console.error("Details: " + error.message);
    } else {
      console.error("Failed stage: connecting/discovering tabs");
      console.error("Details: " + (error instanceof Error ? error.message : String(error)));
    }
    return 1;
  }
}

run().then(code => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 0);
});

