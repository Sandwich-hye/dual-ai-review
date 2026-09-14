import { Page } from "playwright";

export type SiteLoadStatus = "ready" | "login_required" | "unknown_state" | "navigation_failed";
export interface SiteLoadResult { status: SiteLoadStatus; site: string; url: string; detail?: string; screenshotPath?: string }
export interface SiteAdapter { name: string; url: string; checkReady(page: Page): Promise<SiteLoadStatus> }
export interface TurnBaseline { count: number; ids: ReadonlySet<string> }
export type GenerationStartResult = "started" | "not_observed";
export interface GenerationDiagnostics { generationActiveVisible: boolean; newResponseFound: boolean; textLength: number; textStableForMs: number; sendVisible: boolean }
export type GenerationOutcome =
  | { outcome: "complete" }
  | { outcome: "timeout"; partialText: string; diagnostics: GenerationDiagnostics }
  | { outcome: "error_banner"; detail: string };
export interface ConversationalSiteAdapter extends SiteAdapter {
  sendPrompt(page: Page, prompt: string): Promise<void>;
  waitForGenerationStart(page: Page, baseline: TurnBaseline): Promise<GenerationStartResult>;
  waitForGenerationComplete(page: Page, baseline: TurnBaseline, timeoutMs: number): Promise<GenerationOutcome>;
  getLatestAssistantResponse(page: Page, baseline: TurnBaseline): Promise<string>;
}
