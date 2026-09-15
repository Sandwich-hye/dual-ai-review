import { Locator, Page } from "playwright";
import { TurnBaseline } from "../sites/siteTypes";

export async function firstVisible(page: Page, selectors: readonly string[]): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return undefined;
}
export async function firstVisibleEnabled(page: Page, selectors: readonly string[]): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => false)) return locator;
  }
  return undefined;
}
export async function hasVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  return (await firstVisible(page, selectors)) !== undefined;
}
export async function countForSelectorGroup(page: Page, selectors: readonly string[]): Promise<number> {
  for (const selector of selectors) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) return count;
  }
  return 0;
}
function normalize(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
async function messageNodes(page: Page, selectors: readonly string[], textSelector?: string): Promise<{ id: string; text: string }[]> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;
    const messages: { id: string; text: string }[] = [];
    for (let index = 0; index < count; index += 1) {
      const node = locator.nth(index);
      const stableId = await node.getAttribute("data-message-id").catch(() => null)
        ?? await node.getAttribute("data-testid").catch(() => null)
        ?? await node.getAttribute("id").catch(() => null);
      const text = normalize(textSelector
        ? (await node.locator(textSelector).allInnerTexts().catch(() => [] as string[])).join("\n")
        : ((await node.innerText().catch(() => node.textContent().catch(() => "") ?? "")) ?? ""));
      messages.push({ id: stableId ? "stable:" + stableId : "index:" + index, text });
    }
    return messages;
  }
  return [];
}
export async function captureTurnBaseline(page: Page, selectors: readonly string[]): Promise<TurnBaseline> {
  const messages = await messageNodes(page, selectors);
  return { count: messages.length, ids: new Set(messages.map(message => message.id)) };
}
export class AmbiguousNewMessageError extends Error {
  constructor(public readonly newMessageCount: number) {
    super("Expected exactly one new assistant message, found " + newMessageCount);
    this.name = "AmbiguousNewMessageError";
  }
}
export async function resolveNewAssistantMessage(page: Page, selectors: readonly string[], baseline: TurnBaseline, textSelector?: string): Promise<string> {
  const messages = await messageNodes(page, selectors, textSelector);
  const newMessages = messages.filter(message => !baseline.ids.has(message.id));
  if (newMessages.length !== 1) throw new AmbiguousNewMessageError(newMessages.length);
  return newMessages[0].text;
}
export async function readNewAssistantText(page: Page, selectors: readonly string[], baseline: TurnBaseline, textSelector?: string): Promise<string | undefined> {
  const messages = await messageNodes(page, selectors, textSelector);
  const newMessages = messages.filter(message => !baseline.ids.has(message.id));
  return newMessages.length === 1 ? newMessages[0].text : undefined;
}
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

