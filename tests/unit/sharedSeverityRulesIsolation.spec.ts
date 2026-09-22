import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("shared severity rules have no convergence or claim-ledger dependency", () => {
  const source = readFileSync(resolve(process.cwd(), "src/orchestration/shared/severityRules.ts"), "utf8");
  expect(source).not.toMatch(/convergence|claims|playwright|Page/);
});
