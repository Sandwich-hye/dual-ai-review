import { chromium } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import { checkChatGPTReady } from "../src/sites/chatgptSite";
import { chatgptSelectors } from "../src/sites/selectors/chatgptSelectors";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const messageSelectors = [
  "[data-message-author-role]",
  "[data-testid=\"assistant-message\"]",
  "article[data-testid*='conversation-turn' i]",
];

function normalize(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function run(): Promise<number> {
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const pages = browser.contexts().flatMap(context => context.pages());
  const { chatgpt } = discoverSitePages(pages);
  if (!chatgpt) { console.error("No existing ChatGPT tab was found by hostname."); return 1; }
  const ready = await checkChatGPTReady(chatgpt);
  console.log(`URL: ${chatgpt.url()}`);
  console.log(`Readiness: ${ready}`);
  console.log(`Positive classifiers: user=[data-message-author-role=\"user\"]; assistant=[data-message-author-role=\"assistant\"] or [data-testid=\"assistant-message\"]`);
  console.log(`Production assistant selector group: ${JSON.stringify(chatgptSelectors.assistantMessage)}`);
  const messages = await chatgpt.locator(messageSelectors.join(",")).evaluateAll((nodes, selectors) => {
    const visible = (node: Element): boolean => {
      const element = node as HTMLElement;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    };
    return nodes.filter(visible).map((node, index) => {
      const element = node as HTMLElement;
      const role = element.getAttribute("role");
      const author = element.getAttribute("data-message-author-role");
      const testid = element.getAttribute("data-testid");
      const matchedSelectors = (selectors as string[]).filter(selector => element.matches(selector));
      const isUser = author === "user";
      const isAssistant = author === "assistant" || testid === "assistant-message";
      return {
        order: index + 1,
        role,
        testid,
        author,
        className: element.className,
        isUser,
        isAssistant,
        matchedSelectors,
        duplicateSelectorMatches: matchedSelectors.length > 1,
        text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
      };
    });
  }, messageSelectors);
  console.log(`Visible conversation message containers: ${messages.length}`);
  for (const message of messages) console.log(JSON.stringify(message));
  return 0;
}

run().then(code => { process.exitCode = code; setTimeout(() => process.exit(code), 0); }).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
