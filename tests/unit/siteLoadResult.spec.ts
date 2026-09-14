import { test, expect } from "@playwright/test";
import { checkChatGPTReady } from "../../src/sites/chatgptSite";
import { checkClaudeReady } from "../../src/sites/claudeSite";

for (const [name, detector] of [["ChatGPT", checkChatGPTReady], ["Claude", checkClaudeReady]] as const) {
  test(`${name} detector classifies local fixtures`, async ({ page }) => {
    await page.setContent('<textarea aria-label="Chat input"></textarea>');
    expect(await detector(page)).toBe("ready");
    await page.setContent('<form><input type="email"><input type="password"></form>');
    expect(await detector(page)).toBe("login_required");
    await page.setContent("<h1>Unknown</h1>");
    expect(await detector(page)).toBe("unknown_state");
  });
}
