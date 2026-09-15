import { chromium, Locator, Page } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import { checkChatGPTReady } from "../src/sites/chatgptSite";
import { chatgptSelectors } from "../src/sites/selectors/chatgptSelectors";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const CONTROLLED_TEXT = "CHATGPT_MULTILINE_TEST_LINE_1\n\nCHATGPT_MULTILINE_TEST_LINE_2\n---\n- ITEM_A\n- ITEM_B\nCHATGPT_MULTILINE_TEST_END";

function normalized(value: string): string { return value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").trim(); }
function preview(value: string): string { return normalized(value).replace(/\n/g, "\\n").slice(0, 100); }
function nonWhitespace(value: string): string { return value.replace(/\s/g, ""); }

async function findComposer(page: Page): Promise<{ locator: Locator; selector: string } | undefined> {
  for (const selector of chatgptSelectors.composer) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return { locator, selector };
  }
  return undefined;
}

async function readState(locator: Locator): Promise<Record<string, unknown>> {
  const textContent = await locator.textContent().catch(() => "") ?? "";
  const innerText = await locator.innerText().catch(() => "") ?? "";
  const logicalText = normalized(innerText || textContent);
  return {
    textContentLength: textContent.length,
    textContentPreview: preview(textContent),
    innerTextLength: innerText.length,
    innerTextPreview: preview(innerText),
    logicalTextLength: logicalText.length,
    logicalTextPreview: preview(logicalText),
    completeNonWhitespaceContentPreserved: nonWhitespace(logicalText) === nonWhitespace(CONTROLLED_TEXT),
    blankLinePreserved: logicalText.includes("\n\n"),
    ordinaryLineBoundariesPreserved: logicalText.includes("CHATGPT_MULTILINE_TEST_LINE_1\nCHATGPT_MULTILINE_TEST_LINE_2"),
    bulletLinesPreserved: logicalText.includes("- ITEM_A\n- ITEM_B"),
    firstMarkerPresent: logicalText.includes("CHATGPT_MULTILINE_TEST_LINE_1"),
    finalMarkerPresent: logicalText.includes("CHATGPT_MULTILINE_TEST_END"),
    domStructure: await locator.evaluate(node => ({
      tagName: node.tagName.toLowerCase(),
      directChildTags: [...node.children].map(child => child.tagName.toLowerCase()),
      directChildCount: node.children.length,
      paragraphCount: node.querySelectorAll("p").length,
      divCount: node.querySelectorAll("div").length,
      brCount: node.querySelectorAll("br").length,
      childSummaries: [...node.children].map(child => ({ tag: child.tagName.toLowerCase(), textLength: (child.textContent ?? "").length, childTags: [...child.children].map(nested => nested.tagName.toLowerCase()) })),
    })),
  };
}

async function installEventCounters(locator: Locator): Promise<void> {
  await locator.evaluate(node => {
    const state = { beforeinput: 0, input: 0, keydown: 0 };
    (node as HTMLElement).dataset.diagnosticEventState = JSON.stringify(state);
    for (const name of Object.keys(state)) node.addEventListener(name, () => {
      const current = JSON.parse((node as HTMLElement).dataset.diagnosticEventState ?? "{}") as Record<string, number>;
      current[name] = (current[name] ?? 0) + 1;
      (node as HTMLElement).dataset.diagnosticEventState = JSON.stringify(current);
    });
  });
}

async function resetEventCounters(locator: Locator): Promise<void> {
  await locator.evaluate(node => { (node as HTMLElement).dataset.diagnosticEventState = JSON.stringify({ beforeinput: 0, input: 0, keydown: 0 }); });
}

async function eventCounts(locator: Locator): Promise<Record<string, number>> {
  return locator.evaluate(node => JSON.parse((node as HTMLElement).dataset.diagnosticEventState ?? "{}") as Record<string, number>);
}

async function clearControlledContent(locator: Locator): Promise<void> {
  const state = await readState(locator);
  if (state.completeNonWhitespaceContentPreserved !== true) throw new Error("Diagnostic content was not safely identifiable; refusing to clear composer.");
  await locator.fill("");
}

