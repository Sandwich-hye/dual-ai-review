import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "@playwright/test";
import { captureTurnBaseline, resolveNewAssistantMessage, AmbiguousNewMessageError } from "../../src/browser/domUtil";

const fixture = pathToFileURL(path.resolve("tests/fixtures/fakeChat.html")).href;
const assistant = ["[data-message-author-role='assistant']"];

test("captures baseline before send and excludes the old response", async ({ page }) => {
  await page.goto(fixture);
  const baseline = await captureTurnBaseline(page, assistant);
  await page.locator("#composer").fill("prompt");
  await page.locator("#send").click();
  await page.waitForTimeout(500);
  expect(baseline.count).toBe(1);
  expect(await resolveNewAssistantMessage(page, assistant, baseline)).toBe("stable final response");
});
test("uses index fallback when stable message ids are unavailable", async ({ page }) => {
  await page.setContent("<div id='messages'><article data-message-author-role='assistant'>old</article></div>");
  const baseline = await captureTurnBaseline(page, assistant);
  await page.locator("#messages").evaluate(node => { const item = document.createElement("article"); item.setAttribute("data-message-author-role", "assistant"); item.textContent = "new"; node.appendChild(item); });
  expect(await resolveNewAssistantMessage(page, assistant, baseline)).toBe("new");
});
test("throws instead of guessing zero or multiple new messages", async ({ page }) => {
  await page.goto(fixture);
  const baseline = await captureTurnBaseline(page, assistant);
  await expect(resolveNewAssistantMessage(page, assistant, baseline)).rejects.toBeInstanceOf(AmbiguousNewMessageError);
  await page.goto(fixture + "?mode=multi");
  const multiBaseline = await captureTurnBaseline(page, assistant);
  await page.locator("#composer").fill("prompt");
  await page.locator("#send").click();
  await page.waitForTimeout(500);
  await expect(resolveNewAssistantMessage(page, assistant, multiBaseline)).rejects.toMatchObject({ newMessageCount: 2 });
});
