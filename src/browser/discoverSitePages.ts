import { Page } from "playwright";

export interface DiscoveredSitePages {
  chatgpt?: Page;
  claude?: Page;
}

function hostname(page: Page): string {
  try { return new URL(page.url()).hostname.toLowerCase(); }
  catch { return ""; }
}

function matches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function discoverSitePages(pages: readonly Page[]): DiscoveredSitePages {
  const discovered: DiscoveredSitePages = {};
  for (const page of pages) {
    const host = hostname(page);
    if (!discovered.chatgpt && (matches(host, "chatgpt.com") || host === "chat.openai.com")) discovered.chatgpt = page;
    else if (!discovered.claude && matches(host, "claude.ai")) discovered.claude = page;
  }
  return discovered;
}