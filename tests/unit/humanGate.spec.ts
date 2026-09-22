import { test, expect } from "@playwright/test";
import type {
  HumanGate,
  HumanGatePresentation,
  HumanGateRawResponse,
} from "../../src/orchestration/humanGate/humanGate";
import type { ClaimLedgerEntry, Evidence } from "../../src/orchestration/claims/types";

const claim: ClaimLedgerEntry = {
  id: "CLAIM-1",
  claim: { statement: "The answer contains a factual claim.", rationale: "It needs verification." },
  severity: "HIGH",
  highestSeveritySeen: "HIGH",
  confidence: 0.4,
  status: "DISPUTED",
  evidenceFor: ["EV-1"],
  evidenceAgainst: ["EV-2"],
  confidenceHistory: [],
  firstSeenRound: 1,
  lastSeenRound: 2,
  normalizedFingerprint: ["answer", "contains", "factual", "claim"],
  history: [],
};

const evidence: Evidence[] = [
  {
    id: "EV-1",
    claimId: "CLAIM-1",
    kind: "SUPPORTING",
    strength: "MODERATE",
    sourceRole: "REVIEWER",
    text: "Supporting context.",
    round: 2,
    submittedAt: "2026-09-22T00:00:00.000Z",
  },
  {
    id: "EV-2",
    claimId: "CLAIM-1",
    kind: "CHALLENGING",
    strength: "STRONG",
    sourceRole: "REVIEWER",
    text: "Contrary context.",
    round: 2,
    submittedAt: "2026-09-22T00:00:01.000Z",
  },
];

const presentation: HumanGatePresentation = {
  round: 2,
  currentAnswer: "Current answer.",
  recommendation: {
    kind: "CONTINUE_RECOMMENDED",
    triggeredBranch: "DEFAULT_CONTINUE",
    round: 2,
    reason: "1 open HIGH claim remains",
    cleanStreak: 0,
    openHighCount: 1,
    openMediumCount: 0,
    disputedCount: 1,
    averageConfidence: 0.4,
    lowConfidenceResolutionCount: 0,
    invalidReviewStreak: 0,
  },
  disputedClaims: [claim],
  claimLedgerDelta: [claim],
  relevantEvidence: evidence,
  legalOutcomes: ["CONTINUE", "ACCEPT", "REJECT"],
};

test("HumanGate exposes the required async presentation contract", async () => {
  const gate: HumanGate = {
    async presentAndAwaitDecision(receivedPresentation) {
      expect(receivedPresentation).toEqual(presentation);
      return {
        requestedOutcome: "CONTINUE",
        rationale: "More review is needed.",
        decidedAt: "2026-09-22T00:01:00.000Z",
      };
    },
  };

  await expect(gate.presentAndAwaitDecision(presentation)).resolves.toEqual({
    requestedOutcome: "CONTINUE",
    rationale: "More review is needed.",
    decidedAt: "2026-09-22T00:01:00.000Z",
  });
});

test("raw response contains only human-provided fields", () => {
  const raw: HumanGateRawResponse = {
    requestedOutcome: "ACCEPT",
    rationale: "The remaining issue is immaterial.",
    decidedAt: "2026-09-22T00:02:00.000Z",
  };

  expect(Object.keys(raw).sort()).toEqual(["decidedAt", "rationale", "requestedOutcome"]);
  expect(raw).not.toHaveProperty("recommendationAgreement");
  expect(raw).not.toHaveProperty("hardSafetyOverride");
  expect(raw).not.toHaveProperty("outcomeOrigin");
});

test("presentation carries disputed claims and relevant evidence context", () => {
  expect(presentation.disputedClaims).toEqual([claim]);
  expect(presentation.relevantEvidence).toEqual(evidence);
  expect(presentation.disputedClaims[0].evidenceAgainst).toContain("EV-2");
  expect(presentation.relevantEvidence.map((item) => item.id)).toEqual(["EV-1", "EV-2"]);
  expect(presentation.legalOutcomes).toEqual(["CONTINUE", "ACCEPT", "REJECT"]);
});

test("presentation and raw response serialize as JSON", () => {
  expect(JSON.parse(JSON.stringify(presentation))).toEqual(presentation);
  const raw: HumanGateRawResponse = {
    requestedOutcome: "REJECT",
    decidedAt: "2026-09-22T00:03:00.000Z",
  };
  expect(JSON.parse(JSON.stringify(raw))).toEqual(raw);
});

test("Human Gate has no decision logic: it only returns the supplied raw outcome", async () => {
  const gate: HumanGate = {
    async presentAndAwaitDecision() {
      return { requestedOutcome: "ACCEPT", decidedAt: "2026-09-22T00:04:00.000Z" };
    },
  };

  const raw = await gate.presentAndAwaitDecision(presentation);
  expect(raw.requestedOutcome).toBe("ACCEPT");
  expect(raw).not.toHaveProperty("kind");
  expect(raw).not.toHaveProperty("triggeredBranch");
});
