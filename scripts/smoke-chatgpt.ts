import { chromium } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import {
  captureChatGPTTurnBaseline,
  checkChatGPTReady,
  getLatestAssistantResponse,
  sendPrompt,
  waitForGenerationComplete,
  waitForGenerationStart,
} from "../src/sites/chatgptSite";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const PROMPT = "Reply with exactly: PHASE2_CHATGPT_OK";
const EXPECTED = "PHASE2_CHATGPT_OK";

async function run(): Promise<number> {
  let stage = "connecting to dedicated Chrome";
  let actualResponse: string | undefined;

  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const pages = browser.contexts().flatMap(context => context.pages());
    const { chatgpt } = discoverSitePages(pages);

    if (!chatgpt) throw new Error("No existing ChatGPT tab was found by hostname.");
    console.log("ChatGPT tab found");

    stage = "checking ChatGPT readiness";
    const readiness = await checkChatGPTReady(chatgpt);
    if (readiness === "login_required") {
      throw new Error("ChatGPT reports login_required. Recover manually in the attached Chrome, then rerun the smoke test.");
    }
    if (readiness === "unknown_state") {
      throw new Error("ChatGPT reports unknown_state. Recover the page manually in the attached Chrome, then rerun the smoke test.");
    }
    if (readiness !== "ready") throw new Error("ChatGPT is not ready: " + readiness);

    stage = "capturing the turn baseline";
    const baseline = await captureChatGPTTurnBaseline(chatgpt);
    console.log("Baseline captured");

    stage = "submitting the prompt";
    await sendPrompt(chatgpt, PROMPT);
    console.log("Prompt submitted");

    stage = "waiting for generation to start";
    const started = await waitForGenerationStart(chatgpt, baseline);
    if (started !== "started") throw new Error("Generation did not start within the bounded startup timeout.");
    console.log("Generation started");

    stage = "waiting for generation to complete";
    const completion = await waitForGenerationComplete(chatgpt, baseline, 180000);
    if (completion.outcome !== "complete") {
      throw new Error(completion.outcome === "timeout"
        ? "Generation timed out. Partial response: " + completion.partialText + " Diagnostics: " + JSON.stringify(completion.diagnostics)
        : "ChatGPT reported an error: " + completion.detail);
    }
    console.log("Generation completed");

    stage = "reading the latest assistant response";
    actualResponse = await getLatestAssistantResponse(chatgpt, baseline);
    console.log("Latest response: " + actualResponse);

    if (actualResponse !== EXPECTED) {
      throw new Error("Response did not exactly match the expected smoke-test text.");
    }

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
  // Do not call browser.close(): the Chrome process is manually owned by the user.
  process.exitCode = code;
  setTimeout(() => process.exit(code), 0);
});
