import { test, expect } from "@playwright/test";
import {
  computeAdjustedSeverity,
  computeReopenSeverity,
  rankOf,
  SEVERITY_ORDER,
  type ReviewSeverity,
} from "../../src/orchestration/shared/severityRules";

test("escalates LOW to HIGH and tracks the new historical peak", () => {
  expect(computeAdjustedSeverity("LOW", "LOW", "HIGH")).toEqual({
    newSeverity: "HIGH",
    newHighestSeveritySeen: "HIGH",
    event: "ESCALATED",
  });
});

test("rejects an OPEN HIGH to LOW downgrade without changing severity", () => {
  expect(computeAdjustedSeverity("HIGH", "HIGH", "LOW")).toEqual({
    newSeverity: "HIGH",
    newHighestSeveritySeen: "HIGH",
    event: "DOWNGRADE_REJECTED",
  });
});

test("reopen keeps the historical highest severity as the floor", () => {
  expect(computeReopenSeverity("MEDIUM", "HIGH", "LOW")).toEqual({
    newSeverity: "HIGH",
    newHighestSeveritySeen: "HIGH",
    floored: true,
  });
});

test("reopen honors an escalation above the historical floor", () => {
  expect(computeReopenSeverity("MEDIUM", "MEDIUM", "HIGH")).toEqual({
    newSeverity: "HIGH",
    newHighestSeveritySeen: "HIGH",
    floored: false,
  });
});

test("equal severity is unchanged and preserves the historical peak", () => {
  expect(computeAdjustedSeverity("MEDIUM", "HIGH", "MEDIUM")).toEqual({
    newSeverity: "MEDIUM",
    newHighestSeveritySeen: "HIGH",
    event: "UNCHANGED",
  });
});

test("reopen without an override uses the severity at resolution", () => {
  expect(computeReopenSeverity("LOW", "LOW", undefined)).toEqual({
    newSeverity: "LOW",
    newHighestSeveritySeen: "LOW",
    floored: false,
  });
});

test("severity ordering is complete and monotonic", () => {
  const severities: ReviewSeverity[] = ["LOW", "MEDIUM", "HIGH"];
  expect(severities.map(rankOf)).toEqual([1, 2, 3]);
  expect(SEVERITY_ORDER).toEqual({ LOW: 1, MEDIUM: 2, HIGH: 3 });
});
