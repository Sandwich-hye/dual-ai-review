import { chromium, Browser, BrowserContext } from "playwright";
import { AppConfig } from "../config/loadConfig";
import { Logger } from "../logging/logger";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  ownsBrowser: boolean;
}

export async function launchBrowser(config: AppConfig, logger: Logger): Promise<BrowserSession> {
  if (config.browserMode === "attach") {
    logger.info("browser", `attach start endpoint=${config.cdpEndpoint}`);
    try {
      const browser = await chromium.connectOverCDP(config.cdpEndpoint);
      const context = browser.contexts()[0];
      if (!context) throw new Error("attached Chrome has no browser context");
      logger.info("browser", `attach success pages=${context.pages().length}`);
      return { browser, context, ownsBrowser: false };
    } catch (error) {
      logger.error("browser", `attach failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  logger.info("browser", `launch start profile=${config.browserProfileDir} channel=${config.browserChannel} headless=${config.headless}`);
  try {
    const context = await chromium.launchPersistentContext(config.browserProfileDir, {
      headless: config.headless,
      channel: config.browserChannel,
      timeout: config.navigationTimeoutMs,
      viewport: { width: 1440, height: 1000 }
    });
    const browser = context.browser();
    if (!browser) throw new Error("launched browser did not expose a browser handle");
    logger.info("browser", "launch success");
    return { browser, context, ownsBrowser: true };
  } catch (error) {
    logger.error("browser", `launch failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}