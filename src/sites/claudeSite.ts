import { Locator, Page } from "playwright";
import { AmbiguousNewMessageError, firstVisible, firstVisibleEnabled, hasVisible, normalizeLogicalText, readProseMirrorLogicalText, sleep } from "../browser/domUtil";
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
function composerTextValue(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
export function claudeMessageIdentity(ariaLabel: string | null): string | undefined {
  const match = ariaLabel?.match(/^Message\s+(\d+)\s+of\s+\d+$/i);
  return match ? `message:${match[1]}` : undefined;
}

async function mountedClaudeAssistantMessages(page: Page): Promise<Array<{ id: string; locator: Locator }>> {
  for (const selector of claudeSelectors.assistantMessage) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;
    const messages: Array<{ id: string; locator: Locator }> = [];
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      const id = claudeMessageIdentity(await item.getAttribute("aria-label").catch(() => null));
      if (!id) throw new ClaudeOperationError("response_detection_failed", `Claude assistant article ${index + 1} has no parseable Message ordinal`);
      messages.push({ id, locator: item });
    }
    return messages;
  }
  return [];
}

export async function readClaudeNewAssistantText(page: Page, baseline: TurnBaseline): Promise<string | undefined> {
  const messages = await mountedClaudeAssistantMessages(page);
  const newMessages = messages.filter(message => !baseline.ids.has(message.id));
  if (newMessages.length > 1) throw new AmbiguousNewMessageError(newMessages.length);
  if (newMessages.length === 0) return undefined;
  return (await newMessages[0].locator.locator(claudeSelectors.assistantResponseText).allInnerTexts().catch(() => [])).join("\n");
}
export async function captureClaudeTurnBaseline(page: Page): Promise<TurnBaseline> {
  ensureConnected(page);
  const messages = await mountedClaudeAssistantMessages(page);
  return { count: messages.length, ids: new Set(messages.map(message => message.id)) };
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
  const normalizedPrompt = normalizeLogicalText(prompt);
  let entered = normalizeLogicalText(await readProseMirrorLogicalText(composer));
  if (entered !== normalizedPrompt) {
    await composer.evaluate((element, value) => {
      element.textContent = value as string;
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value as string,
      }));
    }, prompt).catch(() => { throw new ClaudeSubmissionError("Could not enter prompt into Claude composer"); });
    entered = normalizeLogicalText(await readProseMirrorLogicalText(composer));
  }
  if (entered !== normalizedPrompt) throw new ClaudeSubmissionError("Claude composer did not contain the submitted prompt");
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
    const generationActiveVisible = await hasVisible(page, claudeSelectors.stopGenerating);
    const newAssistantResponse = await readClaudeNewAssistantText(page, baseline);
    if (generationActiveVisible || newAssistantResponse !== undefined) return "started";
    await sleep(options.pollIntervalMs ?? POLL_INTERVAL_MS);
  }
  return "not_observed";
}
export async function waitForGenerationComplete(page: Page, baseline: TurnBaseline, timeoutMs: number, options: ClaudeAdapterOptions = {}): Promise<GenerationOutcome> {
  ensureConnected(page);
  const deadline = Date.now() + timeoutMs;
  const timingEnabled = process.env.DUAL_AI_REVIEW_CLAUDE_TIMING === "1";
  const timingStartedAt = Date.now();
  if (timingEnabled) console.log(`[claude completion] start timeoutMs=${timeoutMs}`);
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
  let lastObservedText: string | undefined;
  while (Date.now() < deadline) {
    ensureConnected(page);
    if (await isClaudeSecurityVerificationVisible(page)) {
      return { outcome: "error_banner", detail: "Claude security verification is visible; recover manually" };
    }
    const banner = await firstVisible(page, claudeSelectors.errorBanner);
    if (banner) return { outcome: "error_banner", detail: textValue(await banner.innerText().catch(() => "Claude reported an error")) };
    const generationActiveVisible = await hasVisible(page, claudeSelectors.stopGenerating);
    const candidate = await readClaudeNewAssistantText(page, baseline);
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
    if (timingEnabled) {
      const elapsed = Date.now() - timingStartedAt;
      console.log(`[claude completion] t=${elapsed}ms active=${generationActiveVisible} textLength=${normalizedCandidate.length} stableFor=${textStableForMs}`);
      if (lastObservedText !== undefined && lastObservedText !== normalizedCandidate) console.log(`[claude completion] t=${elapsed}ms text changed`);
      lastObservedText = normalizedCandidate;
    }
    lastDiagnostics = { generationActiveVisible, newResponseFound, textLength: normalizedCandidate.length, textStableForMs, sendVisible };
    await sleep(pollInterval);
  }
  if (timingEnabled) console.log(`[claude completion] timeout at t=${Date.now() - timingStartedAt}ms active=${lastDiagnostics.generationActiveVisible} textLength=${lastDiagnostics.textLength} stableFor=${lastDiagnostics.textStableForMs}`);
  return {
    outcome: "timeout",
    partialText: await readClaudeNewAssistantText(page, baseline) ?? "",
    diagnostics: lastDiagnostics,
  };
}
export async function getLatestAssistantResponse(page: Page, baseline: TurnBaseline): Promise<string> {
  ensureConnected(page);
  let response: string;
  try {
    const detectedResponse = await readClaudeNewAssistantText(page, baseline);
    if (detectedResponse === undefined) throw new AmbiguousNewMessageError(0);
    response = detectedResponse;
  } catch (error) {
    if (error instanceof AmbiguousNewMessageError) throw error;
    throw new ClaudeOperationError("response_detection_failed", error instanceof Error ? error.message : String(error));
  }
  const normalized = textValue(response);
  if (!normalized) throw new ClaudeEmptyResponseError();
  return normalized;
}
export function createClaudeConversationalAdapter(url: string): ConversationalSiteAdapter {
  return { name: "claude", url, checkReady: checkClaudeReady, captureTurnBaseline: captureClaudeTurnBaseline, sendPrompt, waitForGenerationStart, waitForGenerationComplete, getLatestAssistantResponse };
}





