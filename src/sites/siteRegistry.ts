import { AppConfig } from "../config/loadConfig";
import { SiteAdapter } from "./siteTypes";
import { createChatGPTSite } from "./chatgptSite";
import { createClaudeSite } from "./claudeSite";

export function createSiteRegistry(config: AppConfig): SiteAdapter[] {
  return [createChatGPTSite(config.sites.chatgpt.url), createClaudeSite(config.sites.claude.url)];
}
