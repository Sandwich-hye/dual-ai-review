import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Page } from "playwright";
import { launchBrowser, type BrowserSession } from "../browser/launchBrowser";
import { discoverSitePages } from "../browser/discoverSitePages";
import { loadConfig } from "../config/loadConfig";
import { createLogger } from "../logging/logger";
import {
  AuditedReviewLoopError,
  type AuditedReviewLoopSite,
} from "../orchestration/runAuditedReviewLoop";
import { runDualAiConversation } from "../conversation/runDualAiConversation";
import type { HumanGate } from "../orchestration/humanGate/humanGate";
import type { HumanGatePresentation, HumanGateRawResponse } from "../orchestration/claims/types";
import { createOllamaAdapter } from "../providers/ollamaAdapter";
import { createOllamaSiteBridge } from "../providers/ollamaSiteBridge";
import { checkChatGPTReady, createChatGPTConversationalAdapter } from "../sites/chatgptSite";
import { checkClaudeReady, createClaudeConversationalAdapter, isClaudeSecurityVerificationVisible } from "../sites/claudeSite";
import { claudeUserMessageSelector } from "../sites/claudeUserTurns";
import { chatgptSelectors } from "../sites/selectors/chatgptSelectors";
import { claudeSelectors } from "../sites/selectors/claudeSelectors";
import { openSite } from "../sites/openSite";
import type { ProviderProvenance } from "../providers/llmProvider";
import { buildOriginalTask, loadReviewInput, parseReviewArgs, REVIEW_USAGE, type ReviewCliOptions } from "./reviewInput";
import { renderTerminalReport, type ReviewProvenance } from "./renderTerminalReport";
import { createTerminalConversationObserver } from "./renderConversationEvent";
import { completeReviewAudit, failedReviewAudit } from "./reviewAudit";

interface PreparedSites {
  generator: AuditedReviewLoopSite;
  reviewer: AuditedReviewLoopSite;
  providers: ReviewProvenance;
  close(): Promise<void>;
}

const browserProvenance = (providerName: string): ProviderProvenance => ({
  providerName,
  // Browser UIs do not reliably expose the exact model serving a turn.
  modelName: "not_reported_by_browser_ui",
  executionMode: "browser",
});

function isHost(page: Page, label: "ChatGPT" | "Claude"): boolean {
  try {
    const host = new URL(page.url()).hostname.toLowerCase();
    return label === "ChatGPT"
      ? host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com"
      : host === "claude.ai" || host.endsWith(".claude.ai");
  } catch { return false; }
}

function assertExactlyOne(pages: readonly Page[], page: Page | undefined, label: "ChatGPT" | "Claude"): Page {
  if (!page) throw new Error(`No ${label} tab found; open one fresh tab and retry`);
  if (pages.filter((candidate) => isHost(candidate, label)).length !== 1) {
    throw new Error(`Multiple ${label} tabs found; leave exactly one fresh tab open`);
  }
  return page;
}

async function assertFresh(page: Page, label: string, assistantSelectors: readonly string[], userSelector: string): Promise<void> {
  const assistantCount = await page.locator(assistantSelectors.join(",")).count();
  const userCount = await page.locator(userSelector).count();
  if (assistantCount > 0 || userCount > 0) {
    throw new Error(`${label} tab contains an existing conversation; use a fresh tab and retry`);
  }
}

async function browserSites(): Promise<PreparedSites> {
  const config = loadConfig();
  const logger = createLogger();
  const session: BrowserSession = await launchBrowser(config, logger);
  try {
    let chatgpt: Page;
    let claude: Page;
    if (config.browserMode === "attach") {
      const pages = session.context.pages();
      const discovered = discoverSitePages(pages);
      chatgpt = assertExactlyOne(pages, discovered.chatgpt, "ChatGPT");
      claude = assertExactlyOne(pages, discovered.claude, "Claude");
    } else {
      chatgpt = await session.context.newPage();
      claude = await session.context.newPage();
      const chatgptLoad = await openSite(chatgpt, createChatGPTConversationalAdapter(config.sites.chatgpt.url), config.navigationTimeoutMs, logger);
      const claudeLoad = await openSite(claude, createClaudeConversationalAdapter(config.sites.claude.url), config.navigationTimeoutMs, logger);
      if (chatgptLoad.status !== "ready" || claudeLoad.status !== "ready") {
        throw new Error(`Browser sites are not ready (ChatGPT: ${chatgptLoad.status}, Claude: ${claudeLoad.status}); complete login and retry`);
      }
    }
    if (await isClaudeSecurityVerificationVisible(claude)) throw new Error("Claude security verification is visible; complete it and retry");
    const chatgptReady = await checkChatGPTReady(chatgpt);
    const claudeReady = await checkClaudeReady(claude);
    if (chatgptReady !== "ready" || claudeReady !== "ready") {
      throw new Error(`Browser sites are not ready (ChatGPT: ${chatgptReady}, Claude: ${claudeReady}); complete login and retry`);
    }
    await assertFresh(chatgpt, "ChatGPT", chatgptSelectors.assistantMessage, '[data-message-author-role="user"]');
    await assertFresh(claude, "Claude", claudeSelectors.assistantMessage, claudeUserMessageSelector);
    return {
      generator: { page: chatgpt, adapter: createChatGPTConversationalAdapter(chatgpt.url()) },
      reviewer: { page: claude, adapter: createClaudeConversationalAdapter(claude.url()) },
      providers: { generator: browserProvenance("chatgpt"), reviewer: browserProvenance("claude") },
      close: async () => { if (session.ownsBrowser) await session.context.close(); },
    };
  } catch (error) {
    if (session.ownsBrowser) await session.context.close();
    throw error;
  }
}

