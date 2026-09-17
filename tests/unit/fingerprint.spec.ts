import { test, expect } from "@playwright/test";
import { classifyFingerprint, diceCoefficient, fingerprintTokens, normalizeForFingerprint } from "../../src/orchestration/convergence/fingerprint";

const options = { fingerprintMergeThreshold: .85, fingerprintAmbiguityMargin: .15, fingerprintMinSharedTokens: 3, fingerprintCandidateThreshold: .6 };
const entry = (id: string, text: string) => ({ id, normalizedFingerprint: fingerprintTokens({ summary: text, reason: text }), status: "OPEN", severity: "HIGH", highestSeveritySeen: "HIGH", summary: text, reason: text, firstSeenRound: 1, lastSeenRound: 1, history: [] as never[] });

test("normalizes punctuation, case, stop words, and sorts fingerprints", () => {
  expect([...normalizeForFingerprint("The Retry, loop is safe!")]).toEqual(["retry", "loop", "safe"]);
  expect(fingerprintTokens({ summary: "Bee Zebra", reason: "Alpha" })).toEqual(["alpha", "bee", "zebra"]);
});
test("uses Dice token similarity", () => expect(diceCoefficient(new Set(["a", "b"]), new Set(["b", "c"]))).toBe(.5));
test("requires high score, margin, and three shared tokens to merge", () => {
  expect(classifyFingerprint({ summary: "retry timeout handling", reason: "retry timeout handling" }, [entry("OBJ-1", "retry timeout handling")], options).kind).toBe("MERGE");
  expect(classifyFingerprint({ summary: "retry handling", reason: "retry handling" }, [entry("OBJ-1", "retry timeout handling")], options).kind).toBe("NEW");
});
test("ambiguous candidates remain new", () => {
  const result = classifyFingerprint({ summary: "retry timeout handling", reason: "retry timeout handling" }, [entry("OBJ-1", "retry timeout handling alpha"), entry("OBJ-2", "retry timeout handling beta")], options);
  expect(result.kind).toBe("NEW");
  expect(result.possibleDuplicate).toBeDefined();
});
