import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("audited loop is the only Milestone 5 orchestration module allowed to reference Page", () => {
  const source = readFileSync(resolve(process.cwd(), "src/orchestration/runAuditedReviewLoop.ts"), "utf8");
  expect(source).toContain("Page");
  expect(source).not.toMatch(/selector/i);
});
