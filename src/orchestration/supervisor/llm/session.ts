import type { Page } from "playwright";
import type { ConversationalSiteAdapter, SiteLoadStatus } from "../../../sites/siteTypes";

/** Supplied by a dedicated automation context; each run obtains one new page. */
export interface LlmPageFactory {
  newPage(): Promise<Page>;
}

export interface LlmSupervisorSession {
  readonly page: Page;
  readonly adapter: ConversationalSiteAdapter;
  checkReady(): Promise<SiteLoadStatus>;
  close(): Promise<void>;
}

class DedicatedLlmSession implements LlmSupervisorSession {
  private closed = false;

  constructor(
    readonly page: Page,
    readonly adapter: ConversationalSiteAdapter,
    private readonly navigationFailed: boolean,
  ) {}

  async checkReady(): Promise<SiteLoadStatus> {
    if (this.closed || this.page.isClosed()) return "unknown_state";
    if (this.navigationFailed) return "navigation_failed";
    try {
      return await this.adapter.checkReady(this.page);
    } catch {
      return "unknown_state";
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.page.isClosed()) await this.page.close();
  }
}

/** Opens one dedicated tab and conversation for the run; never borrows a review tab. */
export async function openDedicatedLlmSession(
  pageFactory: LlmPageFactory,
  adapter: ConversationalSiteAdapter,
  navigationTimeoutMs: number,
): Promise<LlmSupervisorSession> {
  if (!Number.isSafeInteger(navigationTimeoutMs) || navigationTimeoutMs <= 0) {
    throw new RangeError("navigationTimeoutMs must be a positive integer");
  }
  const page = await pageFactory.newPage();
  let navigationFailed = false;
  try {
    await page.goto(adapter.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
  } catch {
    navigationFailed = true;
  }
  return new DedicatedLlmSession(page, adapter, navigationFailed);
}
