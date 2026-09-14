import { Logger } from "../logging/logger";
import { BrowserSession } from "./launchBrowser";

export function installShutdownHandlers(getSession: () => BrowserSession | undefined, logger: Logger): (reason?: string) => Promise<void> {
  let closed = false;
  const close = async (reason = "requested"): Promise<void> => {
    if (closed) return;
    closed = true;
    const session = getSession();
    if (!session) { logger.info("shutdown", `clean shutdown (${reason}); no browser session`); return; }
    if (!session.ownsBrowser) {
      logger.info("shutdown", `clean shutdown (${reason}); attached browser left running`);
      return;
    }
    try { await session.context.close(); logger.info("shutdown", `clean shutdown (${reason})`); }
    catch (error) { logger.error("shutdown", `browser close failed: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const onSignal = (signal: NodeJS.Signals) => { void close(signal).finally(() => process.exit(0)); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return close;
}