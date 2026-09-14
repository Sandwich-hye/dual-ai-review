import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createLogger } from "../../src/logging/logger";
import { openSite } from "../../src/sites/openSite";
import { SiteAdapter } from "../../src/sites/siteTypes";

test("isolates navigation failure from a valid local site", async ({ browser }) => {
  const context = await browser.newContext();
  const logger = createLogger(fs.mkdtempSync(path.join(os.tmpdir(), "dual-ai-open-")));
  const failed: SiteAdapter = { name: "bad", url: "http://127.0.0.1:1/unreachable", checkReady: async () => "ready" };
  const valid: SiteAdapter = { name: "valid", url: "data:text/html,<textarea aria-label='Chat input'></textarea>", checkReady: async (page) => page.locator("textarea").isVisible().then((yes) => yes ? "ready" : "unknown_state") };
  const first = await openSite(await context.newPage(), failed, 1000, logger);
  const second = await openSite(await context.newPage(), valid, 1000, logger);
  expect(first.status).toBe("navigation_failed");
  expect(second.status).toBe("ready");
  expect(first.screenshotPath).toBeTruthy();
  await context.close();
});
