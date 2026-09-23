import { expect, test } from "@playwright/test";
import {
  validateIsolationAttestation,
  validateLlmCdpEndpoint,
} from "../../scripts/augmentedReviewSmokeSupport";

const now = new Date("2026-09-23T12:00:00.000Z");

test("smoke isolation attestation accepts only a recent canonical UTC timestamp", () => {
  expect(validateIsolationAttestation("2026-09-22T12:00:00.000Z", now)).toEqual({
    isolationAttestedAt: "2026-09-22T12:00:00.000Z",
  });
  for (const value of [
    undefined,
    "not-a-date",
    "2026-09-23T12:00:01.000Z",
    "2026-08-23T11:59:59.000Z",
    "2026-09-22T12:00:00Z",
  ]) {
    expect(() => validateIsolationAttestation(value, now)).toThrow();
  }
});

test("smoke requires a separate local LLM CDP endpoint", () => {
  const review = "http://127.0.0.1:9222";
  expect(validateLlmCdpEndpoint("http://127.0.0.1:9223", review)).toBe("http://127.0.0.1:9223");
  for (const value of [
    undefined,
    review,
    "http://localhost:9222",
    "http://192.168.1.2:9223",
    "https://127.0.0.1:9223",
    "http://127.0.0.1:9223/other",
    "http://user:password@127.0.0.1:9223",
  ]) {
    expect(() => validateLlmCdpEndpoint(value, review)).toThrow();
  }
});
