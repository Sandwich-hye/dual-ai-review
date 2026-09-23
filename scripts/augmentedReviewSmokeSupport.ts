import {
  ISOLATION_ATTESTATION_MAX_AGE_DAYS,
  type LlmIsolationAttestation,
} from "../src/orchestration/supervisor/llm/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The operator attests that the separate profile has memory/history reference disabled. */
export function validateIsolationAttestation(
  value: string | undefined,
  now = new Date(),
): LlmIsolationAttestation {
  if (!value) throw new Error("Set LLM_SUPERVISOR_ISOLATION_ATTESTED_AT to a recent UTC ISO timestamp after checking the separate profile and memory settings.");
  const attestedAt = new Date(value);
  const ageMs = now.getTime() - attestedAt.getTime();
  if (!Number.isFinite(ageMs) || attestedAt.toISOString() !== value || ageMs < 0 ||
      ageMs > ISOLATION_ATTESTATION_MAX_AGE_DAYS * DAY_MS) {
    throw new Error(`LLM isolation attestation must be a canonical UTC ISO timestamp from the past ${ISOLATION_ATTESTATION_MAX_AGE_DAYS} days.`);
  }
  return { isolationAttestedAt: value };
}

/** Refuse a shared or remote CDP endpoint; profile separation remains operator-attested. */
export function validateLlmCdpEndpoint(value: string | undefined, reviewEndpoint: string): string {
  if (!value) throw new Error("Set LLM_SUPERVISOR_CDP_ENDPOINT to the separate LLM Chrome profile's local CDP endpoint (for example http://127.0.0.1:9223).");
  let endpoint: URL;
  try { endpoint = new URL(value); }
  catch { throw new Error("LLM supervisor CDP endpoint is not a valid URL."); }
  const review = new URL(reviewEndpoint);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !endpoint.port || endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
      endpoint.username || endpoint.password || endpoint.port === review.port) {
    throw new Error("LLM supervisor CDP must use a distinct local HTTP port with no path or credentials.");
  }
  return endpoint.origin;
}
