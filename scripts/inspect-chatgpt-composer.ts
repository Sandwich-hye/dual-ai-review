import { chromium, Locator, Page } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import { checkChatGPTReady } from "../src/sites/chatgptSite";
import { chatgptSelectors } from "../src/sites/selectors/chatgptSelectors";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const CONTROLLED_TEXT = "CHATGPT_MULTILINE_TEST_LINE_1\n\nCHATGPT_MULTILINE_TEST_LINE_2\n---\n- ITEM_A\n- ITEM_B\nCHATGPT_MULTILINE_TEST_END";
const MARKERS = ["Original task:", "Your previous ChatGPT answer:", "Latest Claude review:", "COMPLETE revised"];

function normalize(value: string): string { return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim(); }
function logicalPreview(value: string): string { return normalize(value).slice(0, 100); }
function markerState(value: string): Record<string, boolean> { return Object.fromEntries(MARKERS.map(marker => [marker, value.includes(marker)])); }

async function firstComposer(page: Page): Promise<{ locator: Locator; selector: string } | undefined> {
  for (const selector of chatgptSelectors.composer) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return { locator, selector };
  }
  return undefined;
}

async function readComposer(locator: Locator): Promise<Record<string, unknown>> {
  const inputValue = await locator.inputValue().catch(() => undefined);
  const textContent = await locator.textContent().catch(() => null);
  const innerText = await locator.innerText().catch(() => null);
  const productionReader = normalize(innerText ?? textContent ?? "");
  return {
    inputValueLength: inputValue === undefined ? null : inputValue.length,
    inputValuePreview: inputValue === undefined ? null : logicalPreview(inputValue),
    textContentLength: (textContent ?? "").length,
    textContentPreview: logicalPreview(textContent ?? ""),
    innerTextLength: (innerText ?? "").length,
    innerTextPreview: logicalPreview(innerText ?? ""),
    productionReaderLength: productionReader.length,
    productionReaderPreview: logicalPreview(productionReader),
    productionReaderMarkers: markerState(productionReader),
    normalizedVariants: {
      productionWhitespaceNormalizationLength: productionReader.length,
      newlinePreservingLength: (innerText ?? textContent ?? "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").trim().length,
    },
  };
}

async function structure(locator: Locator): Promise<Record<string, unknown>> {
  return locator.evaluate(node => {
    const describe = (element: Element): Record<string, unknown> => ({ tag: element.tagName.toLowerCase(), childTags: [...element.children].map(child => child.tagName.toLowerCase()), textLength: (element.textContent ?? "").length });
    const directChildren = [...node.children].map(describe);
    const blockTags = [...node.querySelectorAll("p, div, br")].map(element => element.tagName.toLowerCase());
    const innerText = (node as HTMLElement).innerText ?? "";
    const textContent = node.textContent ?? "";
    return {
      tagName: node.tagName.toLowerCase(),
      directChildTags: [...node.children].map(child => child.tagName.toLowerCase()),
      directChildren,
      paragraphDivBrStructure: blockTags,
      hasSeparateDirectBlocks: node.children.length > 0,
      blankLineEvidence: { textContentContainsDoubleNewline: textContent.includes("\n\n"), innerTextContainsDoubleNewline: innerText.includes("\n\n"), emptyDirectChildCount: [...node.children].filter(child => !(child.textContent ?? "").trim()).length },
      textContentLength: textContent.length,
      innerTextLength: innerText.length,
      innerTextExtraNewlines: Math.max(0, innerText.split("\n").length - textContent.split("\n").length),
    };
  });
}

async function inspectComposer(locator: Locator): Promise<Record<string, unknown>> { return { values: await readComposer(locator), structure: await structure(locator) }; }

async function controlledTest(locator: Locator): Promise<void> {
  const events = { input: 0, beforeinput: 0, keydown: 0 };
  await locator.evaluate((node, eventNames) => { for (const name of eventNames) node.addEventListener(name, () => { (window as unknown as { __diagnosticEvents: Record<string, number> }).__diagnosticEvents[name] += 1; }); (window as unknown as { __diagnosticEvents: Record<string, number> }).__diagnosticEvents = {}; }, Object.keys(events));
  await locator.fill(CONTROLLED_TEXT);
  for (const delayMs of [0, 100, 500, 1500]) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs - (delayMs === 100 ? 0 : delayMs === 500 ? 100 : 500)));
    console.log(`\nControlled insertion t=${delayMs}ms:`);
    console.log(JSON.stringify({ state: await inspectComposer(locator), eventCounts: await locator.evaluate(() => (window as unknown as { __diagnosticEvents: Record<string, number> }).__diagnosticEvents) }, null, 2));
  }
  await locator.fill("");
  console.log("\nControlled diagnostic text removed with fill(\"\"); no submission was performed.");
}

async function run(): Promise<number> {
  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT); const pages = browser.contexts().flatMap(context => context.pages()); const { chatgpt } = discoverSitePages(pages); if (!chatgpt) throw new Error("No existing ChatGPT tab was found by hostname.");
    const composer = await firstComposer(chatgpt); if (!composer) throw new Error("No visible ChatGPT composer matched the configured selector group.");
    const allVisibleCount = (await Promise.all(chatgptSelectors.composer.map(selector => chatgpt.locator(selector).count().catch(() => 0)))).reduce((sum, count) => sum + count, 0);
    const initial = await readComposer(composer.locator); const meaningful = (initial.productionReaderLength as number) > 0;
    console.log("ChatGPT composer diagnostic (read-only unless composer is empty)");
    console.log(JSON.stringify({ url: chatgpt.url(), readiness: await checkChatGPTReady(chatgpt), matchedSelector: composer.selector, visibleMatchingComposerCount: allVisibleCount, composerAttributes: await composer.locator.evaluate(node => ({ tagName: node.tagName.toLowerCase(), contenteditable: node.getAttribute("contenteditable"), role: node.getAttribute("role"), dataTestId: node.getAttribute("data-testid"), ariaLabel: node.getAttribute("aria-label"), className: typeof node.className === "string" ? node.className : "" })) }, null, 2));
    console.log("\nCurrent composer inspection:"); console.log(JSON.stringify(await inspectComposer(composer.locator), null, 2));
    console.log("\nProduction verification classification:"); console.log(JSON.stringify({ insertionMethod: "locator.fill(prompt), then locator.pressSequentially(prompt) fallback after fill(\"\")", reader: "locator.innerText() with locator.textContent() fallback", normalization: "replace NBSP and collapse spaces/tabs; trim", verification: "entered.includes(normalizedPrompt)", fallback: "clear with fill(\"\"), pressSequentially(prompt), verify containment again", expectedRevisionMarkers: MARKERS, classification: meaningful ? "AMBIGUOUS: current content is present but may not be the failed G1 prompt" : "composer empty; controlled test permitted" }, null, 2));
    if (!meaningful) await controlledTest(composer.locator); else console.log("\nMeaningful composer content is present; no mutation performed.");
    console.log("\nNo Enter, click, submission, navigation, clipboard use, retry, or tab closure was performed."); return 0;
  } catch (error) { console.error("ChatGPT composer diagnostic failed:"); console.error(error instanceof Error ? error.message : String(error)); return 1; }
}
run().then(code => { process.exitCode = code; setTimeout(() => process.exit(code), 0); });
