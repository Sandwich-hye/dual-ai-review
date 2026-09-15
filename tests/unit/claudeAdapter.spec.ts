import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "@playwright/test";
import { ClaudeEmptyResponseError, captureClaudeTurnBaseline, getLatestAssistantResponse, sendPrompt, waitForGenerationComplete, waitForGenerationStart } from "../../src/sites/claudeSite";
import { AmbiguousNewMessageError, normalizeLogicalText, readProseMirrorLogicalText } from "../../src/browser/domUtil";
import { countVisibleClaudeUserMessages } from "../../src/sites/claudeUserTurns";

const fixture = pathToFileURL(path.resolve("tests/fixtures/fakeClaude.html")).href;

test("uses Claude composer fallback and submits a prompt", async ({ page }) => {
  await page.goto(fixture);
  const baseline = await captureClaudeTurnBaseline(page);
  await sendPrompt(page, "hello Claude");
  expect(await waitForGenerationStart(page, baseline)).toBe("started");
});
test("completed fast Claude response confirms generation start even when active control is missed", async ({ page }) => {
  await page.goto(fixture + "?mode=instant");
  const baseline = await captureClaudeTurnBaseline(page);
  await sendPrompt(page, "fast response");
  expect(await waitForGenerationStart(page, baseline, { pollIntervalMs: 100 })).toBe("started");
  expect((await waitForGenerationComplete(page, baseline, 1000, { stabilityIntervalMs: 80 })).outcome).toBe("complete");
  expect(await getLatestAssistantResponse(page, baseline)).toBe("stable Claude response");
});

test("generation start times out when neither active control nor a new assistant exists", async ({ page }) => {
  await page.goto(fixture + "?mode=no-signal");
  const baseline = await captureClaudeTurnBaseline(page);
  await sendPrompt(page, "no response");
  expect(await waitForGenerationStart(page, baseline, { startTimeoutMs: 150, pollIntervalMs: 25 })).toBe("not_observed");
});
test("captures baseline and excludes the old Claude response", async ({ page }) => {
  await page.goto(fixture);
  const baseline = await captureClaudeTurnBaseline(page);
  await sendPrompt(page, "new turn");
  await waitForGenerationStart(page, baseline);
  await waitForGenerationComplete(page, baseline, 3000, { stabilityIntervalMs: 120 });
  expect(await getLatestAssistantResponse(page, baseline)).toBe("stable Claude response");
});
test("uses stable streaming text rather than finishing early", async ({ page }) => {
  await page.goto(fixture + "?mode=changing");
  const baseline = await captureClaudeTurnBaseline(page);
  await sendPrompt(page, "stream");
  await waitForGenerationStart(page, baseline);
  expect((await waitForGenerationComplete(page, baseline, 3000, { stabilityIntervalMs: 120 })).outcome).toBe("complete");
  expect(await getLatestAssistantResponse(page, baseline)).toBe("stable Claude response");
});
test("hidden stop control does not block completion", async ({ page }) => {
  await page.goto(fixture + "?mode=hidden-stop");
  const baseline = await captureClaudeTurnBaseline(page);
  await sendPrompt(page, "hidden stop");
  await waitForGenerationStart(page, baseline);
  expect((await waitForGenerationComplete(page, baseline, 3000, { stabilityIntervalMs: 120 })).outcome).toBe("complete");
});
test("missing Send button after completion does not block completion", async ({ page }) => {
  await page.goto(fixture + "?mode=no-send");
  const baseline = await captureClaudeTurnBaseline(page);
  await sendPrompt(page, "no send");
  await waitForGenerationStart(page, baseline);
  expect((await waitForGenerationComplete(page, baseline, 3000, { stabilityIntervalMs: 120 })).outcome).toBe("complete");
});
test("visible generation control prevents completion", async ({ page }) => {
  await page.goto(fixture + "?mode=visible-stop");
  const baseline = await captureClaudeTurnBaseline(page);
  await sendPrompt(page, "active");
  await waitForGenerationStart(page, baseline);
  const result = await waitForGenerationComplete(page, baseline, 300, { stabilityIntervalMs: 80 });
  expect(result.outcome).toBe("timeout");
  if (result.outcome === "timeout") {
    expect(result.diagnostics.generationActiveVisible).toBe(true);
    expect(result.diagnostics.newResponseFound).toBe(true);
    expect(result.diagnostics.textLength).toBeGreaterThan(0);
  }
});
test("times out when generation never finishes", async ({ page }) => {
  await page.goto(fixture + "?mode=no-signal");
  const baseline = await captureClaudeTurnBaseline(page);
  await sendPrompt(page, "never");
  await waitForGenerationStart(page, baseline);
  expect((await waitForGenerationComplete(page, baseline, 250)).outcome).toBe("timeout");
});
test("empty response does not complete", async ({ page }) => {
  await page.goto(fixture + "?mode=empty");
  const baseline = await captureClaudeTurnBaseline(page);
  await sendPrompt(page, "empty");
  await waitForGenerationStart(page, baseline);
  const result = await waitForGenerationComplete(page, baseline, 1000);
  expect(result.outcome).toBe("timeout");
  await expect(getLatestAssistantResponse(page, baseline)).rejects.toBeInstanceOf(ClaudeEmptyResponseError);
});
test("unrelated sidebar text is not extracted", async ({ page }) => {
  await page.goto(fixture);
  const baseline = await captureClaudeTurnBaseline(page);
  await sendPrompt(page, "response");
  await waitForGenerationStart(page, baseline);
  await waitForGenerationComplete(page, baseline, 3000);
  expect(await getLatestAssistantResponse(page, baseline)).toBe("stable Claude response");
});
test("login/security states stop safely", async ({ page }) => {
  await page.goto(fixture + "?mode=security");
  expect(await page.locator("[data-testid=security-check]").isVisible()).toBe(true);
  await expect(sendPrompt(page, "do not bypass")).rejects.toMatchObject({ code: "security_verification" });
  await page.setContent("<form><input type='email'><input type='password'></form>");
  await expect(sendPrompt(page, "do not login")).rejects.toMatchObject({ code: "login_required" });
});

