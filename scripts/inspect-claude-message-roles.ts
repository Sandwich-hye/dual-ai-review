import { chromium } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import { checkClaudeReady } from "../src/sites/claudeSite";
import { claudeUserMessageSelector } from "../src/sites/claudeUserTurns";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

async function run(): Promise<number> {
  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const pages = browser.contexts().flatMap(context => context.pages());
    const { claude } = discoverSitePages(pages);
    if (!claude) throw new Error("No existing Claude tab was found.");
    const readiness = await checkClaudeReady(claude);
    if (readiness !== "ready") throw new Error("Claude is not ready: " + readiness);
    const data = await claude.locator('[role="article"]:visible').evaluateAll(nodes => nodes.map((node, index) => {
      const element = node as HTMLElement;
      const attrs: Record<string, string> = {};
      for (const attr of Array.from(node.attributes)) if (attr.name.startsWith("data-")) attrs[attr.name] = attr.value;
      const controls = Array.from(node.querySelectorAll("button,[role=button]")).map(item => item.getAttribute("aria-label") || (item.textContent ?? "").trim()).filter(Boolean);
      return {
        index,
        tagName: node.tagName.toLowerCase(),
        ariaLabel: node.getAttribute("aria-label") ?? "",
        className: typeof node.className === "string" ? node.className : "",
        dataTestId: node.getAttribute("data-testid") ?? "",
        dataAttributes: attrs,
        firstText: (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
        containsAssistantText: Boolean(node.querySelector("[data-perf-reply-text]")),
        containsShowMore: Array.from(node.querySelectorAll("button,[role=button]")).some(item => (item.textContent ?? "").trim() === "Show more" || item.getAttribute("aria-label") === "Show more"),
        descendantTestIds: Array.from(node.querySelectorAll("[data-testid]")).map(item => item.getAttribute("data-testid")),
        controls,
        positiveUserEvidence: controls.some(control => /^edit$/i.test(control)),
      };
    }));
    const broad = await claude.locator('[role="article"]:not(:has([data-perf-reply-text])):visible').count();
    const positive = await claude.locator(claudeUserMessageSelector + ":visible").count();
    console.log(JSON.stringify({ url: claude.url(), title: await claude.title(), articles: data, broadNegativeSelector: { selector: '[role="article"]:not(:has([data-perf-reply-text]))', count: broad, indexes: data.filter(item => !item.containsAssistantText).map(item => item.index) }, positiveUserSelector: { selector: claudeUserMessageSelector, count: positive, indexes: data.filter(item => item.positiveUserEvidence).map(item => item.index) }, noActionsPerformed: true }, null, 2));
    return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
}
run().then(code => { process.exitCode = code; });