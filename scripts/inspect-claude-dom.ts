import { chromium } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import { claudeSelectors } from "../src/sites/selectors/claudeSelectors";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const TARGET = "PHASE2_CLAUDE_OK";

type ElementDescription = {
  tagName: string;
  id: string;
  className: string;
  role: string;
  dataTestId: string;
  dataMessageId: string;
  contenteditable: string;
  ariaLabel: string;
  dataAttributes: Record<string, string>;
};

type OccurrenceReport = {
  index: number;
  element: ElementDescription;
  ancestors: ElementDescription[];
  location: {
    insideNav: boolean;
    insideAside: boolean;
    insideMain: boolean;
    insideRoleMain: boolean;
    insideAnchor: boolean;
    insideDataRow: boolean;
    insideDataRowKey: boolean;
    insideDataRowMainButton: boolean;
  };
  excludedSidebarOrNavigation: boolean;
  likelyAssistantScore: number;
  nearbyResponseControls: string[];
};

async function inspectOccurrence(locator: import("playwright").Locator, index: number): Promise<OccurrenceReport> {
  return locator.evaluate((node, occurrenceIndex): OccurrenceReport => {
    const describe = (item: Element): ElementDescription => {
      const dataAttributes: Record<string, string> = {};
      for (const attribute of Array.from(item.attributes)) {
        if (attribute.name.startsWith("data-")) dataAttributes[attribute.name] = attribute.value;
      }
      return {
        tagName: item.tagName.toLowerCase(),
        id: item.id,
        className: typeof item.className === "string" ? item.className : "",
        role: item.getAttribute("role") ?? "",
        dataTestId: item.getAttribute("data-testid") ?? "",
        dataMessageId: item.getAttribute("data-message-id") ?? "",
        contenteditable: item.getAttribute("contenteditable") ?? "",
        ariaLabel: item.getAttribute("aria-label") ?? "",
        dataAttributes,
      };
    };
    const ancestors: Element[] = [];
    let current: Element | null = node.parentElement;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) ancestors.push(current);
    const all = [node, ...ancestors];
    const has = (predicate: (item: Element) => boolean) => all.some(predicate);
    const insideDataRow = has(item => item.hasAttribute("data-row"));
    const insideDataRowKey = has(item => item.hasAttribute("data-row-key"));
    const insideDataRowMainButton = has(item => item.hasAttribute("data-row-main-button"));
    const insideAnchor = has(item => item.tagName.toLowerCase() === "a");
    const insideNav = has(item => item.tagName.toLowerCase() === "nav");
    const insideAside = has(item => item.tagName.toLowerCase() === "aside");
    const insideMain = has(item => item.tagName.toLowerCase() === "main");
    const insideRoleMain = has(item => item.getAttribute("role") === "main");
    const excludedSidebarOrNavigation = insideNav || insideAside || insideAnchor || insideDataRow || insideDataRowKey || insideDataRowMainButton;
    const controlPattern = /copy|thumbs?\s*(up|down)|retry|regenerate|try again|text[- ]to[- ]speech|read aloud|speak|listen/i;
    const nearbyResponseControls = Array.from(new Set(
      all.flatMap(container => Array.from(container.querySelectorAll("button, [role=button]")))
        .filter(button => controlPattern.test(button.getAttribute("aria-label") ?? "") || controlPattern.test(button.textContent ?? ""))
        .map(button => button.getAttribute("aria-label") || (button.textContent ?? "").trim()).filter(Boolean)
    )).slice(0, 12);
    let likelyAssistantScore = 0;
    if (!excludedSidebarOrNavigation) likelyAssistantScore += 4;
    if (insideMain || insideRoleMain) likelyAssistantScore += 3;
    if (nearbyResponseControls.length > 0) likelyAssistantScore += 3;
    if (has(item => item.tagName.toLowerCase() === "article")) likelyAssistantScore += 2;
    if (has(item => item.getAttribute("data-message-author-role") === "assistant")) likelyAssistantScore += 8;
    if (has(item => /assistant|message|response|turn/i.test([item.className as string, item.getAttribute("data-testid") ?? "", item.getAttribute("data-message-id") ?? ""].join(" ")))) likelyAssistantScore += 2;
    if (excludedSidebarOrNavigation) likelyAssistantScore -= 12;
    return { index: occurrenceIndex, element: describe(node), ancestors: ancestors.map(describe), location: { insideNav, insideAside, insideMain, insideRoleMain, insideAnchor, insideDataRow, insideDataRowKey, insideDataRowMainButton }, excludedSidebarOrNavigation, likelyAssistantScore, nearbyResponseControls };
  }, index);
}

