import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "@playwright/test";
import { ClaudeEmptyResponseError, captureClaudeTurnBaseline, getLatestAssistantResponse, sendPrompt, waitForGenerationComplete, waitForGenerationStart } from "../../src/sites/claudeSite";
import { AmbiguousNewMessageError } from "../../src/browser/domUtil";

const fixture = pathToFileURL(path.resolve("tests/fixtures/fakeClaude.html")).href;

test("uses Claude composer fallback and submits a prompt", async ({ page }) => {
  await page.goto(fixture);
  const baseline = await captureClaudeTurnBaseline(page);
  await sendPrompt(page, "hello Claude");
  expect(await waitForGenerationStart(page, baseline)).toBe("started");
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
  await page.goto(fixture + "?mode=never");
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

test("uses Claude index fallback when stable IDs are unavailable", async ({ page }) => {
  await page.setContent("<section id='conversation'><article role='article' data-message-id='old' data-is-streaming='false'><div data-perf-reply-text>old</div></article></section><div class='ProseMirror' contenteditable='true' role='textbox'></div>");
  const baseline = await captureClaudeTurnBaseline(page);
  await page.locator("#conversation").evaluate(node => {
    const item = document.createElement("article");
    item.setAttribute("role", "article");
    item.dataset.messageId = "new";
    item.dataset.isStreaming = "false";
    item.innerHTML = '<div data-perf-reply-text>new Claude response</div>';
    node.appendChild(item);
  });
  expect(await getLatestAssistantResponse(page, baseline)).toBe("new Claude response");
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



