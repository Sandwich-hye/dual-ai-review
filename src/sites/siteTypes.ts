import { Page } from "playwright";

export type SiteLoadStatus = "ready" | "login_required" | "unknown_state" | "navigation_failed";
export interface SiteLoadResult { status: SiteLoadStatus; site: string; url: string; detail?: string; screenshotPath?: string }
export interface SiteAdapter { name: string; url: string; checkReady(page: Page): Promise<SiteLoadStatus> }
