import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium, type Page } from "playwright";
import {
  runAuditedReviewLoop,
  AuditedReviewLoopError,
  type AuditedReviewLoopInput,
} from "../src/orchestration/runAuditedReviewLoop";
import type { HumanGate, HumanGatePresentation, HumanGateRawResponse } from "../src/orchestration/humanGate/humanGate";
import { createChatGPTConversationalAdapter, checkChatGPTReady } from "../src/sites/chatgptSite";
import { createClaudeConversationalAdapter, checkClaudeReady, isClaudeSecurityVerificationVisible } from "../src/sites/claudeSite";
import { chatgptSelectors } from "../src/sites/selectors/chatgptSelectors";
import { claudeSelectors } from "../src/sites/selectors/claudeSelectors";
import { claudeUserMessageSelector } from "../src/sites/claudeUserTurns";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const TASK = "Give exactly three practical benefits of automated software testing, with one sentence of explanation for each.";
const HARD_MAX_ROUNDS = 5;
const RECOMMENDED_MAX_ROUNDS = 3;
const GENERATION_START_TIMEOUT_MS = 30000;
const GENERATION_TIMEOUT_MS = 180000;

function host(page: Page): string {
  try { return new URL(page.url()).hostname.toLowerCase(); }
  catch { return ""; }
}

function isChatGptHost(value: string): boolean {
  return value === "chatgpt.com" || value.endsWith(".chatgpt.com") || value === "chat.openai.com";
}

function isClaudeHost(value: string): boolean {
  return value === "claude.ai" || value.endsWith(".claude.ai");
}

function exactlyOne(pages: readonly Page[], predicate: (page: Page) => boolean, label: string): Page {
  const matches = pages.filter(predicate);
  if (matches.length === 0) throw new Error(`No existing ${label} tab found; manually open exactly one fresh tab and rerun.`);
  if (matches.length > 1) throw new Error(`Multiple ${label} tabs found (${matches.length}); close ambiguous tabs and leave exactly one fresh tab.`);
  return matches[0];
}

async function assertFresh(page: Page, label: string, assistantSelectors: readonly string[], userSelector: string): Promise<void> {
  const assistantCount = await page.locator(assistantSelectors.join(",")).count().catch(() => 0);
  const userCount = await page.locator(userSelector).count().catch(() => 0);
  if (assistantCount !== 0 || userCount !== 0) {
    throw new Error(`${label} tab is not fresh (user messages=${userCount}, assistant messages=${assistantCount}); open a new manually prepared tab and rerun.`);
  }
}

function terminalHumanGate(): HumanGate {
  return {
    async presentAndAwaitDecision(presentation: HumanGatePresentation): Promise<HumanGateRawResponse> {
      console.log(`\n=== HUMAN GATE: round ${presentation.round} ===`);
      console.log(`Recommendation: ${presentation.recommendation.kind}`);
      console.log(`Branch: ${presentation.recommendation.triggeredBranch}`);
      console.log(`Reason: ${presentation.recommendation.reason}`);
      console.log(`Allowed outcomes: ${presentation.legalOutcomes.join(", ")}`);
      console.log(`Disputed claims: ${presentation.disputedClaims.length}`);
      for (const claim of presentation.disputedClaims) console.log(`- ${claim.id} [${claim.severity}] ${claim.claim.statement}`);
      for (const evidence of presentation.relevantEvidence) console.log(`  evidence ${evidence.id} (${evidence.kind}, ${evidence.strength}): ${evidence.text}`);

      const readline = createInterface({ input, output });
      try {
        let requestedOutcome = "";
        while (!presentation.legalOutcomes.includes(requestedOutcome as HumanGateRawResponse["requestedOutcome"])) {
          requestedOutcome = (await readline.question(`Choose ${presentation.legalOutcomes.join("/")}: `)).trim().toUpperCase();
        }
        const rationale = requestedOutcome === "REJECT"
          ? (await readline.question("Rationale (required): ")).trim()
          : undefined;
        if (requestedOutcome === "REJECT" && !rationale) throw new Error("REJECT requires a non-empty rationale");
        return {
          requestedOutcome: requestedOutcome as HumanGateRawResponse["requestedOutcome"],
          ...(rationale === undefined ? {} : { rationale }),
          decidedAt: new Date().toISOString(),
        };
      } finally {
        readline.close();
      }
    },
  };
}

