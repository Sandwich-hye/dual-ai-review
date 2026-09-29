import type { LlmProvider } from "../sites/siteTypes";

export type { LlmProvider } from "../sites/siteTypes";

/** Kept outside the frozen audit schema; the CLI must save this beside its result. */
export interface ProviderProvenance {
  providerName: string;
  modelName: string;
  executionMode: "local_http" | "browser";
}

export interface ProvenancedLlmProvider<TSession> extends LlmProvider<TSession> {
  readonly provenance: Readonly<ProviderProvenance>;
}
