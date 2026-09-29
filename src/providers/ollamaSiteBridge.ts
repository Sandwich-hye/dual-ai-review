import type { Page } from "playwright";
import type { AuditedReviewLoopSite } from "../orchestration/runAuditedReviewLoop";
import type { ConversationalSiteAdapter } from "../sites/siteTypes";
import type { ProviderProvenance } from "./llmProvider";
import type { OllamaProvider } from "./ollamaAdapter";

export type OllamaReviewRole = "generator" | "reviewer";

export interface OllamaSiteBridge extends AuditedReviewLoopSite {
  readonly providerProvenance: Readonly<ProviderProvenance>;
  readonly reviewRole: OllamaReviewRole;
}

/**
 * Temporary compatibility layer: current orchestration requires Page even though it only
 * passes that value to adapter methods. This bridge never reads or dereferences the page.
 * Remove the placeholder when orchestration accepts a provider session directly.
 */
export function createOllamaSiteBridge(
  provider: OllamaProvider,
  reviewRole: OllamaReviewRole,
  generationTimeoutMs?: number,
): OllamaSiteBridge {
  if (generationTimeoutMs !== undefined && (!Number.isSafeInteger(generationTimeoutMs) || generationTimeoutMs < 1)) {
    throw new RangeError("generationTimeoutMs must be a positive integer");
  }
  const session = provider.createSession();
  const adapter: ConversationalSiteAdapter = {
    name: `ollama-${reviewRole}`,
    url: provider.url,
    checkReady: (_page) => provider.checkReady(session),
    captureTurnBaseline: (_page) => provider.captureTurnBaseline(session),
    sendPrompt: (_page, prompt) => provider.sendPrompt(session, prompt),
    waitForGenerationStart: (_page, baseline, options) => provider.waitForGenerationStart(session, baseline, options),
    waitForGenerationComplete: (_page, baseline, timeoutMs) => provider.waitForGenerationComplete(session, baseline, timeoutMs),
    getLatestAssistantResponse: (_page, baseline) => provider.getLatestAssistantResponse(session, baseline),
  };
  // The opaque value is never a real Page. Only the bridge handles it, and its methods ignore it.
  const opaquePage = Object.freeze({}) as Page;
  return {
    page: opaquePage,
    adapter,
    providerProvenance: provider.provenance,
    reviewRole,
    ...(generationTimeoutMs === undefined ? {} : { generationTimeoutMs }),
  };
}
