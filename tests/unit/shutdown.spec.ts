import { chromium, Browser, BrowserContext } from "playwright";
import { test, expect } from "@playwright/test";
import { installShutdownHandlers } from "../../src/browser/shutdown";
import { createLogger } from "../../src/logging/logger";

test("closes a launch-owned browser context cleanly and is idempotent", async () => {
  const context = await chromium.launchPersistentContext(".test-browser-profile", { headless: true });
  const logger = createLogger();
  const close = installShutdownHandlers(() => ({ browser: context.browser() as Browser, context, ownsBrowser: true }), logger);
  await close("test");
  await close("test-again");
});

test("does not close an attached user-owned browser context", async () => {
  let closeCalls = 0;
  const context = { close: async () => { closeCalls++; } } as unknown as BrowserContext;
  const logger = createLogger();
  const close = installShutdownHandlers(() => ({ browser: {} as Browser, context, ownsBrowser: false }), logger);
  await close("test");
  expect(closeCalls).toBe(0);
});