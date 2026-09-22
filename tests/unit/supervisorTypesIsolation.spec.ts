import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("supervisor type contracts have no browser dependency", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/orchestration/supervisor/types.ts"),
    "utf8",
  );

  expect(source).not.toMatch(/playwright/i);
  expect(source).not.toMatch(/\bPage\b/);
  expect(source).not.toMatch(/browser/i);
});
