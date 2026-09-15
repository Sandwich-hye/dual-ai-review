import { Page } from "playwright";

// Live Claude user turns expose an Edit action; assistant articles expose response actions instead.
// This positive signal avoids counting transient assistant shells before response text exists.
export const claudeUserMessageSelector = '[role="article"]:has(button[aria-label="Edit"], [role="button"][aria-label="Edit"])';

export async function countVisibleClaudeUserMessages(page: Page): Promise<number> {
  return page.locator(claudeUserMessageSelector).evaluateAll(nodes => nodes.filter(node => {
    const element = node as HTMLElement;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && box.width > 0 && box.height > 0;
  }).length).catch(() => 0);
}

export async function userMessageMarkerState(page: Page): Promise<{ firstMarker: boolean; finalMarker: boolean }> {
  return page.locator(claudeUserMessageSelector).last().evaluate(node => {
    const text = node.textContent ?? "";
    return {
      firstMarker: text.includes("You are the reviewer."),
      finalMarker: text.includes("- unnecessary complexity"),
    };
  }).catch(() => ({ firstMarker: false, finalMarker: false }));
}