function validateResult(result: Awaited<ReturnType<typeof runAuditedReviewLoop>>): void {
  if (!result.initial.response.trim()) throw new Error("Initial ChatGPT answer is empty");
  if (result.rounds.length < 1) throw new Error("No audited review rounds were returned");
  if (result.rounds.some((round, index) => round.roundNumber !== index + 1)) throw new Error("Round numbers are not sequential");
  for (const round of result.rounds) {
    if (!Array.isArray(round.ledgerSnapshot)) throw new Error(`Round ${round.roundNumber} has no ledger snapshot`);
    if (!round.humanDecision || !round.humanDecision.raw) throw new Error(`Round ${round.roundNumber} has no human decision record`);
    const terminal = round.humanDecision.outcome !== "CONTINUE";
    if (terminal && (round.generatorPrompt !== undefined || round.generatorResponse !== undefined)) {
      throw new Error(`Terminal round ${round.roundNumber} has a trailing generator revision`);
    }
    if (!terminal && !round.generatorResponse?.trim()) throw new Error(`CONTINUE round ${round.roundNumber} has no generator revision`);
  }
  if (!result.runAuditTrail) throw new Error("Audit trail is missing");
  JSON.parse(JSON.stringify(result));
}

function diagnostic(error: unknown): void {
  if (error instanceof AuditedReviewLoopError) {
    console.error(JSON.stringify({
      stage: error.stage,
      message: error.message,
      completedRounds: error.partialResult.rounds.length,
      initialAnswerPresent: Boolean(error.partialResult.initial?.response.trim()),
      ledgerEntries: error.partialResult.claimLedger.length,
      auditEvents: error.partialResult.runAuditTrail.length,
    }, null, 2));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
}

async function run(): Promise<number> {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const pages = browser.contexts().flatMap(context => context.pages());
    const chatgpt = exactlyOne(pages, page => isChatGptHost(host(page)), "ChatGPT");
    const claude = exactlyOne(pages, page => isClaudeHost(host(page)), "Claude");

    if (await isClaudeSecurityVerificationVisible(claude)) throw new Error("Claude security verification is visible; complete it manually and rerun.");
    const chatgptReady = await checkChatGPTReady(chatgpt);
    if (chatgptReady !== "ready") throw new Error(`ChatGPT is ${chatgptReady}; complete login/readiness manually and rerun.`);
    const claudeReady = await checkClaudeReady(claude);
    if (claudeReady !== "ready") throw new Error(`Claude is ${claudeReady}; complete login/readiness manually and rerun.`);
    await assertFresh(chatgpt, "ChatGPT", chatgptSelectors.assistantMessage, '[data-message-author-role="user"]');
    await assertFresh(claude, "Claude", claudeSelectors.assistantMessage, claudeUserMessageSelector);
    console.log("Attached to exactly one ready, fresh ChatGPT tab and one ready, fresh Claude tab.");

    const loopInput: AuditedReviewLoopInput = {
      originalTask: TASK,
      generationStartTimeoutMs: GENERATION_START_TIMEOUT_MS,
      options: { hardMaxRounds: HARD_MAX_ROUNDS, recommendedMaxRounds: RECOMMENDED_MAX_ROUNDS },
      chatgpt: { page: chatgpt, adapter: createChatGPTConversationalAdapter(chatgpt.url()), generationTimeoutMs: GENERATION_TIMEOUT_MS },
      claude: { page: claude, adapter: createClaudeConversationalAdapter(claude.url()), generationTimeoutMs: GENERATION_TIMEOUT_MS },
      humanGate: terminalHumanGate(),
    };
    const result = await runAuditedReviewLoop(loopInput);
    validateResult(result);
    console.log(`Initial answer present: ${Boolean(result.initial.response.trim())}`);
    console.log(`Audited rounds: ${result.rounds.length}`);
    console.log(`Audit events: ${result.runAuditTrail.length}`);
    console.log(`Final outcome: ${result.outcome} (${result.outcomeOrigin})`);
    console.log("AUDITED REVIEW SMOKE TEST PASSED");
    return 0;
  } catch (error) {
    console.error("AUDITED REVIEW SMOKE TEST FAILED");
    diagnostic(error);
    return 1;
  } finally {
    // The attached Chrome session belongs to the human. Never close it here.
    void browser;
  }
}

run().then(code => { process.exitCode = code; setTimeout(() => process.exit(code), 0); });
