import { chromium, Locator, Page } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import { readProseMirrorLogicalText, normalizeLogicalText } from "../src/browser/domUtil";
import { checkClaudeReady } from "../src/sites/claudeSite";
import { claudeSelectors } from "../src/sites/selectors/claudeSelectors";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const FIRST_MARKER = "You are the reviewer.";
const FINAL_MARKER = "- unnecessary complexity";
const EXPECTED_LONG_PROMPT = [
  FIRST_MARKER,
  "",
  "Original task:",
  "---",
  "Give exactly three practical benefits of automated software testing.",
  "---",
  "",
  "ChatGPT's proposed answer:",
  "---",
  "1. Faster feedback",
  "2. Fewer regressions",
  "3. Reduced manual effort",
  "---",
  "",
  "Review the proposed answer.",
  "",
  "Identify:",
  "- factual or logical errors",
  "- missing requirements",
  "- implementation risks",
  FINAL_MARKER,
].join("\n");

function visible(page: Page, selector: string): Locator {
  return page.locator(selector).filter({ visible: true } as never);
}

async function visibleMarkerOccurrences(page: Page, marker: string): Promise<Record<string, unknown>[]> {
  return page.locator("body *").evaluateAll((nodes, markerText) => {
    const isVisible = (element: Element): boolean => {
      const style = getComputedStyle(element);
      const box = (element as HTMLElement).getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && box.width > 0 && box.height > 0;
    };
    const describe = (node: Element): Record<string, unknown> => {
      const ancestors: Element[] = [node];
      let current: Element | null = node.parentElement;
      for (let depth = 0; current && depth < 15; depth += 1, current = current.parentElement) ancestors.push(current);
      const inComposer = ancestors.some(item => item.getAttribute("contenteditable") === "true");
      const inAssistant = ancestors.some(item => item.querySelector(":scope > [data-perf-reply-text]") || item.hasAttribute("data-perf-reply-text"));
      const inArticle = ancestors.some(item => item.getAttribute("role") === "article" || item.tagName.toLowerCase() === "article");
      const inNavigation = ancestors.some(item => item.tagName.toLowerCase() === "nav" || item.tagName.toLowerCase() === "aside" || item.tagName.toLowerCase() === "header" || item.hasAttribute("data-row") || item.hasAttribute("data-row-key"));
      let classification = "unrelated text";
      if (inComposer) classification = "composer";
      else if (inAssistant) classification = "assistant message";
      else if (inArticle) classification = "user message";
      else if (inNavigation) classification = "header/sidebar";
      const dataAttributes: Record<string, string> = {};
      for (const attribute of Array.from(node.attributes)) if (attribute.name.startsWith("data-")) dataAttributes[attribute.name] = attribute.value;
      return {
        tagName: node.tagName.toLowerCase(),
        id: node.id,
        class: typeof node.className === "string" ? node.className : "",
        role: node.getAttribute("role") ?? "",
        dataTestId: node.getAttribute("data-testid") ?? "",
        dataAttributes,
        classification,
      };
    };
    return nodes.filter(node => {
      if (!isVisible(node) || !(node.textContent ?? "").includes(markerText as string)) return false;
      return !Array.from(node.children).some(child => (child.textContent ?? "").includes(markerText as string));
    }).map(describe);
  }, marker);
}

async function messageContainers(page: Page): Promise<Record<string, unknown>[]> {
  return page.locator('[role="article"]:visible, article:visible').evaluateAll(nodes => nodes.map(node => {
    const firstMarker = "You are the reviewer.";
    const finalMarker = "- unnecessary complexity";
    const dataAttributes: Record<string, string> = {};
    for (const attribute of Array.from(node.attributes)) if (attribute.name.startsWith("data-")) dataAttributes[attribute.name] = attribute.value;
    const element = node as HTMLElement;
    return {
      tagName: node.tagName.toLowerCase(),
      ariaLabel: node.getAttribute("aria-label") ?? "",
      class: typeof node.className === "string" ? node.className : "",
      role: node.getAttribute("role") ?? "",
      dataAttributes,
      containsAssistantMarker: Boolean(node.querySelector("[data-perf-reply-text]")),
      containsFirstMarker: (node.textContent ?? "").includes(firstMarker),
      containsFinalMarker: (node.textContent ?? "").includes(finalMarker),
      visibleTextLength: element.innerText?.length ?? 0,
      controls: Array.from(node.querySelectorAll("button, [role=button]")).map(button => button.getAttribute("aria-label") || (button.textContent ?? "").trim()).filter(Boolean).slice(0, 10),
    };
  }));
}

