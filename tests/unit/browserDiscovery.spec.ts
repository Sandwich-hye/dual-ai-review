import { Page } from "playwright";
import { test, expect } from "@playwright/test";
import { discoverSitePages } from "../../src/browser/discoverSitePages";

function page(url: string): Page {
  return { url: () => url } as Page;
}

test("finds the first ChatGPT tab by hostname", () => {
  const first = page("https://chatgpt.com/");
  const result = discoverSitePages([first, page("https://chat.openai.com/")]);
  expect(result.chatgpt).toBe(first);
});

test("finds Claude by hostname", () => {
  const claude = page("https://claude.ai/new");
  expect(discoverSitePages([claude]).claude).toBe(claude);
});

test("ignores unrelated tabs", () => {
  const result = discoverSitePages([page("https://example.com/"), page("about:blank")]);
  expect(result.chatgpt).toBeUndefined();
  expect(result.claude).toBeUndefined();
});

test("reports a missing ChatGPT tab", () => {
  const result = discoverSitePages([page("https://claude.ai/new")]);
  expect(result.chatgpt).toBeUndefined();
  expect(result.claude).toBeDefined();
});

test("reports a missing Claude tab", () => {
  const result = discoverSitePages([page("https://chatgpt.com/")]);
  expect(result.chatgpt).toBeDefined();
  expect(result.claude).toBeUndefined();
});