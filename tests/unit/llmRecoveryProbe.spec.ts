import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import type { ConversationalSiteAdapter, TurnBaseline } from "../../src/sites/siteTypes";
import { probeLlmSessionIdle } from "../../src/orchestration/supervisor/llm/recovery";
import type { LlmSupervisorSession } from "../../src/orchestration/supervisor/llm/session";

interface FakeState {
  host?: string;
  active?: boolean;
  composerText?: string;
  assistantTexts?: string[];
  baselineIds?: string[];
}

function sessionFor(state: FakeState): LlmSupervisorSession {
  let textReads = 0;
  const page = {
    isClosed: () => false,
    url: () => state.host ?? "https://chatgpt.com/",
    locator: (selector: string) => {
      const composer = selector === '[data-testid="prompt-textarea"]';
      const active = selector === '[data-testid="stop-button"]' && state.active === true;
      const assistant = selector === '[data-message-author-role="assistant"]';
      const count = composer || active || assistant ? 1 : 0;
      const item = {
        isVisible: async () => composer || active,
        evaluate: async () => "textarea",
        inputValue: async () => state.composerText ?? "",
        innerText: async () => {
          const texts = state.assistantTexts ?? ["stable response"];
          return texts[Math.min(textReads++, texts.length - 1)];
        },
      };
      return { count: async () => count, nth: () => item, last: () => item };
    },
  } as unknown as Page;
  const adapter = {
    name: "chatgpt",
    captureTurnBaseline: async (): Promise<TurnBaseline> => ({
      count: 1, ids: new Set(state.baselineIds ?? ["assistant:1"]),
    }),
  } as ConversationalSiteAdapter;
  return { page, adapter, checkReady: async () => "ready", close: async () => {} };
}

test("read-only recovery accepts a stable idle dedicated page", async () => {
  await expect(probeLlmSessionIdle(sessionFor({}), 1)).resolves.toEqual({ healthy: true });
});

test("recovery rejects active generation, partial composer text, and foreign origins", async () => {
  await expect(probeLlmSessionIdle(sessionFor({ active: true }), 1)).resolves.toEqual({
    healthy: false, detail: "generation still active",
  });
  await expect(probeLlmSessionIdle(sessionFor({ composerText: "unfinished prompt" }), 1)).resolves.toEqual({
    healthy: false, detail: "composer contains text",
  });
  await expect(probeLlmSessionIdle(sessionFor({ host: "https://example.invalid/" }), 1)).resolves.toEqual({
    healthy: false, detail: "unexpected page origin",
  });
});

test("recovery rejects a changing or ambiguous assistant turn", async () => {
  await expect(probeLlmSessionIdle(sessionFor({ assistantTexts: ["streaming", "still streaming"] }), 1)).resolves.toEqual({
    healthy: false, detail: "assistant turn not stable",
  });
  await expect(probeLlmSessionIdle(sessionFor({ baselineIds: [] }), 1)).resolves.toEqual({
    healthy: false, detail: "assistant turn not stable",
  });
});
