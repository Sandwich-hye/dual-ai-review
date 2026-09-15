import { chromium, Page } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import { claudeSelectors } from "../src/sites/selectors/claudeSelectors";

const CDP_ENDPOINT = "http://127.0.0.1:9222";

function isClaudePage(page: Page): boolean {
  try {
    const hostname = new URL(page.url()).hostname.toLowerCase();
    return hostname === "claude.ai" || hostname.endsWith(".claude.ai");
  } catch {
    return false;
  }
}

function normalizePreview(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n+/g, " ").trim().slice(0, 80);
}

async function pageSummary(page: Page, pageIndex: number, contextIndex: number, contextPageIndex: number): Promise<Record<string, unknown>> {
  const selectorCounts = await Promise.all(claudeSelectors.composer.map(async selector => ({
    selector,
    count: await page.locator(selector).count().catch(() => 0),
  })));
  const candidates = await page.locator('[contenteditable="true"]:visible').evaluateAll(nodes => nodes.map(node => {
    const element = node as HTMLElement;
    const style = getComputedStyle(element);
    const textContent = node.textContent ?? "";
    const innerText = element.innerText ?? "";
    return {
      dataTestId: node.getAttribute("data-testid") ?? "",
      ariaLabel: node.getAttribute("aria-label") ?? "",
      role: node.getAttribute("role") ?? "",
      class: typeof node.className === "string" ? node.className : "",
      boundingBox: (() => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      })(),
      computedDisplay: style.display,
      computedVisibility: style.visibility,
      opacity: style.opacity,
      textContentLength: textContent.length,
      innerTextLength: innerText.length,
      first80NormalizedCharacters: textContent ? textContent.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n+/g, " ").trim().slice(0, 80) : "",
    };
  }));
  return {
    pageIndex,
    contextIndex,
    contextPageIndex,
    url: page.url(),
    title: await page.title().catch(() => ""),
    visibilityState: await page.evaluate(() => document.visibilityState).catch(() => "unavailable"),
    hasFocus: await page.evaluate(() => document.hasFocus()).catch(() => false),
    closed: page.isClosed(),
    visibleProseMirrorCount: await page.locator(".ProseMirror:visible").count().catch(() => 0),
    visibleContenteditableCount: await page.locator('[contenteditable="true"]:visible').count().catch(() => 0),
    currentComposerSelectorMatchCount: selectorCounts.reduce((total, item) => total + item.count, 0),
    currentComposerSelectorMatches: selectorCounts,
    visibleComposerCandidates: candidates,
  };
}

async function run(): Promise<number> {
  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const contexts = browser.contexts();
    const allPages: Page[] = [];
    const pageLocations = new Map<Page, { contextIndex: number; contextPageIndex: number }>();
    contexts.forEach((context, contextIndex) => {
      context.pages().forEach((page, contextPageIndex) => {
        allPages.push(page);
        pageLocations.set(page, { contextIndex, contextPageIndex });
      });
    });
    const claudePages = allPages.filter(isClaudePage);
    console.log("Claude page enumeration");
    console.log("Total connected contexts: " + contexts.length);
    console.log("Total connected pages: " + allPages.length);
    console.log("Total Claude pages found: " + claudePages.length);

    for (let index = 0; index < claudePages.length; index += 1) {
      const page = claudePages[index];
      const location = pageLocations.get(page)!;
      console.log("\nClaude page " + index + ":");
      console.log(JSON.stringify(await pageSummary(page, index, location.contextIndex, location.contextPageIndex), null, 2));
    }

    const discovered = discoverSitePages(allPages);
    const selected = discovered.claude;
    console.log("\ndiscoverSitePages() selection:");
    if (!selected) {
      console.log("No Claude page selected.");
      return 1;
    }
    const selectedLocation = pageLocations.get(selected);
    console.log(JSON.stringify({
      selectedPageIndex: claudePages.indexOf(selected),
      contextIndex: selectedLocation?.contextIndex ?? null,
      contextPageIndex: selectedLocation?.contextPageIndex ?? null,
      selectedUrl: selected.url(),
      selectedTitle: await selected.title().catch(() => ""),
      selectedVisibilityState: await selected.evaluate(() => document.visibilityState).catch(() => "unavailable"),
      selectedHasFocus: await selected.evaluate(() => document.hasFocus()).catch(() => false),
      selectedComposerTextLength: await selected.locator('[contenteditable="true"]:visible').first().evaluate(node => (node.textContent ?? "").length).catch(() => 0),
      selectedPageIsClosed: selected.isClosed(),
    }, null, 2));
    console.log("\nNo clicks, typing, submission, navigation, or tab closure was performed.");
    return 0;
  } catch (error) {
    console.error("Claude page inspection failed:");
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

run().then(code => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 0);
});