async function inspect(): Promise<number> {
  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const pages = browser.contexts().flatMap(context => context.pages());
    const { claude } = discoverSitePages(pages);
    if (!claude) throw new Error("No existing Claude tab was found by hostname.");
    const exactMatches = claude.getByText(TARGET, { exact: true });
    const occurrences: import("playwright").Locator[] = [];
    for (let i = 0; i < await exactMatches.count(); i += 1) {
      const match = exactMatches.nth(i);
      if (await match.isVisible().catch(() => false)) occurrences.push(match);
    }
    if (occurrences.length === 0) throw new Error(`No visible exact-text occurrence of ${TARGET} was found.`);
    const reports: OccurrenceReport[] = [];
    for (let i = 0; i < occurrences.length; i += 1) reports.push(await inspectOccurrence(occurrences[i], i + 1));
    const realResponse = reports.filter(report => !report.excludedSidebarOrNavigation).sort((a, b) => b.likelyAssistantScore - a.likelyAssistantScore)[0] ?? null;
    console.log("Claude tab found");
    console.log(`Found ${reports.length} visible exact-text occurrence(s) of ${TARGET}`);
    for (const report of reports) {
      console.log(`\nOccurrence ${report.index}:`);
      console.log(JSON.stringify(report, null, 2));
      console.log(report.excludedSidebarOrNavigation ? "Classification: EXCLUDED sidebar/navigation occurrence" : "Classification: main-conversation candidate");
    }
    console.log("\nReal assistant-response candidate:");
    console.log(JSON.stringify(realResponse ? { occurrence: realResponse.index, score: realResponse.likelyAssistantScore, reason: "highest-scoring non-sidebar occurrence; main/article/assistant metadata and response controls considered", ancestors: realResponse.ancestors, nearbyResponseControls: realResponse.nearbyResponseControls } : null, null, 2));
    console.log("\nCurrent Claude assistant-message selector matches:");
    for (const selector of claudeSelectors.assistantMessage) {
      const matches = claude.locator(selector);
      const count = await matches.count().catch(() => 0);
      let mainConversationMatchCount = 0;
      let containsRealResponse = false;
      for (let i = 0; i < count; i += 1) {
        const details = await matches.nth(i).evaluate((node, target) => {
          const all: Element[] = [node];
          let current: Element | null = node.parentElement;
          for (let depth = 0; current && depth < 20; depth += 1, current = current.parentElement) all.push(current);
          const sidebar = all.some(item => item.tagName.toLowerCase() === "nav" || item.tagName.toLowerCase() === "aside" || item.tagName.toLowerCase() === "a" || item.hasAttribute("data-row") || item.hasAttribute("data-row-key") || item.hasAttribute("data-row-main-button"));
          return { main: !sidebar, containsTarget: (node.textContent ?? "").includes(target as string) };
        }, TARGET).catch(() => ({ main: false, containsTarget: false }));
        if (details.main) mainConversationMatchCount += 1;
        if (realResponse && details.main && details.containsTarget) containsRealResponse = true;
      }
      console.log(JSON.stringify({ selector, globalMatchCount: count, mainConversationMatchCount, containsRealResponse }));
    }
    console.log("\nDiagnostic complete; no clicks, typing, submission, navigation, or browser close was performed.");
    return 0;
  } catch (error) {
    console.error("Claude DOM inspection failed:");
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

inspect().then(code => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 0);
});

