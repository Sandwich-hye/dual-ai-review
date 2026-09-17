import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

test("convergence modules have no browser or DOM dependency", () => {
  const directory = path.resolve("src/orchestration/convergence");
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith(".ts"))) {
    const source = fs.readFileSync(path.join(directory, file), "utf8");
    expect(source).not.toMatch(/from\s+["'](?:playwright|.*dom|.*sites)/i);
    expect(source).not.toMatch(/\bPage\b|querySelector|locator\(/);
  }
});
