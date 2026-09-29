import type {
  GenerationOutcome,
  GenerationStartOptions,
  SiteLoadStatus,
  TurnBaseline,
} from "../sites/siteTypes";
import type { ProviderProvenance, ProvenancedLlmProvider } from "./llmProvider";

export type OllamaAdapterErrorCode =
  | "unavailable"
  | "model_unavailable"
  | "malformed_response"
  | "timeout"
  | "operation_state";

export class OllamaAdapterError extends Error {
  constructor(readonly code: OllamaAdapterErrorCode, message: string) {
    super(message);
    this.name = "OllamaAdapterError";
  }
}

export interface OllamaAdapterOptions {
  modelName: string;
  /** Only a local HTTP origin is permitted; defaults to Ollama's local port. */
  endpoint?: string;
  readinessTimeoutMs?: number;
}

type SettledTurn =
  | { kind: "success"; text: string }
  | { kind: "failure"; error: OllamaAdapterError };

interface PendingTurn {
  baselineCount: number;
  controller: AbortController;
  settled: Promise<SettledTurn>;
  timedOut: boolean;
}

/** One logical generator or reviewer conversation; no browser state is used. */
export interface OllamaSession {
  readonly provenance: Readonly<ProviderProvenance>;
  completedTurns: number;
  lastResponse?: string;
  pending?: PendingTurn;
}

export interface OllamaProvider extends ProvenancedLlmProvider<OllamaSession> {
  createSession(): OllamaSession;
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";
const DEFAULT_READINESS_TIMEOUT_MS = 5_000;

function localOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new RangeError("Ollama endpoint must be a local HTTP origin"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new RangeError("Ollama endpoint must be a local HTTP origin");
  }
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelMatches(configured: string, installed: string): boolean {
  return installed === configured || installed === `${configured}:latest`;
}

function availableModel(value: unknown, modelName: string): boolean {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new OllamaAdapterError("malformed_response", "Ollama model-list response is malformed");
  }
  return value.models.some((entry: unknown) =>
    isRecord(entry) &&
    ((typeof entry.name === "string" && modelMatches(modelName, entry.name)) ||
     (typeof entry.model === "string" && modelMatches(modelName, entry.model))));
}

function chatText(value: unknown, modelName: string): string {
  if (!isRecord(value) || typeof value.model !== "string" || !modelMatches(modelName, value.model) ||
      value.done !== true || !isRecord(value.message) ||
      value.message.role !== "assistant" || typeof value.message.content !== "string" ||
      value.message.content.trim() === "") {
    throw new OllamaAdapterError("malformed_response", "Ollama chat response is malformed or empty");
  }
  return value.message.content;
}

function operationState(message: string): OllamaAdapterError {
  return new OllamaAdapterError("operation_state", message);
}

