import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createLogger } from "../../src/logging/logger";

test("writes formatted events to console and a run file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dual-ai-logs-"));
  const original = console.log;
  const lines: string[] = [];
  console.log = (line?: unknown) => lines.push(String(line));
  try {
    const logger = createLogger(directory);
    logger.info("test", "hello");
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T.*\] \[INFO\] \[test\] hello$/);
    expect(fs.readFileSync(logger.logFile, "utf8")).toContain("[INFO] [test] hello");
  } finally { console.log = original; }
});
