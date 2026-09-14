import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { BrowserSession, launchBrowser } from "./browser/launchBrowser";
import { discoverSitePages } from "./browser/discoverSitePages";
import { installShutdownHandlers } from "./browser/shutdown";
import { loadConfig } from "./config/loadConfig";
import { createLogger } from "./logging/logger";
import { createSiteRegistry } from "./sites/siteRegistry";
import { checkSiteReady, openSite } from "./sites/openSite";
import { SiteLoadResult } from "./sites/siteTypes";

async function main(): Promise<void> {
  const logger = createLogger();
  logger.info("main", "process start");
  let session: BrowserSession | undefined;
  const close = installShutdownHandlers(() => session, logger);
  try {
    const config = loadConfig();
    logger.info("main", "config loaded");
    session = await launchBrowser(config, logger);
    const adapters = createSiteRegistry(config);
    const results: SiteLoadResult[] = [];
    let finalResults = results;

    if (config.browserMode === "attach") {
      const discovered = discoverSitePages(session.context.pages());
      for (const adapter of adapters) {
        const page = adapter.name === "chatgpt" ? discovered.chatgpt : discovered.claude;
        if (!page) {
          const detail = `existing ${adapter.name} tab missing`;
          logger.error(adapter.name, detail);
          results.push({ site: adapter.name, url: adapter.url, status: "navigation_failed", detail });
          continue;
        }
        results.push(await checkSiteReady(page, adapter, logger));
      }
    } else {
      for (const adapter of adapters) {
        const page = await session.context.newPage();
        results.push(await openSite(page, adapter, config.navigationTimeoutMs, logger));
      }
      if (results.some((result) => result.status === "login_required")) {
        const names = results.filter((result) => result.status === "login_required").map((result) => result.site).join(" / ");
        logger.warn("main", `manual login required for: ${names}`);
        const rl = readline.createInterface({ input, output });
        await rl.question(`Please log into ${names} manually in the opened browser window, then press ENTER here to continue...`);
        rl.close();
        logger.info("main", "manual login wait completed; re-checking both sites");
        finalResults = [];
        for (let index = 0; index < adapters.length; index++) {
          const page = session.context.pages()[index];
          const result = await openSite(page, adapters[index], config.navigationTimeoutMs, logger);
          finalResults.push(result);
          logger.info("main", `final result site=${result.site} status=${result.status}`);
        }
      }
    }
    if (!config.headless && finalResults.some((result) => result.status === "unknown_state")) {
      const rl = readline.createInterface({ input, output });
      await rl.question("One or more sites are in unknown_state.\nInspect the browser manually.\nPress ENTER to close and continue.");
      rl.close();
    }
    logger.info("main", "final site detection complete");
  } catch (error) {
    logger.error("main", `run failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    await close("normal exit");
  }
}

main().catch(() => { process.exitCode = 1; });