import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium, type Page } from "playwright";
import {
  runAuditedReviewLoop,
  type AuditedReviewLoopInput,
} from "../src/orchestration/runAuditedReviewLoop";
import type { HumanGate, HumanGatePresentation, HumanGateRawResponse } from "../src/orchestration/humanGate/humanGate";
import { createSupervisedHumanGate, type SupervisedHumanGate } from "../src/orchestration/supervisor/supervisedHumanGate";
import { createDeterministicSupervisor } from "../src/orchestration/supervisor/deterministicSupervisor";
import type { SupervisedReviewResult } from "../src/orchestration/supervisor/types";
import { createChatGPTConversationalAdapter, checkChatGPTReady } from "../src/sites/chatgptSite";
import { createClaudeConversationalAdapter, checkClaudeReady, isClaudeSecurityVerificationVisible } from "../src/sites/claudeSite";
import { chatgptSelectors } from "../src/sites/selectors/chatgptSelectors";
import { claudeSelectors } from "../src/sites/selectors/claudeSelectors";
import { claudeUserMessageSelector } from "../src/sites/claudeUserTurns";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const TASK = "Give exactly three practical benefits of automated software testing, with one sentence of explanation for each.";

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
  if (matches.length === 0) throw new Error(`No ${label} tab found; manually open exactly one fresh tab and rerun.`);
  if (matches.length > 1) throw new Error(`Multiple ${label} tabs found; close ambiguous tabs and rerun with exactly one.`);
  return matches[0];
}

function terminalHumanGate(): HumanGate {
  return {
    async presentAndAwaitDecision(presentation: HumanGatePresentation): Promise<HumanGateRawResponse> {
      console.log(`\n=== HUMAN GATE: round ${presentation.round} ===`);
      console.log(`Recommendation: ${presentation.recommendation.kind}`);
      console.log(`Supervisor context is advisory; choose only from: ${presentation.legalOutcomes.join(", ")}`);
      console.log(`Reason: ${presentation.recommendation.reason}`);
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

function validate(result: SupervisedReviewResult): void {
  if (!result.base) throw new Error("Supervised result has no base audited result");
  if (result.supervisorAssessments.length !== result.base.rounds.length) throw new Error("Supervisor assessment count does not match audited rounds");
  for (const [index, round] of result.base.rounds.entries()) {
    const assessment = result.supervisorAssessments[index];
    if (!["CONTINUE", "ACCEPT", "REJECT"].includes(round.humanDecision.outcome)) throw new Error("Invalid human outcome in base result");
    if (!("unavailable" in assessment) && ("outcome" in assessment || "kind" in assessment)) throw new Error("Supervisor output contains an outcome decision");
  }
  JSON.parse(JSON.stringify(result));
}

async function run(): Promise<number> {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const pages = browser.contexts().flatMap((context) => context.pages());
    const chatgpt = exactlyOne(pages, (page) => isChatGpt(hostname(page)), "ChatGPT");
    const claude = exactlyOne(pages, (page) => isClaude(hostname(page)), "Claude");
    if (await isClaudeSecurityVerificationVisible(claude)) throw new Error("Claude security verification is visible; complete it manually and rerun.");
    if (await checkChatGPTReady(chatgpt) !== "ready") throw new Error("ChatGPT is not ready; complete login/readiness manually and rerun.");
    if (await checkClaudeReady(claude) !== "ready") throw new Error("Claude is not ready; complete login/readiness manually and rerun.");

    const supervisedGate: SupervisedHumanGate = createSupervisedHumanGate(
      terminalHumanGate(),
      createDeterministicSupervisor(),
      { invalidReviewRejectThreshold: 3, reopenRejectThreshold: 3 },
    );
    const loopInput: AuditedReviewLoopInput = {
      originalTask: TASK,
      options: { hardMaxRounds: 3, recommendedMaxRounds: 2 },
      chatgpt: { page: chatgpt, adapter: createChatGPTConversationalAdapter(chatgpt.url()), generationTimeoutMs: 180000 },
      claude: { page: claude, adapter: createClaudeConversationalAdapter(claude.url()), generationTimeoutMs: 180000 },
      humanGate: supervisedGate,
    };
    const base = await runAuditedReviewLoop(loopInput);
    const result: SupervisedReviewResult = {
      schemaVersion: 1,
      base,
      supervisorAssessments: supervisedGate.getAccumulatedAssessments(),
    };
    validate(result);
    console.log(`Audited rounds: ${result.base.rounds.length}`);
    console.log(`Supervisor assessments: ${result.supervisorAssessments.length}`);
    console.log(`Final outcome: ${result.base.outcome}`);
    console.log("SUPERVISED REVIEW SMOKE TEST PASSED");
    return 0;
  } catch (error) {
    console.error("SUPERVISED REVIEW SMOKE TEST FAILED");
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    // The attached Chrome session belongs to the human; never close it here.
    void browser;
  }
}

run().then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 0); });