test("uses Claude ordinal identity when stable IDs are unavailable", async ({ page }) => {
  await page.setContent("<section id='conversation'><article role='article' aria-label='Message 1 of 2' data-message-id='old' data-is-streaming='false'><div data-perf-reply-text>old</div></article></section><div class='ProseMirror' contenteditable='true' role='textbox'></div>");
  const baseline = await captureClaudeTurnBaseline(page);
  await page.locator("#conversation").evaluate(node => {
    const item = document.createElement("article");
    item.setAttribute("role", "article");
    item.setAttribute("aria-label", "Message 3 of 3");
    item.dataset.messageId = "new";
    item.dataset.isStreaming = "false";
    item.innerHTML = '<div data-perf-reply-text>new Claude response</div>';
    node.appendChild(item);
  });
  expect(await getLatestAssistantResponse(page, baseline)).toBe("new Claude response");
});

test("keeps the new Claude assistant identity across virtualized remounts", async ({ page }) => {
  await page.setContent('<main id="conversation"><article role="article" aria-label="Message 2 of 12"><div data-perf-reply-text>old two</div></article><article role="article" aria-label="Message 10 of 12"><div data-perf-reply-text>old ten</div></article><div class="ProseMirror" contenteditable="true" role="textbox"></div></main><button aria-label="Stop generating" hidden>Stop</button>');
  const baseline = await captureClaudeTurnBaseline(page);
  expect([...baseline.ids]).toEqual(["message:2", "message:10"]);
  await page.locator("#conversation").evaluate(node => { node.insertAdjacentHTML("beforeend", '<article role="article" aria-label="Message 12 of 12"><div data-perf-reply-text>abc</div></article>'); });
  expect(await waitForGenerationStart(page, baseline, { pollIntervalMs: 20 })).toBe("started");
  await page.locator("#conversation").evaluate(node => { node.innerHTML = '<article role="article" aria-label="Message 10 of 12"><div data-perf-reply-text>old ten</div></article><article role="article" aria-label="Message 12 of 12"><div data-perf-reply-text>abcdef</div></article>'; });
  expect(await getLatestAssistantResponse(page, baseline)).toBe("abcdef");
  await page.locator("#conversation").evaluate(node => { node.innerHTML = '<article role="article" aria-label="Message 2 of 14"><div data-perf-reply-text>old two</div></article><article role="article" aria-label="Message 12 of 14"><div data-perf-reply-text>complete</div></article>'; });
  expect((await waitForGenerationComplete(page, baseline, 1000, { pollIntervalMs: 40, stabilityIntervalMs: 80 })).outcome).toBe("complete");
  expect(await getLatestAssistantResponse(page, baseline)).toBe("complete");
});

test("fails safely when a Claude assistant ordinal is unparseable", async ({ page }) => {
  await page.setContent('<main><article role="article" aria-label="not a Message ordinal"><div data-perf-reply-text>response</div></article></main>');
  await expect(captureClaudeTurnBaseline(page)).rejects.toMatchObject({ code: "response_detection_failed" });
});
test("does not guess when Claude appends multiple new responses", async ({ page }) => {
  await page.goto(fixture + "?mode=multi");
  const baseline = await captureClaudeTurnBaseline(page);
  await page.locator(".ProseMirror").fill("ambiguous");
  await page.locator("#claude-send").click();
  await page.waitForTimeout(500);
  await expect(getLatestAssistantResponse(page, baseline)).rejects.toMatchObject({ newMessageCount: 2 });
});

test("reports missing composer and a submission that never starts", async ({ page }) => {
  await page.setContent("<h1>not Claude</h1>");
  await expect(sendPrompt(page, "missing")).rejects.toMatchObject({ code: "composer_missing" });
  await page.goto(fixture + "?mode=reject");
  const baseline = await captureClaudeTurnBaseline(page);
  await expect(sendPrompt(page, "rejected")).rejects.toMatchObject({ code: "submission_failed" });
  expect(await waitForGenerationStart(page, baseline, { startTimeoutMs: 100 })).toBe("not_observed");
});

