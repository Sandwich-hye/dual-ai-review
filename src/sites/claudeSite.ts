import { Page } from "playwright";
import { SiteAdapter, SiteLoadStatus } from "./siteTypes";

export function createClaudeSite(url: string): SiteAdapter {
  return { name: "claude", url, checkReady: checkClaudeReady };
}

export async function checkClaudeReady(page: Page): Promise<SiteLoadStatus> {
  if (await page.locator('input[type="password"], form:has(input[type="email"])').first().isVisible().catch(() => false)) return "login_required";
  if (await page.getByRole("textbox").first().isVisible().catch(() => false)) return "ready";
  return "unknown_state";
}