async function run(): Promise<number> {
  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const pages = browser.contexts().flatMap(context => context.pages());
    const { claude } = discoverSitePages(pages);
    if (!claude) throw new Error("No existing Claude tab was found by hostname.");
    const readiness = await checkClaudeReady(claude);
    console.log("Claude readiness: " + readiness);

    let composer: Locator | undefined;
    let composerSelector = "";
    for (const selector of claudeSelectors.composer) {
      const candidate = claude.locator(selector).first();
      if (await candidate.isVisible().catch(() => false)) {
        composer = candidate;
        composerSelector = selector;
        break;
      }
    }
    if (!composer) throw new Error("No visible Claude composer matched the current selector fallback group.");

    const logicalText = normalizeLogicalText(await readProseMirrorLogicalText(composer));
    const composerState = {
      selector: composerSelector,
      logicalTextLength: logicalText.length,
      firstMarkerPresent: logicalText.includes(FIRST_MARKER),
      finalMarkerPresent: logicalText.includes(FINAL_MARKER),
      logicallyEmpty: logicalText === "",
    };

    const submitSelectorState = await Promise.all(claudeSelectors.sendButton.map(async selector => {
      const matches = claude.locator(selector);
      const count = await matches.count().catch(() => 0);
      let visibleCount = 0;
      let enabledVisibleCount = 0;
      for (let index = 0; index < count; index += 1) {
        const item = matches.nth(index);
        if (await item.isVisible().catch(() => false)) {
          visibleCount += 1;
          if (await item.isEnabled().catch(() => false)) enabledVisibleCount += 1;
        }
      }
      return { selector, count, visibleCount, enabledVisibleCount };
    }));

    const markerOccurrences = {
      firstMarker: await visibleMarkerOccurrences(claude, FIRST_MARKER),
      finalMarker: await visibleMarkerOccurrences(claude, FINAL_MARKER),
    };
    const containers = await messageContainers(claude);
    const smokeUserProbe = {
      selector: 'getByText(expectedLongPrompt, { exact: true })',
      matchCount: await claude.getByText(EXPECTED_LONG_PROMPT, { exact: true }).count().catch(() => 0),
      note: "The smoke harness has no stable user-message selector; it probes visible submitted text.",
    };

    let classification = "AMBIGUOUS";
    const hasVisibleUserMarkers = [...markerOccurrences.firstMarker, ...markerOccurrences.finalMarker]
      .some(item => item.classification === "user message");
    const composerHasPrompt = composerState.firstMarkerPresent && composerState.finalMarkerPresent;
    if (composerState.logicallyEmpty && hasVisibleUserMarkers) classification = "SUBMIT_SUCCEEDED_SELECTOR_FAILED";
    else if (composerHasPrompt && !hasVisibleUserMarkers) classification = "SUBMIT_FAILED_COMPOSER_STILL_CONTAINS_PROMPT";

    console.log("Claude submission diagnostic");
    console.log(JSON.stringify({
      selectedPage: { url: claude.url(), title: await claude.title().catch(() => ""), visibilityState: await claude.evaluate(() => document.visibilityState).catch(() => "unavailable"), hasFocus: await claude.evaluate(() => document.hasFocus()).catch(() => false) },
      composer: composerState,
      visibleMarkerOccurrences: markerOccurrences,
      visibleMessageContainers: containers,
      currentSubmitControls: submitSelectorState,
      smokeSubmittedUserProbe: smokeUserProbe,
      classification,
      submitBeforeAfterState: "Not available from existing logs; current DOM state reported without another submission.",
      noActionsPerformed: true,
    }, null, 2));
    return 0;
  } catch (error) {
    console.error("Claude submission diagnostic failed:");
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

run().then(code => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 0);
});




