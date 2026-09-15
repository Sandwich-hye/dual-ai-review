import { chromium } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import {
  checkClaudeReady,
  createClaudeConversationalAdapter,
  captureClaudeTurnBaseline,
  getLatestAssistantResponse,
  waitForGenerationComplete,
  waitForGenerationStart,
} from "../src/sites/claudeSite";
import { countVisibleClaudeUserMessages, userMessageMarkerState } from "../src/sites/claudeUserTurns";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const PROMPT = [
  "You are the reviewer.",
  "",
  "Original task:",
  "---",
  "Give exactly three practical benefits of automated software testing.",
  "---",
  "",
  "ChatGPT's proposed answer:",
  "---",
  "1. Faster feedback",
  "2. Fewer regressions",
  "3. Reduced manual effort",
  "---",
  "",
  "Review the proposed answer.",
  "",
  "Identify:",
  "- factual or logical errors",
  "- missing requirements",
  "- implementation risks",
  "- unnecessary complexity",
].join("\n");

async function run(): Promise<number> {
  let stage = "connecting to dedicated Chrome";
  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const pages = browser.contexts().flatMap(context => context.pages());
    const { claude } = discoverSitePages(pages);
    if (!claude) throw new Error("No existing Claude tab was found by hostname.");
    const adapter = createClaudeConversationalAdapter(claude.url());

    stage = "checking Claude readiness";
    const readiness = await checkClaudeReady(claude);
    if (readiness !== "ready") throw new Error("Claude is not ready: " + readiness);

    stage = "capturing the Claude baseline";
    const baseline = await captureClaudeTurnBaseline(claude);
    const userTurnBaselineCount = await countVisibleClaudeUserMessages(claude);

    stage = "submitting one multiline prompt";
    await adapter.sendPrompt(claude, PROMPT);
    const deadline = Date.now() + 5000;
    let userTurnCount = userTurnBaselineCount;
    while (Date.now() < deadline) {
      userTurnCount = await countVisibleClaudeUserMessages(claude);
      if (userTurnCount >= userTurnBaselineCount + 1) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (userTurnCount !== userTurnBaselineCount + 1) {
      throw new Error("Expected exactly one new structural Claude user turn, baseline " + userTurnBaselineCount + ", current " + userTurnCount);
    }
    const markerState = await userMessageMarkerState(claude);
    console.log("One structural multiline user turn submitted: " + JSON.stringify(markerState));

    stage = "waiting for generation to start";
    if (await adapter.waitForGenerationStart(claude, baseline) !== "started") throw new Error("Generation did not start within the bounded startup timeout.");

    stage = "waiting for generation to complete";
    const completion = await adapter.waitForGenerationComplete(claude, baseline, 180000);
    if (completion.outcome !== "complete") throw new Error(completion.outcome === "timeout" ? "Generation timed out" : completion.detail);

    stage = "reading the Claude response";
    console.log("Claude review:");
    console.log(await getLatestAssistantResponse(claude, baseline));
    console.log("LONG-PROMPT SMOKE TEST PASSED");
    return 0;
  } catch (error) {
    console.error("LONG-PROMPT SMOKE TEST FAILED");
    console.error("Failed stage: " + stage);
    console.error("Details: " + (error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

run().then(code => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 0);
});


