import type { Page } from "playwright";

export type SiteLoadStatus = "ready" | "login_required" | "unknown_state" | "navigation_failed";
export interface SiteLoadResult { status: SiteLoadStatus; site: string; url: string; detail?: string; screenshotPath?: string }
export interface SiteAdapter { name: string; url: string; checkReady(page: Page): Promise<SiteLoadStatus> }
export interface TurnBaseline { count: number; ids: ReadonlySet<string> }
export type GenerationStartResult = "started" | "not_observed";
export interface GenerationStartOptions { startTimeoutMs?: number }
export interface GenerationDiagnostics { generationActiveVisible: boolean; newResponseFound: boolean; textLength: number; textStableForMs: number; sendVisible: boolean }
export type GenerationOutcome =
  | { outcome: "complete" }
  | { outcome: "timeout"; partialText: string; diagnostics: GenerationDiagnostics }
  | { outcome: "error_banner"; detail: string };
/** Shared method shape only; the existing review loops still require Playwright Page. */
export interface LlmProvider<TSession> {
  name: string;
  url: string;
  checkReady(session: TSession): Promise<SiteLoadStatus>;
  captureTurnBaseline(session: TSession): Promise<TurnBaseline>;
  sendPrompt(session: TSession, prompt: string): Promise<void>;
  waitForGenerationStart(session: TSession, baseline: TurnBaseline, options?: GenerationStartOptions): Promise<GenerationStartResult>;
  waitForGenerationComplete(session: TSession, baseline: TurnBaseline, timeoutMs: number): Promise<GenerationOutcome>;
  getLatestAssistantResponse(session: TSession, baseline: TurnBaseline): Promise<string>;
}

/** Preserve the exact Page-bound adapter contract used by existing browser code. */
export interface ConversationalSiteAdapter extends SiteAdapter, LlmProvider<Page> {}

