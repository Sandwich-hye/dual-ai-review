import { chromium, Locator } from "playwright";
import { discoverSitePages } from "../src/browser/discoverSitePages";
import { firstVisible } from "../src/browser/domUtil";
import { checkClaudeReady } from "../src/sites/claudeSite";
import { claudeSelectors } from "../src/sites/selectors/claudeSelectors";

const CDP_ENDPOINT = "http://127.0.0.1:9222";
const TEST_TEXT = [
  "CLAUDE_MULTILINE_TEST_LINE_1",
  "",
  "CLAUDE_MULTILINE_TEST_LINE_2",
  "---",
  "- ITEM_A",
  "- ITEM_B",
  "CLAUDE_MULTILINE_TEST_END",
].join("\n");

type EventCounts = { beforeinput: number; input: number; keydown: number };

function normalize(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function composerDescription(composer: Locator): Promise<Record<string, unknown>> {
  return composer.evaluate(node => ({
    tagName: node.tagName.toLowerCase(),
    contenteditable: node.getAttribute("contenteditable") ?? "",
    role: node.getAttribute("role") ?? "",
    class: typeof node.className === "string" ? node.className : "",
    dataTestId: node.getAttribute("data-testid") ?? "",
    ariaLabel: node.getAttribute("aria-label") ?? "",
  }));
}

async function composerSnapshot(composer: Locator): Promise<Record<string, unknown>> {
  return composer.evaluate(node => {
    const normalizeValue = (value: string): string => value
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const textContent = node.textContent ?? "";
    const innerText = (node as HTMLElement).innerText ?? "";
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
    return {
      textContent,
      innerText,
      textContentLength: textContent.length,
      innerTextLength: innerText.length,
      normalizedTextContent: normalizeValue(textContent),
      normalizedInnerText: normalizeValue(innerText),
      innerHTMLShape: shape(node),
      firstMarkerExists: textContent.includes("CLAUDE_MULTILINE_TEST_LINE_1") || innerText.includes("CLAUDE_MULTILINE_TEST_LINE_1"),
      finalMarkerExists: textContent.includes("CLAUDE_MULTILINE_TEST_END") || innerText.includes("CLAUDE_MULTILINE_TEST_END"),
    };
  });
}

async function eventCounts(composer: Locator): Promise<EventCounts> {
  return composer.evaluate(node => (node as HTMLElement & { __claudeDiagnosticEvents?: EventCounts }).__claudeDiagnosticEvents ?? {
    beforeinput: 0,
    input: 0,
    keydown: 0,
  });
}

async function run(): Promise<number> {
  let composer: Locator | undefined;
  let originalEmpty = false;
  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const pages = browser.contexts().flatMap(context => context.pages());
    const { claude } = discoverSitePages(pages);
    if (!claude) throw new Error("No existing Claude tab was found by hostname.");
    console.log("Claude tab found");

    const readiness = await checkClaudeReady(claude);
    if (readiness !== "ready") throw new Error("Claude is not ready: " + readiness);
    console.log("Claude readiness: ready");

    let matchedSelector = "";
    for (const selector of claudeSelectors.composer) {
      const candidate = claude.locator(selector).first();
      if (await candidate.isVisible().catch(() => false)) {
        composer = candidate;
        matchedSelector = selector;
        break;
      }
    }
    if (!composer) throw new Error("No visible Claude composer matched the current selector fallback group.");

    console.log("Composer structure:");
    console.log(JSON.stringify({ selector: matchedSelector, ...(await composerDescription(composer)), visibleProseMirrorCount: await claude.locator(".ProseMirror:visible").count(), visibleContenteditableCount: await claude.locator('[contenteditable="true"]:visible').count() }, null, 2));

    const before = await composerSnapshot(composer);
    originalEmpty = before.normalizedTextContent === "" && before.normalizedInnerText === "";
    console.log("Before insertion:");
    console.log(JSON.stringify(before, null, 2));
    if (!originalEmpty) {
      console.log("Composer is not empty; clear it manually before rerunning this diagnostic. No changes were made.");
      return 1;
    }

    await composer.evaluate(node => {
      const target = node as HTMLElement & { __claudeDiagnosticEvents?: EventCounts };
      target.__claudeDiagnosticEvents = { beforeinput: 0, input: 0, keydown: 0 };
      for (const type of ["beforeinput", "input", "keydown"] as const) {
        node.addEventListener(type, () => {
          if (target.__claudeDiagnosticEvents) target.__claudeDiagnosticEvents[type] += 1;
        });
      }
    });

    console.log("Testing current primary insertion method: locator.fill(multiline text)");
    let fillError = "";
    try {
      await composer.fill(TEST_TEXT);
    } catch (error) {
      fillError = error instanceof Error ? error.message : String(error);
    }

    const report = async (label: string) => {
      const snapshot = await composerSnapshot(composer as Locator);
      const normalizedExpected = normalize(TEST_TEXT);
      console.log(label + ":");
      console.log(JSON.stringify({
        ...snapshot,
        normalizedExpected,
        exactNormalizedTextContentMatch: snapshot.normalizedTextContent === normalizedExpected,
        exactNormalizedInnerTextMatch: snapshot.normalizedInnerText === normalizedExpected,
        eventCounts: await eventCounts(composer as Locator),
        fillError,
      }, null, 2));
    };

    await report("Immediately after insertion");
    await new Promise(resolve => setTimeout(resolve, 100));
    await report("After approximately 100 ms");
    await new Promise(resolve => setTimeout(resolve, 400));
    await report("After approximately 500 ms");
    await new Promise(resolve => setTimeout(resolve, 1000));
    await report("After approximately 1500 ms");

    const sameNode = await composer.evaluate(node => node.isConnected && node === document.querySelector('[contenteditable="true"]'));
    console.log("Composer stability:");
    console.log(JSON.stringify({ matchedComposerRemainedSameDomNode: sameNode, visibleProseMirrorCount: await claude.locator(".ProseMirror:visible").count(), visibleContenteditableCount: await claude.locator('[contenteditable="true"]:visible').count(), eventCounts: await eventCounts(composer) }, null, 2));
    console.log("No submit action was performed.");

    await composer.fill("");
    console.log("Controlled diagnostic text cleared; no message was submitted.");
    return 0;
  } catch (error) {
    console.error("Claude composer inspection failed:");
    console.error(error instanceof Error ? error.message : String(error));
    if (composer && originalEmpty) {
      await composer.fill("").catch(() => undefined);
      console.error("Attempted to clear only the controlled diagnostic value.");
    }
    return 1;
  }
}

run().then(code => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 0);
});



