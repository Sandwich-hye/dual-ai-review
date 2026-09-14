import fs from "node:fs";
import path from "node:path";
import { Page } from "playwright";
import { Logger } from "../logging/logger";
import { SiteAdapter, SiteLoadResult } from "./siteTypes";

export async function openSite(page: Page, adapter: SiteAdapter, timeoutMs: number, logger: Logger): Promise<SiteLoadResult> {
  logger.info(adapter.name, `navigation start url=${adapter.url}`);
  try {
    await page.goto(adapter.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  } catch (error) {
    const result: SiteLoadResult = { site: adapter.name, url: adapter.url, status: "navigation_failed", detail: error instanceof Error ? error.message : String(error) };
    result.screenshotPath = await saveScreenshot(page, adapter.name, logger);
    logger.error(adapter.name, `navigation result=${result.status} detail=${result.detail}`);
    return result;
  }
  return checkSiteReady(page, adapter, logger);
}

export async function checkSiteReady(page: Page, adapter: SiteAdapter, logger: Logger): Promise<SiteLoadResult> {
  const status = await adapter.checkReady(page);
  const result: SiteLoadResult = { site: adapter.name, url: page.url() || adapter.url, status };
  if (status === "unknown_state") result.screenshotPath = await saveScreenshot(page, adapter.name, logger);
  logger.info(adapter.name, `readiness result=${status}${result.screenshotPath ? ` screenshot=${result.screenshotPath}` : ""}`);
  return result;
}

async function saveScreenshot(page: Page, site: string, logger: Logger): Promise<string | undefined> {
  try {
    const screenshotPath = path.join(path.dirname(logger.logFile), `${new Date().toISOString().replace(/[:.]/g, "-")}-${site}.png`);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  } catch (error) {
    logger.warn(site, `screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}