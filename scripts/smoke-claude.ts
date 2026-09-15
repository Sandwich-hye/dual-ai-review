import { chromium } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import {
  captureClaudeTurnBaseline,
  checkClaudeReady,
  getLatestAssistantResponse,
  isClaudeSecurityVerificationVisible,
  sendPrompt,
  waitForGenerationComplete,
  waitForGenerationStart,
} from "../src/sites/claudeSite";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const PROMPT = "Reply with exactly: PHASE2_CLAUDE_OK";
const EXPECTED = "PHASE2_CLAUDE_OK";

async function run(): Promise<number> {
  let stage = "connecting to dedicated Chrome";
  let actualResponse: string | undefined;
  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const pages = browser.contexts().flatMap(context => context.pages());
    const { claude } = discoverSitePages(pages);
    if (!claude) throw new Error("No existing Claude tab was found by hostname.");
    console.log("Claude tab found");

    stage = "checking Claude readiness";
    if (await isClaudeSecurityVerificationVisible(claude)) {
      throw new Error("Claude security verification is visible. Recover it manually in the attached Chrome, then rerun the smoke test.");
    }
    const readiness = await checkClaudeReady(claude);
    if (readiness === "login_required") throw new Error("Claude reports login_required. Log in manually, then rerun the smoke test.");
    if (readiness === "unknown_state") throw new Error("Claude reports unknown_state or a security challenge. Recover manually, then rerun the smoke test.");
    if (readiness !== "ready") throw new Error("Claude is not ready: " + readiness);

    stage = "capturing the turn baseline";
    const baseline = await captureClaudeTurnBaseline(claude);
    console.log("Baseline captured");

    stage = "submitting the prompt";
    await sendPrompt(claude, PROMPT);
    console.log("Prompt submitted");

    stage = "waiting for generation to start";
    if (await waitForGenerationStart(claude, baseline) !== "started") throw new Error("Generation did not start within the bounded startup timeout.");
    console.log("Generation started");

    stage = "waiting for generation to complete";
    const completion = await waitForGenerationComplete(claude, baseline, 180000);
    if (completion.outcome !== "complete") {
      throw new Error(completion.outcome === "timeout"
        ? "Generation timed out. Partial response: " + completion.partialText + " Diagnostics: " + JSON.stringify(completion.diagnostics)
        : "Claude reported an error: " + completion.detail);
    }
    console.log("Generation completed");

    stage = "reading the latest assistant response";
    actualResponse = await getLatestAssistantResponse(claude, baseline);
    console.log("Latest response: " + actualResponse);
    if (actualResponse !== EXPECTED) throw new Error("Response did not exactly match the expected smoke-test text.");
    console.log("SMOKE TEST PASSED");
    return 0;
  } catch (error) {
    console.error("SMOKE TEST FAILED");
    console.error("Failed stage: " + stage);
    if (actualResponse !== undefined) console.error("Actual returned text: " + actualResponse);
    console.error("Details: " + (error instanceof Error ? error.message : String(error)));
    return 1;
  }
}
run().then(code => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 0);
});
