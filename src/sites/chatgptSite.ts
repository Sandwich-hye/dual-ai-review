import { Page } from "playwright";
import { AmbiguousNewMessageError, captureTurnBaseline, countForSelectorGroup, firstVisible, firstVisibleEnabled, hasVisible, normalizeLogicalText, readNewAssistantText, readProseMirrorLogicalText, resolveNewAssistantMessage, sleep } from "../browser/domUtil";
import { chatgptSelectors } from "./selectors/chatgptSelectors";
import { ConversationalSiteAdapter, GenerationOutcome, GenerationStartResult, SiteAdapter, SiteLoadStatus, TurnBaseline } from "./siteTypes";

const POLL_INTERVAL_MS = 100;
const STABILITY_INTERVAL_MS = 700;

export class ChatGPTOperationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ChatGPTOperationError"; }
}
export class ComposerNotFoundError extends ChatGPTOperationError {
  constructor() { super("composer_missing", "ChatGPT composer was not found or visible"); }
}
export class SubmissionError extends ChatGPTOperationError {
  constructor(message: string) { super("submission_failed", message); }
}
export class EmptyResponseError extends ChatGPTOperationError {
  constructor() { super("empty_response", "ChatGPT returned an empty assistant response"); }
}

export interface ChatGPTAdapterOptions {
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  stabilityIntervalMs?: number;
}

