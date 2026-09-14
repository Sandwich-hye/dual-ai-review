export const chatgptSelectors = {
  composer: [
    '[data-testid="prompt-textarea"]',
    '#prompt-textarea',
    'textarea[aria-label*="message" i]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea',
  ],
  sendButton: [
    '[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'button[data-testid*="send" i]',
  ],
  stopGenerating: [
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="Cancel" i]',
  ],
  assistantMessage: [
    '[data-message-author-role="assistant"]',
    '[data-testid="assistant-message"]',
    'article[data-testid*="conversation-turn" i] [data-message-author-role="assistant"]',
  ],
  errorBanner: [
    '[role="alert"]:has-text("Something went wrong")',
    'text=/something went wrong/i',
    'text=/rate limit/i',
  ],
} as const;
export type ChatGPTSelectorRole = keyof typeof chatgptSelectors;
