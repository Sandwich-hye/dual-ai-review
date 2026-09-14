import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { loadConfig } from "../../src/config/loadConfig";

function writeConfig(value: Record<string, unknown>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dual-ai-config-"));
  const file = path.join(directory, "config.json");
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    browserMode: "launch",
    cdpEndpoint: "http://127.0.0.1:9222",
    browserProfileDir: ".browser-profile",
    browserChannel: "chrome",
    headless: false,
    navigationTimeoutMs: 30000,
    sites: { chatgpt: { url: "https://chatgpt.com/" }, claude: { url: "https://claude.ai/new" } },
    ...overrides,
  };
}

test("loads valid launch configuration and resolves the project profile", () => {
  const config = loadConfig(writeConfig(validConfig({ browserMode: "launch" })));
  expect(config.browserMode).toBe("launch");
  expect(config.cdpEndpoint).toBe("http://127.0.0.1:9222");
  expect(config.browserChannel).toBe("chrome");
  expect(config.sites.chatgpt.url).toContain("chatgpt");
  expect(config.browserProfileDir).toBe(path.resolve(".browser-profile"));
});

test("loads valid attach configuration", () => {
  const config = loadConfig(writeConfig(validConfig({ browserMode: "attach" })));
  expect(config.browserMode).toBe("attach");
  expect(config.cdpEndpoint).toBe("http://127.0.0.1:9222");
});

test("rejects an invalid browser mode", () => {
  expect(() => loadConfig(writeConfig(validConfig({ browserMode: "other" })))).toThrow(/browserMode/);
});

for (const endpoint of ["https://127.0.0.1:9222", "http://192.168.1.10:9222", "not-a-url"]) {
  test(`rejects non-local CDP endpoint ${endpoint}`, () => {
    expect(() => loadConfig(writeConfig(validConfig({ browserMode: "attach", cdpEndpoint: endpoint })))).toThrow(/cdpEndpoint/);
  });
}

test("rejects malformed required fields", () => {
  const file = writeConfig({ browserProfileDir: ".profile", browserChannel: "chrome", headless: false, sites: {} });
  expect(() => loadConfig(file)).toThrow(/navigationTimeoutMs/);
});