export function createChatGPTSite(url: string): SiteAdapter {
  return { name: "chatgpt", url, checkReady: checkChatGPTReady };
}
export async function checkChatGPTReady(page: Page): Promise<SiteLoadStatus> {
  if (await page.locator('input[type="password"], form:has(input[type="email"])').first().isVisible().catch(() => false)) return "login_required";
  if (await page.getByRole("textbox").first().isVisible().catch(() => false)) return "ready";
  return "unknown_state";
}
function ensureConnected(page: Page): void {
  if (page.isClosed()) throw new ChatGPTOperationError("browser_disconnected", "ChatGPT page is closed or disconnected");
}
function textValue(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}
export async function captureChatGPTTurnBaseline(page: Page): Promise<TurnBaseline> {
  ensureConnected(page);
  return captureTurnBaseline(page, chatgptSelectors.assistantMessage);
}
export async function sendPrompt(page: Page, prompt: string): Promise<void> {
  ensureConnected(page);
  if (await page.locator('input[type="password"], form:has(input[type="email"])').first().isVisible().catch(() => false)) {
    throw new ChatGPTOperationError("login_required", "ChatGPT login is required");
  }
  const composer = await firstVisible(page, chatgptSelectors.composer);
  if (!composer) throw new ComposerNotFoundError();
  await composer.click().catch(() => { throw new SubmissionError("Could not focus the ChatGPT composer"); });
  await composer.fill(prompt).catch(() => { throw new SubmissionError("Could not enter prompt into ChatGPT composer"); });
  const tagName = await composer.evaluate(node => node.tagName.toLowerCase()).catch(() => "");
  const enteredRaw = tagName === "textarea" || tagName === "input"
    ? await composer.inputValue().catch(() => "")
    : await readProseMirrorLogicalText(composer).catch(() => "");
  if (normalizeLogicalText(enteredRaw) !== normalizeLogicalText(prompt)) {
    throw new SubmissionError("ChatGPT composer did not contain the submitted prompt");
  }
  const sendButton = await firstVisibleEnabled(page, chatgptSelectors.sendButton);
  if (sendButton) await sendButton.click().catch(() => { throw new SubmissionError("ChatGPT send button could not be clicked"); });
  else await composer.press("Enter").catch(() => { throw new SubmissionError("ChatGPT composer could not be submitted"); });
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    ensureConnected(page);
    const cleared = textValue((await composer.innerText().catch(() => composer.textContent().catch(() => "") ?? "")) ?? "") === "";
    if (cleared || await hasVisible(page, chatgptSelectors.stopGenerating)) return;
    await sleep(50);
  }
  throw new SubmissionError("ChatGPT submission was not observed to begin");
}
export async function waitForGenerationStart(page: Page, baseline: TurnBaseline, options: ChatGPTAdapterOptions = {}): Promise<GenerationStartResult> {
  ensureConnected(page);
  const deadline = Date.now() + (options.startTimeoutMs ?? 5000);
  while (Date.now() < deadline) {
    ensureConnected(page);
    if (await hasVisible(page, chatgptSelectors.stopGenerating) || await countForSelectorGroup(page, chatgptSelectors.assistantMessage) > baseline.count) return "started";
    await sleep(options.pollIntervalMs ?? POLL_INTERVAL_MS);
  }
  return "not_observed";
}
export async function waitForGenerationComplete(page: Page, baseline: TurnBaseline, timeoutMs: number, options: ChatGPTAdapterOptions = {}): Promise<GenerationOutcome> {
  ensureConnected(page);
  const deadline = Date.now() + timeoutMs;
  const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const stabilityInterval = options.stabilityIntervalMs ?? STABILITY_INTERVAL_MS;
  let lastText = "";
  let stableSince: number | undefined;
  let inactivePolls = 0;
  let lastDiagnostics = {
    generationActiveVisible: false,
    newResponseFound: false,
    textLength: 0,
    textStableForMs: 0,
    sendVisible: false,
  };

  while (Date.now() < deadline) {
    ensureConnected(page);
    const banner = await firstVisible(page, chatgptSelectors.errorBanner);
    if (banner) return { outcome: "error_banner", detail: textValue(await banner.innerText().catch(() => "ChatGPT reported an error")) };

    const generationActiveVisible = await hasVisible(page, chatgptSelectors.stopGenerating);
    const candidate = await readNewAssistantText(page, chatgptSelectors.assistantMessage, baseline);
    const normalizedCandidate = candidate?.trim() ?? "";
    const newResponseFound = candidate !== undefined;
    const sendVisible = await hasVisible(page, chatgptSelectors.sendButton);

    if (generationActiveVisible) {
      inactivePolls = 0;
      stableSince = undefined;
      lastText = normalizedCandidate;
    } else {
      inactivePolls += 1;
      if (!normalizedCandidate) {
        stableSince = undefined;
        lastText = "";
      } else if (normalizedCandidate !== lastText) {
        lastText = normalizedCandidate;
        stableSince = Date.now();
      } else if (stableSince === undefined) {
        stableSince = Date.now();
      }

      const textStableForMs = stableSince === undefined ? 0 : Date.now() - stableSince;
      if (newResponseFound && normalizedCandidate.length > 0 && inactivePolls >= 2 && textStableForMs >= stabilityInterval) {
        return { outcome: "complete" };
      }
    }

    const textStableForMs = stableSince === undefined ? 0 : Date.now() - stableSince;
    lastDiagnostics = {
      generationActiveVisible,
      newResponseFound,
      textLength: normalizedCandidate.length,
      textStableForMs,
      sendVisible,
    };
    await sleep(pollInterval);
  }

  return {
    outcome: "timeout",
    partialText: await readNewAssistantText(page, chatgptSelectors.assistantMessage, baseline) ?? "",
    diagnostics: lastDiagnostics,
  };
}
export async function getLatestAssistantResponse(page: Page, baseline: TurnBaseline): Promise<string> {
  ensureConnected(page);
  let response: string;
  try {
    response = await resolveNewAssistantMessage(page, chatgptSelectors.assistantMessage, baseline);
  } catch (error) {
    if (error instanceof AmbiguousNewMessageError) throw error;
    throw new ChatGPTOperationError("response_detection_failed", error instanceof Error ? error.message : String(error));
  }
  const normalized = textValue(response);
  if (!normalized) throw new EmptyResponseError();
  return normalized;
}
export function createChatGPTConversationalAdapter(url: string): ConversationalSiteAdapter {
  return { name: "chatgpt", url, checkReady: checkChatGPTReady, captureTurnBaseline: captureChatGPTTurnBaseline, sendPrompt, waitForGenerationStart, waitForGenerationComplete, getLatestAssistantResponse };
}

