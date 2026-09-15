import { chromium, Locator, Page } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import { normalizeLogicalText, readProseMirrorLogicalText } from "../src/browser/domUtil";
import { checkClaudeReady } from "../src/sites/claudeSite";
import { claudeSelectors } from "../src/sites/selectors/claudeSelectors";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const FIRST_MARKER = "You are the reviewer.";
const FINAL_MARKER = "- unnecessary complexity";

type PageState = {
  url: string;
  composerLogicalTextLength: number;
  composerFirstMarker: boolean;
  composerFinalMarker: boolean;
  composerLogicallyEmpty: boolean;
  visibleUserMessageCount: number;
  visibleAssistantMessageCount: number;
  visibleArticleCount: number;
  generationActive: boolean;
};

function isClaudePage(page: Page): boolean {
  try {
    const hostname = new URL(page.url()).hostname.toLowerCase();
    return hostname === "claude.ai" || hostname.endsWith(".claude.ai");
  } catch {
    return false;
  }
}

async function elementShape(locator: Locator): Promise<Record<string, unknown>> {
  return locator.evaluate(node => {
    const shape = (item: Node): unknown => {
      if (item.nodeType === Node.TEXT_NODE) return { textNodeLength: item.textContent?.length ?? 0 };
      if (item.nodeType !== Node.ELEMENT_NODE) return { nodeType: item.nodeType };
      const element = item as Element;
      return {
        tagName: element.tagName.toLowerCase(),
        attributes: Array.from(element.attributes).map(attribute => attribute.name),
        children: Array.from(element.childNodes).map(shape),
      };
    };
    return { tagName: node.tagName.toLowerCase(), type: node.getAttribute("type") ?? "", ariaLabel: node.getAttribute("aria-label") ?? "", dataTestId: node.getAttribute("data-testid") ?? "", disabled: node.getAttribute("disabled") ?? "", ariaDisabled: node.getAttribute("aria-disabled") ?? "", shape: shape(node) };
  });
}

async function state(page: Page, composer: Locator, beforeUserCount: number): Promise<PageState> {
  const logical = normalizeLogicalText(await readProseMirrorLogicalText(composer).catch(() => ""));
  const assistantMessages = page.locator('[role="article"]:has([data-perf-reply-text]):visible');
  const visibleArticles = page.locator('[role="article"]:visible, article:visible');
  const visibleUserMessageCount = await visibleArticles.evaluateAll(nodes => nodes.filter(node => !node.querySelector("[data-perf-reply-text]")).length).catch(() => beforeUserCount);
  return {
    url: page.url(),
    composerLogicalTextLength: logical.length,
    composerFirstMarker: logical.includes(FIRST_MARKER),
    composerFinalMarker: logical.includes(FINAL_MARKER),
    composerLogicallyEmpty: logical === "",
    visibleUserMessageCount,
    visibleAssistantMessageCount: await assistantMessages.count().catch(() => 0),
    visibleArticleCount: await visibleArticles.count().catch(() => 0),
    generationActive: await page.locator('[data-is-streaming="true"]:visible').count().catch(() => 0) > 0
      || await page.locator('button[aria-label*="Stop generating" i]:visible').count().catch(() => 0) > 0,
  };
}

async function run(): Promise<number> {
  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const contexts = browser.contexts();
    const pages = contexts.flatMap(context => context.pages());
    const claudePages = pages.filter(isClaudePage);
    if (claudePages.length !== 1) {
      console.error("DIRECT CLICK ABORTED: expected exactly one Claude page, found " + claudePages.length);
      return 1;
    }
    const { claude } = discoverSitePages(pages);
    if (!claude || claude !== claudePages[0]) {
      console.error("DIRECT CLICK ABORTED: discoverSitePages() did not select the only Claude page.");
      return 1;
    }

    console.log("Claude page confirmed: " + claude.url());
    console.log("Claude readiness: " + await checkClaudeReady(claude));
    let composer: Locator | undefined;
    for (const selector of claudeSelectors.composer) {
      const candidate = claude.locator(selector).first();
      if (await candidate.isVisible().catch(() => false)) {
        composer = candidate;
        break;
      }
    }
    if (!composer) {
      console.error("DIRECT CLICK ABORTED: no visible Claude composer.");
      return 1;
    }

    const composerText = normalizeLogicalText(await readProseMirrorLogicalText(composer));
    if (!composerText.includes(FIRST_MARKER) || !composerText.includes(FINAL_MARKER)) {
      console.error("DIRECT CLICK ABORTED: controlled smoke markers are not both present.");
      return 1;
    }

    const sendMatches = [];
    for (const selector of claudeSelectors.sendButton) {
      const matches = claude.locator(selector);
      const count = await matches.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const button = matches.nth(index);
        sendMatches.push({ selector, button, visible: await button.isVisible().catch(() => false), enabled: await button.isEnabled().catch(() => false) });
      }
    }
    const sendButton = sendMatches.find(item => item.visible && item.enabled)?.button;
    const usedSelector = sendMatches.find(item => item.visible && item.enabled)?.selector ?? "";
    console.log("Send control inspection:");
    console.log(JSON.stringify({ matchedSelector: usedSelector, matchingSendButtonCount: sendMatches.length, candidates: await Promise.all(sendMatches.map(async item => ({ selector: item.selector, visible: item.visible, enabled: item.enabled, shape: await elementShape(item.button) }))) }, null, 2));
    if (!sendButton) {
      console.error("DIRECT CLICK ABORTED: no visible enabled Send button.");
      return 1;
    }

    const before = await state(claude, composer, 0);
    console.log("Before direct click:");
    console.log(JSON.stringify(before, null, 2));
    const originalUrl = before.url;
    console.log("Performing exactly one direct Playwright locator.click().");
    try {
      await sendButton.click();
    } catch (error) {
      console.error("DIRECT_CLICK_ERROR");
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }

    const observations: Record<string, unknown>[] = [];
    const schedule: Array<[string, number]> = [["immediately", 0], ["approximately 250 ms", 250], ["approximately 1 s", 750], ["approximately 3 s", 2000], ["approximately 5 s", 2000]];
    for (const [label, delay] of schedule) {
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      observations.push({ label, state: await state(claude, composer, before.visibleUserMessageCount) });
    }
    console.log("After direct click observations:");
    console.log(JSON.stringify(observations, null, 2));

    const finalState = observations[observations.length - 1].state as PageState;
    const strongEvidence = observations.some(item => {
      const observed = item.state as PageState;
      return observed.composerLogicallyEmpty || observed.url !== originalUrl
        || observed.visibleUserMessageCount > before.visibleUserMessageCount
        || observed.generationActive || observed.visibleAssistantMessageCount > before.visibleAssistantMessageCount;
    });
    console.log(strongEvidence ? "DIRECT_CLICK_SUBMIT_SUCCEEDED" : "DIRECT_CLICK_NO_EFFECT");
    return 0;
  } catch (error) {
    console.error("Claude submit diagnostic failed:");
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

run().then(code => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 0);
});