async function runMethod(page: Page, locator: Locator, method: "fill" | "insertText"): Promise<Record<string, unknown>> {
  await locator.fill("");
  await installEventCounters(locator);
  if (method === "fill") await locator.fill(CONTROLLED_TEXT);
  else { await locator.focus(); await page.keyboard.insertText(CONTROLLED_TEXT); }
  const immediate = await readState(locator);
  const immediateEvents = await eventCounts(locator);
  const samples: Record<string, unknown>[] = [];
  let elapsed = 0;
  for (const target of method === "fill" ? [500] : [100, 500, 1500]) {
    await new Promise(resolve => setTimeout(resolve, target - elapsed));
    elapsed = target;
    samples.push({ delayMs: target, state: await readState(locator), eventCounts: await eventCounts(locator) });
  }
  const finalEvents = await eventCounts(locator);
  const result = { method, immediate, immediateEvents, samples, finalEvents, anyKeydown: finalEvents.keydown > 0, submissionOccurred: false };
  await clearControlledContent(locator);
  return result;
}

async function run(): Promise<number> {
  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const pages = browser.contexts().flatMap(context => context.pages());
    const { chatgpt } = discoverSitePages(pages);
    if (!chatgpt) throw new Error("No existing ChatGPT tab was found by hostname.");
    const composer = await findComposer(chatgpt);
    if (!composer) throw new Error("No visible ChatGPT composer matched the configured selector group.");
    const initial = await readState(composer.locator);
    if (nonWhitespace(String(initial.logicalTextLength ?? 0)) !== "0") {
      console.log("ChatGPT composer is not logically empty; aborting safely without modification.");
      console.log(JSON.stringify({ url: chatgpt.url(), readiness: await checkChatGPTReady(chatgpt), selector: composer.selector, initial }, null, 2));
      return 1;
    }
    await installEventCounters(composer.locator);
    const fillResult = await runMethod(chatgpt, composer.locator, "fill");
    const insertTextResult = await runMethod(chatgpt, composer.locator, "insertText");
    const fillPreserves = (fillResult.immediate as Record<string, unknown>).completeNonWhitespaceContentPreserved === true && (fillResult.immediate as Record<string, unknown>).blankLinePreserved === true && (fillResult.immediate as Record<string, unknown>).ordinaryLineBoundariesPreserved === true && (fillResult.immediate as Record<string, unknown>).bulletLinesPreserved === true;
    const insertPreserves = (insertTextResult.immediate as Record<string, unknown>).completeNonWhitespaceContentPreserved === true && (insertTextResult.immediate as Record<string, unknown>).blankLinePreserved === true && (insertTextResult.immediate as Record<string, unknown>).ordinaryLineBoundariesPreserved === true && (insertTextResult.immediate as Record<string, unknown>).bulletLinesPreserved === true;
    const structurePreserved = (result: Record<string, unknown>): boolean => { const state = result.immediate as Record<string, unknown>; const dom = state.domStructure as Record<string, unknown>; const tags = dom.directChildTags as string[]; return state.completeNonWhitespaceContentPreserved === true && dom.directChildCount === 7 && dom.paragraphCount === 7 && dom.brCount === 1 && tags.every(tag => tag === "p"); };
    const fillStructurePreserved = structurePreserved(fillResult);
    const insertTextStructurePreserved = structurePreserved(insertTextResult);
    const classification = insertTextResult.anyKeydown ? "INSERTTEXT_UNSAFE_OR_FAILED" : fillStructurePreserved && insertTextStructurePreserved && (!fillPreserves || !insertPreserves) ? "STRUCTURE_PRESERVED_INNER_TEXT_DIFFERS" : fillPreserves && insertPreserves ? "BOTH_PRESERVE" : !fillPreserves && insertPreserves ? "FILL_FLATTENS_INSERTTEXT_PRESERVES" : "BOTH_FLATTEN";
    console.log("ChatGPT multiline insertion diagnostic (no submission)");
    console.log(JSON.stringify({ url: chatgpt.url(), readiness: await checkChatGPTReady(chatgpt), matchedSelector: composer.selector, methodA: fillResult, methodB: insertTextResult, classification, recommendation: classification === "FILL_FLATTENS_INSERTTEXT_PRESERVES" ? "Use page.keyboard.insertText(controlledText) atomically for multiline insertion; do not use pressSequentially or Enter simulation." : "Review the observed method results before changing production insertion." }, null, 2));
    console.log("No submission occurred; controlled diagnostic content was cleared after each method.");
    return 0;
  } catch (error) { console.error("ChatGPT multiline insertion diagnostic failed:"); console.error(error instanceof Error ? error.message : String(error)); return 1; }
}
run().then(code => { process.exitCode = code; setTimeout(() => process.exit(code), 0); });
