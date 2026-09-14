import fs from "node:fs";
import path from "node:path";

export interface SiteConfig { url: string }
export type BrowserMode = "launch" | "attach";

export interface AppConfig {
  browserProfileDir: string;
  browserMode: BrowserMode;
  cdpEndpoint: string;
  browserChannel: string;
  headless: boolean;
  navigationTimeoutMs: number;
  sites: { chatgpt: SiteConfig; claude: SiteConfig };
}

function fail(message: string): never { throw new Error(`Invalid configuration: ${message}`); }

export function loadConfig(configPath = path.resolve(process.cwd(), "config/config.json")): AppConfig {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(configPath, "utf8")); }
  catch (error) { throw new Error(`Unable to load configuration at ${configPath}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object") fail("root must be an object");
  const raw = value as Record<string, unknown>;
  if (typeof raw.browserProfileDir !== "string" || !raw.browserProfileDir.trim()) fail("browserProfileDir must be a non-empty string");
  const browserMode = raw.browserMode === undefined ? "launch" : raw.browserMode;
  if (browserMode !== "launch" && browserMode !== "attach") fail("browserMode must be launch or attach");
  const cdpEndpoint = raw.cdpEndpoint === undefined ? "http://127.0.0.1:9222" : raw.cdpEndpoint;
  if (typeof cdpEndpoint !== "string" || !cdpEndpoint.trim()) fail("cdpEndpoint must be a non-empty string");
  let parsedCdp: URL;
  try { parsedCdp = new URL(cdpEndpoint); } catch { fail("cdpEndpoint must be a valid URL"); }
  if (parsedCdp.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsedCdp.hostname)) fail("cdpEndpoint must use local HTTP");
  if (typeof raw.browserChannel !== "string" || !raw.browserChannel.trim()) fail("browserChannel must be a non-empty string");
  if (typeof raw.headless !== "boolean") fail("headless must be a boolean");
  if (typeof raw.navigationTimeoutMs !== "number" || !Number.isInteger(raw.navigationTimeoutMs) || raw.navigationTimeoutMs <= 0) fail("navigationTimeoutMs must be a positive integer");
  const sites = raw.sites;
  if (!sites || typeof sites !== "object") fail("sites must be an object");
  const siteRecord = sites as Record<string, unknown>;
  for (const name of ["chatgpt", "claude"]) {
    const site = siteRecord[name];
    if (!site || typeof site !== "object" || typeof (site as Record<string, unknown>).url !== "string" || !(site as Record<string, string>).url.trim()) fail(`sites.${name}.url must be a non-empty string`);
  }
  const resolvedProfile = path.resolve(process.cwd(), raw.browserProfileDir);
  const normalChrome = path.resolve(process.env.LOCALAPPDATA ?? "", "Google/Chrome/User Data").toLowerCase();
  if (resolvedProfile.toLowerCase() === normalChrome || resolvedProfile.toLowerCase().startsWith(`${normalChrome}${path.sep.toLowerCase()}`)) fail("browserProfileDir must not be the normal Chrome profile directory");
  return {
    browserProfileDir: resolvedProfile,
    browserMode,
    cdpEndpoint,
    browserChannel: raw.browserChannel,
    headless: raw.headless,
    navigationTimeoutMs: raw.navigationTimeoutMs,
    sites: { chatgpt: { url: (siteRecord.chatgpt as SiteConfig).url }, claude: { url: (siteRecord.claude as SiteConfig).url } }
  };
}
