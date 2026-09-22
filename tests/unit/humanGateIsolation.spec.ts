import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("Human Gate is browser-independent", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/orchestration/humanGate/humanGate.ts"),
    "utf8",
  );

  expect(source).not.toMatch(/playwright/i);
  expect(source).not.toMatch(/\bPage\b/);
  expect(source).not.toMatch(/browser/i);
});
