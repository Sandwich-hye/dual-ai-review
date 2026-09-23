import type { Locator, Page } from "playwright";
import { normalizeLogicalText, readProseMirrorLogicalText } from "../../../browser/domUtil";
import { chatgptSelectors } from "../../../sites/selectors/chatgptSelectors";
import { claudeSelectors } from "../../../sites/selectors/claudeSelectors";
import type { TurnBaseline } from "../../../sites/siteTypes";
import type { LlmSupervisorSession } from "./session";

export type LlmRecoveryHealth =
  | { healthy: true }
  | { healthy: false; detail: string };

const unhealthy = (detail: string): LlmRecoveryHealth => ({ healthy: false, detail });

async function anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    const matches = page.locator(selector);
    const count = await matches.count();
    for (let index = 0; index < count; index += 1) {
      if (await matches.nth(index).isVisible()) return true;
    }
  }
  return false;
}

async function visibleComposer(page: Page, selectors: readonly string[]): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const matches = page.locator(selector);
    const count = await matches.count();
    for (let index = 0; index < count; index += 1) {
      const locator = matches.nth(index);
      if (await locator.isVisible()) return locator;
    }
  }
  return undefined;
}

async function composerIsEmpty(composer: Locator): Promise<boolean> {
  const tag = await composer.evaluate((element) => element.tagName.toLowerCase());
  const text = tag === "textarea" || tag === "input"
    ? await composer.inputValue()
    : await readProseMirrorLogicalText(composer);
  return normalizeLogicalText(text) === "";
}

async function latestAssistant(page: Page, selectors: readonly string[]): Promise<{ count: number; text: string }> {
  for (const selector of selectors) {
    const messages = page.locator(selector);
    const count = await messages.count();
    if (count > 0) return { count, text: normalizeLogicalText(await messages.last().innerText()) };
  }
  return { count: 0, text: "" };
}

function sameBaseline(left: TurnBaseline, right: TurnBaseline): boolean {
  return left.count === right.count && left.ids.size === right.ids.size &&
    [...left.ids].every((id) => right.ids.has(id));
}

/** Read-only, bounded observation after a failed browser turn; ambiguity quarantines. */
export async function probeLlmSessionIdle(
  session: LlmSupervisorSession,
  observationMs = 700,
): Promise<LlmRecoveryHealth> {
  if (!Number.isSafeInteger(observationMs) || observationMs < 1 || observationMs > 5_000) {
    return unhealthy("invalid recovery observation window");
  }
  try {
    const selectors = session.adapter.name === "chatgpt" ? chatgptSelectors
      : session.adapter.name === "claude" ? claudeSelectors : undefined;
    if (!selectors) return unhealthy("unsupported recovery site");
    const security = session.adapter.name === "claude" ? claudeSelectors.securityVerification : [];
    const page = session.page;
    if (page.isClosed()) return unhealthy("page closed");
    const trustedOrigin = (): boolean => {
      const host = new URL(page.url()).hostname.toLowerCase();
      return session.adapter.name === "claude"
        ? host === "claude.ai" || host.endsWith(".claude.ai")
        : host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com";
    };
    if (!trustedOrigin()) return unhealthy("unexpected page origin");

    const inspect = async (): Promise<{ baseline: TurnBaseline; assistant: { count: number; text: string } } | LlmRecoveryHealth> => {
      if (page.isClosed()) return unhealthy("page closed");
      if (!trustedOrigin()) return unhealthy("unexpected page origin");
      if (await anyVisible(page, ['input[type="password"]', 'form:has(input[type="email"])', ...security])) {
        return unhealthy("login or security challenge visible");
      }
      if (await anyVisible(page, selectors.stopGenerating)) return unhealthy("generation still active");
      const composer = await visibleComposer(page, selectors.composer);
      if (!composer) return unhealthy("composer not visible");
      if (!await composerIsEmpty(composer)) return unhealthy("composer contains text");
      return {
        baseline: await session.adapter.captureTurnBaseline(page),
        assistant: await latestAssistant(page, selectors.assistantMessage),
      };
    };

    const first = await inspect();
    if ("healthy" in first) return first;
    await new Promise<void>((resolve) => { setTimeout(resolve, observationMs); });
    const second = await inspect();
    if ("healthy" in second) return second;
    if (first.baseline.ids.size !== first.baseline.count ||
        second.baseline.ids.size !== second.baseline.count ||
        first.assistant.count !== first.baseline.count ||
        second.assistant.count !== second.baseline.count ||
        !sameBaseline(first.baseline, second.baseline) || first.assistant.text !== second.assistant.text) {
      return unhealthy("assistant turn not stable");
    }
    return { healthy: true };
  } catch {
    return unhealthy("recovery could not be verified");
  }
}