function ollamaSites(options: ReviewCliOptions): PreparedSites {
  const provider = createOllamaAdapter({ modelName: options.model!, ...(options.ollamaEndpoint ? { endpoint: options.ollamaEndpoint } : {}) });
  // Temporary Page compatibility bridges; neither bridge accesses a browser Page.
  const generator = createOllamaSiteBridge(provider, "generator");
  const reviewer = createOllamaSiteBridge(provider, "reviewer");
  return {
    generator, reviewer,
    providers: { generator: generator.providerProvenance, reviewer: reviewer.providerProvenance },
    close: async () => undefined,
  };
}

function terminalHumanGate(): HumanGate {
  return {
    async presentAndAwaitDecision(presentation: HumanGatePresentation): Promise<HumanGateRawResponse> {
      console.log(`\n=== HUMAN GATE: round ${presentation.round} ===`);
      console.log(`Current answer:\n${presentation.currentAnswer}`);
      console.log(`Recommendation: ${presentation.recommendation.kind}`);
      console.log(`Branch: ${presentation.recommendation.triggeredBranch}`);
      console.log(`Reason: ${presentation.recommendation.reason}`);
      console.log(`Allowed outcomes: ${presentation.legalOutcomes.join(", ")}`);
      console.log(`Disputed claims: ${presentation.disputedClaims.length}`);
      for (const claim of presentation.disputedClaims) console.log(`- ${claim.id} [${claim.severity}] ${claim.claim.statement}`);
      for (const evidence of presentation.relevantEvidence) console.log(`  evidence ${evidence.id} (${evidence.kind}, ${evidence.strength}): ${evidence.text}`);
      const readline = createInterface({ input: stdin, output: stdout });
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

async function saveAudit(document: unknown, requestedPath?: string): Promise<string> {
  const outputPath = path.resolve(requestedPath ?? path.join(os.homedir(), ".dual-ai-review", "audits", `review-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`));
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return outputPath;
}

export async function runReviewCli(args: readonly string[]): Promise<number> {
  const parsed = parseReviewArgs(args);
  if ("help" in parsed) { console.log(REVIEW_USAGE); return 0; }
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Review requires an interactive terminal for Human Gate decisions");
  const reviewInput = await loadReviewInput(parsed);
  const prepared = parsed.provider === "ollama" ? ollamaSites(parsed) : await browserSites();
  try {
    const originalTask = buildOriginalTask(reviewInput);
    try {
      const conversation = await runDualAiConversation({
        originalTask,
        chatgpt: prepared.generator,
        claude: prepared.reviewer,
        humanGate: terminalHumanGate(),
        eventObserver: createTerminalConversationObserver(),
      });
      // Preserve the existing CLI audit/report contract; lifecycle events are display-only.
      const review = conversation.review.base;
      const auditPath = await saveAudit(completeReviewAudit(parsed.provider, prepared.providers, review), parsed.auditOut);
      console.log(renderTerminalReport(review, prepared.providers, auditPath));
      return 0;
    } catch (error) {
      if (error instanceof AuditedReviewLoopError) {
        const auditPath = await saveAudit(failedReviewAudit(
          parsed.provider,
          prepared.providers,
          { stage: error.stage, message: error.message },
          error.partialResult,
        ), parsed.auditOut);
        console.error(`Partial audit JSON: ${auditPath}`);
      }
      throw error;
    }
  } finally {
    await prepared.close();
  }
}

if (require.main === module) {
  runReviewCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
