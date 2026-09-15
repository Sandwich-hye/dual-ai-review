export const claudeSelectors = {
  composer: [
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[aria-label*="message" i]',
    'textarea[placeholder*="reply" i]',
  ],
  sendButton: [
    'button[aria-label*="Send message" i]',
    'button[data-testid="send-message"]',
    'button[data-testid="send-button"]',
  ],
  stopGenerating: [
    'button[aria-label*="Stop generating" i]',
    'button[data-testid="stop-generating"]',
    '[data-is-streaming="true"]',
  ],
  assistantMessage: [
    '[role="article"]:has([data-perf-reply-text])',
    '[role="article"]:has([data-cds="Prose"])',
    '[role="article"]:has(.font-claude-response)',
  ],
  assistantResponseText: '[data-perf-reply-text]',
  errorBanner: [
    '[role="alert"]:has-text("Something went wrong")',
    'text=/something went wrong/i',
    'text=/rate limit/i',
  ],
  securityVerification: [
    '[data-testid*="challenge" i]',
    'iframe[title*="challenge" i]',
    'text=/cloudflare|verify you are human|security check|checking your browser/i',
  ],
} as const;
export type ClaudeSelectorRole = keyof typeof claudeSelectors;