test("scopes extraction to response text and excludes controls", async ({ page }) => {
  await page.goto(fixture);
  const baseline = await captureClaudeTurnBaseline(page);
  await page.locator("#conversation").evaluate(node => {
    const item = document.createElement("article");
    item.setAttribute("role", "article");
    item.setAttribute("aria-label", "Message 3 of 3");
    item.dataset.messageId = "scoped";
    item.dataset.isStreaming = "false";
    item.innerHTML = '<div data-cds="Prose"><div data-perf-reply-text>Only response text</div></div><button>Copy</button><button>Read aloud</button><button>Retry</button>';
    node.appendChild(item);
  });
  expect(await getLatestAssistantResponse(page, baseline)).toBe("Only response text");
});

test("ignores sidebar titles, chat headers, and user articles", async ({ page }) => {
  await page.goto(fixture);
  const baseline = await captureClaudeTurnBaseline(page);
  expect(baseline.count).toBe(1);
  await page.locator("#conversation").evaluate(node => {
    const item = document.createElement("article");
    item.setAttribute("role", "article");
    item.dataset.messageId = "user-2";
    item.textContent = "User article without response marker";
    node.appendChild(item);
  });
  await expect(getLatestAssistantResponse(page, baseline)).rejects.toBeInstanceOf(AmbiguousNewMessageError);
});




const longReviewPrompt = [
  "You are the reviewer.",
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
  "- unnecessary complexity",
].join("\n");

test("inserts a multiline Claude prompt as one user turn without Enter submissions", async ({ page }) => {
  await page.goto(fixture);
  const baseline = await captureClaudeTurnBaseline(page);
  await sendPrompt(page, longReviewPrompt);

  const fixtureState = await page.evaluate(() => {
    const state = (window as unknown as { __claudeFixture: { submitCount: number; submittedPrompts: string[]; userTurnCount: number } }).__claudeFixture;
    return { submitCount: state.submitCount, submittedPrompts: state.submittedPrompts, userTurnCount: state.userTurnCount, composerText: document.querySelector("#claude-composer")?.textContent ?? "" };
  });
  expect(fixtureState.submitCount).toBe(1);
  expect(fixtureState.userTurnCount).toBe(1);
  expect(fixtureState.submittedPrompts).toEqual([longReviewPrompt]);
  expect(fixtureState.composerText).toBe("");
  expect(await waitForGenerationStart(page, baseline)).toBe("started");
});


test("reconstructs ProseMirror paragraph blocks and intentional blank lines", async ({ page }) => {
  await page.setContent('<div id="editor" class="ProseMirror" contenteditable="true"><p>first paragraph</p><p><br></p><p>second paragraph</p><p>---</p><p>- bullet A</p><p>- bullet B</p></div>');
  const logical = await readProseMirrorLogicalText(page.locator("#editor"));
  expect(logical).toBe("first paragraph\n\nsecond paragraph\n---\n- bullet A\n- bullet B");
});

test("detects genuinely truncated logical composer content", async ({ page }) => {
  await page.setContent('<div id="editor" class="ProseMirror" contenteditable="true"><p>first paragraph</p><p><br></p><p>second paragraph</p></div>');
  const logical = normalizeLogicalText(await readProseMirrorLogicalText(page.locator("#editor")));
  const expected = normalizeLogicalText("first paragraph\n\nsecond paragraph\n---\n- bullet A\n- bullet B");
  expect(logical).not.toBe(expected);
});


test("counts structural Claude user turns without confusing assistant articles", async ({ page }) => {
  await page.setContent('<main><article role="article" aria-label="Message 1 of 2"><p>collapsed long user message</p><button aria-label="Show more">Show more</button><button aria-label="Edit">Edit</button></article><article role="article" aria-label="Message 2 of 2"><div data-perf-reply-text>assistant response</div></article></main>');
  expect(await countVisibleClaudeUserMessages(page)).toBe(1);
  await page.locator("main").evaluate(node => {
    node.insertAdjacentHTML("beforeend", '<article role="article"><p>new user turn</p><button aria-label="Edit">Edit</button></article>');
  });
  expect(await countVisibleClaudeUserMessages(page)).toBe(2);  await page.locator("main").evaluate(node => {
    node.insertAdjacentHTML("beforeend", '<article role="article"><div>assistant generating placeholder</div></article>');
  });
  expect(await countVisibleClaudeUserMessages(page)).toBe(2);
  await page.locator("main article").last().evaluate(node => {
    node.innerHTML = '<div data-perf-reply-text>completed response</div>';
  });
  expect(await countVisibleClaudeUserMessages(page)).toBe(2);
  await page.locator("main").evaluate(node => {
    node.insertAdjacentHTML("beforeend", '<article role="article"><p>unexpected second user turn</p><button aria-label="Edit">Edit</button></article>');
  });
  expect(await countVisibleClaudeUserMessages(page)).toBe(3);
});

