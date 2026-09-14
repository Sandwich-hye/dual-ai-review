import { Page } from "playwright";
import { SiteAdapter, SiteLoadStatus } from "./siteTypes";

export function createChatGPTSite(url: string): SiteAdapter {
  return { name: "chatgpt", url, checkReady: checkChatGPTReady };
}

export async function checkChatGPTReady(page: Page): Promise<SiteLoadStatus> {
  if (await page.locator('input[type="password"], form:has(input[type="email"])').first().isVisible().catch(() => false)) return "login_required";
  if (await page.getByRole("textbox").first().isVisible().catch(() => false)) return "ready";
  return "unknown_state";
}
