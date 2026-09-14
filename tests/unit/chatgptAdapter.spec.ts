import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "@playwright/test";
import { captureChatGPTTurnBaseline, getLatestAssistantResponse, sendPrompt, waitForGenerationComplete, waitForGenerationStart } from "../../src/sites/chatgptSite";

const fixture = pathToFileURL(path.resolve("tests/fixtures/fakeChat.html")).href;

test("uses composer fallback and submits a prompt", async ({ page }) => {
  await page.goto(fixture);
  const baseline = await captureChatGPTTurnBaseline(page);
  await sendPrompt(page, "hello ChatGPT");
  expect(await waitForGenerationStart(page, baseline)).toBe("started");
});
test("waits for changing streamed text to become stable", async ({ page }) => {
  await page.goto(fixture + "?mode=changing");
  const baseline = await captureChatGPTTurnBaseline(page);
  await sendPrompt(page, "stream this");
  expect(await waitForGenerationStart(page, baseline)).toBe("started");
  expect(await waitForGenerationComplete(page, baseline, 3000, { stabilityIntervalMs: 120 })).toEqual({ outcome: "complete" });
  expect(await getLatestAssistantResponse(page, baseline)).toBe("stable final response");
});
test("times out when generation never finishes", async ({ page }) => {
  await page.goto(fixture + "?mode=never");
  const baseline = await captureChatGPTTurnBaseline(page);
  await sendPrompt(page, "never finish");
  expect(await waitForGenerationStart(page, baseline)).toBe("started");
  expect((await waitForGenerationComplete(page, baseline, 250)).outcome).toBe("timeout");
});
test("rejects an empty final response", async ({ page }) => {
  await page.goto(fixture + "?mode=empty");
  const baseline = await captureChatGPTTurnBaseline(page);
  await sendPrompt(page, "empty");
  await waitForGenerationStart(page, baseline);
  const result = await waitForGenerationComplete(page, baseline, 3000);
  expect(result.outcome).toBe("timeout");
  if (result.outcome === "timeout") expect(result.diagnostics.textLength).toBe(0);
});
test("reports a missing composer explicitly", async ({ page }) => {
  await page.setContent("<h1>not a chat</h1>");
  await expect(sendPrompt(page, "hello")).rejects.toMatchObject({ code: "composer_missing" });
});
test("reports a generation that never starts", async ({ page }) => {
  await page.goto(fixture + "?mode=reject");
  const baseline = await captureChatGPTTurnBaseline(page);
  await expect(sendPrompt(page, "rejected")).rejects.toMatchObject({ code: "submission_failed" });
  expect(await waitForGenerationStart(page, baseline, { startTimeoutMs: 100 })).toBe("not_observed");
});
test("does not use unrelated DOM text as the response", async ({ page }) => {
  await page.goto(fixture);
  const baseline = await captureChatGPTTurnBaseline(page);
  await sendPrompt(page, "real response");
  await waitForGenerationStart(page, baseline);
  await waitForGenerationComplete(page, baseline, 3000);
  const response = await getLatestAssistantResponse(page, baseline);
  expect(response).toBe("stable final response");
  expect(response).not.toContain("not an assistant response");
});

test("hidden stop control does not block a stable completed response", async ({ page }) => {
  await page.goto(fixture + "?mode=hidden-stop");
  const baseline = await captureChatGPTTurnBaseline(page);
  await sendPrompt(page, "hidden stop");
  await waitForGenerationStart(page, baseline);
  const result = await waitForGenerationComplete(page, baseline, 3000, { stabilityIntervalMs: 120 });
  expect(result).toEqual({ outcome: "complete" });
});

test("completion succeeds when the Send button is absent", async ({ page }) => {
  await page.goto(fixture + "?mode=no-send");
  const baseline = await captureChatGPTTurnBaseline(page);
  await sendPrompt(page, "no send after completion");
  await waitForGenerationStart(page, baseline);
  const result = await waitForGenerationComplete(page, baseline, 3000, { stabilityIntervalMs: 120 });
  expect(result).toEqual({ outcome: "complete" });
  expect(await getLatestAssistantResponse(page, baseline)).toBe("stable final response");
});

test("a visible generation control prevents completion even with stable text", async ({ page }) => {
  await page.goto(fixture + "?mode=visible-stop");
  const baseline = await captureChatGPTTurnBaseline(page);
  await sendPrompt(page, "stay active");
  await waitForGenerationStart(page, baseline);
  const result = await waitForGenerationComplete(page, baseline, 300, { stabilityIntervalMs: 80 });
  expect(result.outcome).toBe("timeout");
  if (result.outcome === "timeout") {
    expect(result.diagnostics.generationActiveVisible).toBe(true);
    expect(result.diagnostics.newResponseFound).toBe(true);
    expect(result.diagnostics.textLength).toBeGreaterThan(0);
    expect(result.diagnostics.sendVisible).toBe(true);
  }
});
