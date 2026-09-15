import { Page } from "playwright";
import { AmbiguousNewMessageError, captureTurnBaseline, countForSelectorGroup, firstVisible, firstVisibleEnabled, hasVisible, readNewAssistantText, resolveNewAssistantMessage, sleep } from "../browser/domUtil";
import { claudeSelectors } from "./selectors/claudeSelectors";
import { ConversationalSiteAdapter, GenerationOutcome, GenerationStartResult, SiteAdapter, SiteLoadStatus, TurnBaseline } from "./siteTypes";

const POLL_INTERVAL_MS = 100;
const STABILITY_INTERVAL_MS = 700;

export class ClaudeOperationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ClaudeOperationError"; }
}
export class ClaudeComposerNotFoundError extends ClaudeOperationError {
  constructor() { super("composer_missing", "Claude composer was not found or visible"); }
}
export class ClaudeSubmissionError extends ClaudeOperationError {
  constructor(message: string) { super("submission_failed", message); }
}
export class ClaudeEmptyResponseError extends ClaudeOperationError {
  constructor() { super("empty_response", "Claude returned an empty assistant response"); }
}

export interface ClaudeAdapterOptions {
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  stabilityIntervalMs?: number;
}

export function createClaudeSite(url: string): SiteAdapter {
  return { name: "claude", url, checkReady: checkClaudeReady };
}
export async function isClaudeSecurityVerificationVisible(page: Page): Promise<boolean> {
  return hasVisible(page, claudeSelectors.securityVerification);
}
export async function checkClaudeReady(page: Page): Promise<SiteLoadStatus> {
  if (await page.locator('input[type="password"], form:has(input[type="email"])').first().isVisible().catch(() => false)) return "login_required";
  if (await isClaudeSecurityVerificationVisible(page)) return "unknown_state";
  if (await page.getByRole("textbox").first().isVisible().catch(() => false)) return "ready";
  return "unknown_state";
}
function ensureConnected(page: Page): void {
  if (page.isClosed()) throw new ClaudeOperationError("browser_disconnected", "Claude page is closed or disconnected");
}
function textValue(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}
export async function captureClaudeTurnBaseline(page: Page): Promise<TurnBaseline> {
  ensureConnected(page);
  return captureTurnBaseline(page, claudeSelectors.assistantMessage);
}
export async function sendPrompt(page: Page, prompt: string): Promise<void> {
  ensureConnected(page);
  if (await page.locator('input[type="password"], form:has(input[type="email"])').first().isVisible().catch(() => false)) {
    throw new ClaudeOperationError("login_required", "Claude login is required");
  }
  if (await isClaudeSecurityVerificationVisible(page)) {
    throw new ClaudeOperationError("security_verification", "Claude security verification is visible; recover manually");
  }
  const composer = await firstVisible(page, claudeSelectors.composer);
  if (!composer) throw new ClaudeComposerNotFoundError();
  await composer.click().catch(() => { throw new ClaudeSubmissionError("Could not focus the Claude composer"); });
  await composer.fill(prompt).catch(() => undefined);
  let entered = textValue((await composer.innerText().catch(() => composer.textContent().catch(() => "") ?? "")) ?? "");
  if (!entered.includes(textValue(prompt))) {
    await composer.fill("").catch(() => undefined);
    await composer.pressSequentially(prompt).catch(() => { throw new ClaudeSubmissionError("Could not enter prompt into Claude composer"); });
    entered = textValue((await composer.innerText().catch(() => composer.textContent().catch(() => "") ?? "")) ?? "");
  }
  if (!entered.includes(textValue(prompt))) throw new ClaudeSubmissionError("Claude composer did not contain the submitted prompt");
  const sendButton = await firstVisibleEnabled(page, claudeSelectors.sendButton);
  if (sendButton) await sendButton.click().catch(() => { throw new ClaudeSubmissionError("Claude send button could not be clicked"); });
  else await composer.press("Enter").catch(() => { throw new ClaudeSubmissionError("Claude composer could not be submitted"); });
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    ensureConnected(page);
    if (await isClaudeSecurityVerificationVisible(page)) throw new ClaudeOperationError("security_verification", "Claude security verification appeared after submission; recover manually");
    const cleared = textValue((await composer.innerText().catch(() => composer.textContent().catch(() => "") ?? "")) ?? "") === "";
    if (cleared || await hasVisible(page, claudeSelectors.stopGenerating)) return;
    await sleep(50);
  }
  throw new ClaudeSubmissionError("Claude submission was not observed to begin");
}
export async function waitForGenerationStart(page: Page, baseline: TurnBaseline, options: ClaudeAdapterOptions = {}): Promise<GenerationStartResult> {
  ensureConnected(page);
  const deadline = Date.now() + (options.startTimeoutMs ?? 5000);
  while (Date.now() < deadline) {
    ensureConnected(page);
    if (await isClaudeSecurityVerificationVisible(page)) throw new ClaudeOperationError("security_verification", "Claude security verification appeared; recover manually");
    if (await hasVisible(page, claudeSelectors.stopGenerating) || await countForSelectorGroup(page, claudeSelectors.assistantMessage) > baseline.count) return "started";
    await sleep(options.pollIntervalMs ?? POLL_INTERVAL_MS);
  }
  return "not_observed";
}
export async function waitForGenerationComplete(page: Page, baseline: TurnBaseline, timeoutMs: number, options: ClaudeAdapterOptions = {}): Promise<GenerationOutcome> {
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
    if (await isClaudeSecurityVerificationVisible(page)) {
      return { outcome: "error_banner", detail: "Claude security verification is visible; recover manually" };
    }
    const banner = await firstVisible(page, claudeSelectors.errorBanner);
    if (banner) return { outcome: "error_banner", detail: textValue(await banner.innerText().catch(() => "Claude reported an error")) };
    const generationActiveVisible = await hasVisible(page, claudeSelectors.stopGenerating);
    const candidate = await readNewAssistantText(page, claudeSelectors.assistantMessage, baseline, claudeSelectors.assistantResponseText);
    const normalizedCandidate = candidate?.trim() ?? "";
    const newResponseFound = candidate !== undefined;
    const sendVisible = await hasVisible(page, claudeSelectors.sendButton);
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
    lastDiagnostics = { generationActiveVisible, newResponseFound, textLength: normalizedCandidate.length, textStableForMs, sendVisible };
    await sleep(pollInterval);
  }
  return {
    outcome: "timeout",
    partialText: await readNewAssistantText(page, claudeSelectors.assistantMessage, baseline, claudeSelectors.assistantResponseText) ?? "",
    diagnostics: lastDiagnostics,
  };
}
export async function getLatestAssistantResponse(page: Page, baseline: TurnBaseline): Promise<string> {
  ensureConnected(page);
  let response: string;
  try {
    response = await resolveNewAssistantMessage(page, claudeSelectors.assistantMessage, baseline, claudeSelectors.assistantResponseText);
  } catch (error) {
    if (error instanceof AmbiguousNewMessageError) throw error;
    throw new ClaudeOperationError("response_detection_failed", error instanceof Error ? error.message : String(error));
  }
  const normalized = textValue(response);
  if (!normalized) throw new ClaudeEmptyResponseError();
  return normalized;
}
export function createClaudeConversationalAdapter(url: string): ConversationalSiteAdapter {
  return { name: "claude", url, checkReady: checkClaudeReady, sendPrompt, waitForGenerationStart, waitForGenerationComplete, getLatestAssistantResponse };
}