/** Local-only, non-streaming HTTP adapter. No paid/cloud endpoint or browser calls. */
export function createOllamaAdapter(options: OllamaAdapterOptions): OllamaProvider {
  const modelName = options.modelName?.trim();
  if (!modelName) throw new RangeError("Ollama modelName must be non-empty");
  const endpoint = localOrigin(options.endpoint ?? DEFAULT_ENDPOINT);
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs < 1) {
    throw new RangeError("readinessTimeoutMs must be a positive integer");
  }
  const provenance: Readonly<ProviderProvenance> = Object.freeze({
    providerName: "ollama", modelName, executionMode: "local_http",
  });

  const requestChat = async (prompt: string, controller: AbortController): Promise<SettledTurn> => {
    try {
      const response = await fetch(`${endpoint}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: modelName, messages: [{ role: "user", content: prompt }], stream: false }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        return { kind: "failure", error: new OllamaAdapterError(
          response.status === 404 ? "model_unavailable" : "unavailable",
          response.status === 404 ? `Ollama model ${modelName} is unavailable` : `Ollama chat request failed (HTTP ${response.status})`,
        ) };
      }
      let body: unknown;
      try { body = await response.json(); }
      catch { throw new OllamaAdapterError("malformed_response", "Ollama chat response is not valid JSON"); }
      return { kind: "success", text: chatText(body, modelName) };
    } catch (error) {
      return { kind: "failure", error: error instanceof OllamaAdapterError
        ? error
        : new OllamaAdapterError("unavailable", "Ollama local HTTP request failed") };
    }
  };

  return {
    name: "ollama",
    url: endpoint,
    provenance,
    createSession: () => ({ provenance, completedTurns: 0 }),
    async checkReady(session: OllamaSession): Promise<SiteLoadStatus> {
      if (session.pending) throw operationState("Ollama session already has an active turn");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), readinessTimeoutMs);
      try {
        const response = await fetch(`${endpoint}/api/tags`, { signal: controller.signal, redirect: "error" });
        if (!response.ok) throw new OllamaAdapterError("unavailable", `Ollama model-list request failed (HTTP ${response.status})`);
        let body: unknown;
        try { body = await response.json(); }
        catch { throw new OllamaAdapterError("malformed_response", "Ollama model-list response is not valid JSON"); }
        if (!availableModel(body, modelName)) {
          throw new OllamaAdapterError("model_unavailable", `Ollama model ${modelName} is not installed`);
        }
        return "ready";
      } catch (error) {
        if (error instanceof OllamaAdapterError) throw error;
        throw new OllamaAdapterError(controller.signal.aborted ? "timeout" : "unavailable",
          controller.signal.aborted ? "Ollama readiness check timed out" : "Ollama local HTTP service is unavailable");
      } finally {
        clearTimeout(timer);
      }
    },
    async captureTurnBaseline(session: OllamaSession): Promise<TurnBaseline> {
      if (session.pending) throw operationState("Ollama session already has an active turn");
      return {
        count: session.completedTurns,
        ids: new Set(Array.from({ length: session.completedTurns }, (_, index) => `ollama-${index + 1}`)),
      };
    },
    async sendPrompt(session: OllamaSession, prompt: string): Promise<void> {
      if (session.pending) throw operationState("Ollama session already has an active turn");
      if (!prompt.trim()) throw operationState("Ollama prompt must be non-empty");
      const controller = new AbortController();
      const pending: PendingTurn = {
        baselineCount: session.completedTurns,
        controller,
        settled: requestChat(prompt, controller),
        timedOut: false,
      };
      session.pending = pending;
      void pending.settled.then(() => {
        if (pending.timedOut && session.pending === pending) session.pending = undefined;
      });
    },
    async waitForGenerationStart(session: OllamaSession, baseline: TurnBaseline, _options?: GenerationStartOptions) {
      // With non-streaming HTTP, successful sendPrompt means the request has started.
      return session.pending && session.pending.baselineCount === baseline.count ? "started" : "not_observed";
    },
    async waitForGenerationComplete(session: OllamaSession, baseline: TurnBaseline, timeoutMs: number): Promise<GenerationOutcome> {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("timeoutMs must be a positive integer");
      const pending = session.pending;
      if (!pending || pending.baselineCount !== baseline.count) throw operationState("Ollama turn baseline does not match the active request");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
        const settled = await Promise.race([pending.settled, timeout]);
        if (settled === "timeout") {
          pending.timedOut = true;
          pending.controller.abort();
          return { outcome: "timeout", partialText: "", diagnostics: {
            generationActiveVisible: false, newResponseFound: false, textLength: 0,
            textStableForMs: 0, sendVisible: false,
          } };
        }
        if (session.pending === pending) session.pending = undefined;
        if (settled.kind === "failure") throw settled.error;
        session.completedTurns += 1;
        session.lastResponse = settled.text;
        return { outcome: "complete" };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    async getLatestAssistantResponse(session: OllamaSession, baseline: TurnBaseline): Promise<string> {
      if (session.completedTurns !== baseline.count + 1 || session.lastResponse === undefined) {
        throw operationState("Ollama response does not match the requested baseline");
      }
      return session.lastResponse;
    },
  };
}
