import { test, expect } from "@playwright/test";
import type { Page } from "playwright";
import {
  AuditedReviewLoopError,
  runAuditedReviewLoop,
  type AuditedReviewLoopInput,
} from "../../src/orchestration/runAuditedReviewLoop";
import type { HumanGate, HumanGatePresentation, HumanGateRawResponse } from "../../src/orchestration/humanGate/humanGate";

const review = (body: Record<string, unknown>): string =>
  `BEGIN_STRUCTURED_REVIEW\n${JSON.stringify({
    reviewStatus: "CONTINUE",
    resolvedClaimIds: [],
    resolutionEvidence: {},
    stillOpenClaims: [],
    reopenedClaims: [],
    newClaims: [],
    ...body,
  })}\nEND_STRUCTURED_REVIEW`;

const newClaim = (statement = "The answer makes a material claim."): string => review({
  newClaims: [{ severity: "HIGH", statement, rationale: "The reviewer requires support." }],
});

class FakeAdapter {
  readonly name = "fake";
  readonly url = "fake://site";
  readonly prompts: string[] = [];
  private responses: string[];
  private failStartAt: number | undefined;

  constructor(responses: string[], failStartAt?: number) {
    this.responses = [...responses];
    this.failStartAt = failStartAt;
  }

  async checkReady(): Promise<"ready"> { return "ready"; }
  async captureTurnBaseline(): Promise<{ count: number; ids: ReadonlySet<string> }> {
    return { count: this.prompts.length, ids: new Set() };
  }
  async sendPrompt(_page: Page, prompt: string): Promise<void> { this.prompts.push(prompt); }
  async waitForGenerationStart(): Promise<"started" | "not_observed"> {
    return this.failStartAt !== undefined && this.prompts.length === this.failStartAt ? "not_observed" : "started";
  }
  async waitForGenerationComplete(): Promise<{ outcome: "complete" }> { return { outcome: "complete" }; }
  async getLatestAssistantResponse(): Promise<string> { return this.responses.shift() ?? ""; }
}

const gate = (...outcomes: HumanGateRawResponse[]): HumanGate => ({
  async presentAndAwaitDecision(): Promise<HumanGateRawResponse> {
    const next = outcomes.shift();
    if (!next) throw new Error("no scripted human decision");
    return next;
  },
});

const raw = (requestedOutcome: HumanGateRawResponse["requestedOutcome"]): HumanGateRawResponse => ({
  requestedOutcome,
  rationale: requestedOutcome === "REJECT" ? "The human rejected the current answer." : undefined,
  decidedAt: "2026-09-22T00:00:00.000Z",
});

const input = (chatgpt: FakeAdapter, claude: FakeAdapter, humanGate: HumanGate, overrides: Partial<AuditedReviewLoopInput> = {}): AuditedReviewLoopInput => ({
  originalTask: "Explain the task accurately.",
  chatgpt: { page: {} as Page, adapter: chatgpt },
  claude: { page: {} as Page, adapter: claude },
  humanGate,
  options: { hardMaxRounds: 5, recommendedMaxRounds: 4 },
  ...overrides,
});

test("runs the complete audited lifecycle and records audit data", async () => {
  const chatgpt = new FakeAdapter(["G0", "G1"]);
  const claude = new FakeAdapter([newClaim()]);
  const result = await runAuditedReviewLoop(input(chatgpt, claude, gate(raw("ACCEPT"))));

  expect(result.outcome).toBe("ACCEPTED");
  expect(result.rounds).toHaveLength(1);
  expect(result.rounds[0].humanDecision.outcome).toBe("ACCEPT");
  expect(result.rounds[0].ledgerSnapshot[0].id).toBe("CLAIM-1");
  expect(result.runAuditTrail.some((event) => event.kind === "RECOMMENDATION_OVERRIDDEN_BY_HUMAN")).toBe(true);
});

test("continues through a generator revision before the next reviewer round", async () => {
  const chatgpt = new FakeAdapter(["G0", "G1"]);
  const claude = new FakeAdapter([newClaim(), review({ stillOpenClaims: [{ id: "CLAIM-1" }] })]);
  const result = await runAuditedReviewLoop(input(chatgpt, claude, gate(raw("CONTINUE"), raw("ACCEPT"))));

  expect(result.outcome).toBe("ACCEPTED");
  expect(result.rounds).toHaveLength(2);
  expect(result.rounds[0].generatorResponse).toBe("G1");
  expect(chatgpt.prompts).toHaveLength(2);
});

test("records a human rejection and a recommendation override", async () => {
  const chatgpt = new FakeAdapter(["G0"]);
  const claude = new FakeAdapter([newClaim()]);
  const result = await runAuditedReviewLoop(input(chatgpt, claude, gate(raw("REJECT"))));

  expect(result.outcome).toBe("REJECTED");
  expect(result.outcomeOrigin).toBe("HUMAN_OVERRODE_RECOMMENDATION");
  expect(result.rounds[0].humanDecision.recommendationAgreement).toBe("OVERRODE");
  expect(result.runAuditTrail.some((event) => event.kind === "RECOMMENDATION_OVERRIDDEN_BY_HUMAN")).toBe(true);
});

test("a human agreement reports the recommendation-derived outcome origin", async () => {
  const chatgpt = new FakeAdapter(["G0"]);
  const claude = new FakeAdapter([review({})]);
  const result = await runAuditedReviewLoop(input(chatgpt, claude, gate(raw("ACCEPT")), {
    options: { hardMaxRounds: 5, recommendedMaxRounds: 4, stabilityWindowRounds: 1 },
  }));

  expect(result.rounds[0].recommendation.kind).toBe("ACCEPT_RECOMMENDED");
  expect(result.rounds[0].humanDecision.recommendationAgreement).toBe("AGREED");
  expect(result.outcomeOrigin).toBe("HUMAN_AGREED_WITH_RECOMMENDATION");
});

test("invalid reviews remain gated and can be rejected by the human", async () => {
  const chatgpt = new FakeAdapter(["G0"]);
  const claude = new FakeAdapter(["not structured JSON"]);
  const result = await runAuditedReviewLoop(input(chatgpt, claude, gate(raw("REJECT"))));

  expect(result.rounds[0].recommendation.triggeredBranch).toBe("INVALID_REVIEW_SINGLE");
  expect(result.runAuditTrail.some((event) => event.kind === "INVALID_REVIEW_ENCOUNTERED")).toBe(true);
  expect(result.claimLedger).toEqual([]);
});

test("captures ledgerSnapshot after human evidence ingestion", async () => {
  const chatgpt = new FakeAdapter(["G0"]);
  const claude = new FakeAdapter([newClaim()]);
  const result = await runAuditedReviewLoop(input(chatgpt, claude, gate(raw("ACCEPT")), {
    collectHumanEvidence: async () => [{
      claimId: "CLAIM-1",
      kind: "SUPPORTING",
      strength: "STRONG",
      text: "Human supplied source.",
      round: 1,
      submittedAt: "2026-09-22T00:01:00.000Z",
    }],
  }));

  expect(result.rounds[0].recommendation.disputedCount).toBe(0);
  expect(result.rounds[0].ledgerSnapshot[0].evidenceFor).toEqual(["EV-1"]);
  expect(result.rounds[0].humanSuppliedEvidence?.[0].sourceRole).toBe("HUMAN");
  expect(result.evidenceLog[0].sourceRole).toBe("HUMAN");
});

test("preserves partial results when revision generation fails and sends once", async () => {
  const chatgpt = new FakeAdapter(["G0", "never returned"], 2);
  const claude = new FakeAdapter([newClaim()]);

  let thrown: unknown;
  try {
    await runAuditedReviewLoop(input(chatgpt, claude, gate(raw("CONTINUE"))));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AuditedReviewLoopError);
  {
    const error = thrown as AuditedReviewLoopError;
    expect(error).toBeInstanceOf(AuditedReviewLoopError);
    expect(error.partialResult.rounds).toHaveLength(1);
    expect(error.partialResult.rounds[0].generatorPrompt).toBeTruthy();
  }
  expect(chatgpt.prompts).toHaveLength(2);
});

test("does not duplicate a send when generation start is not observed", async () => {
  const chatgpt = new FakeAdapter(["G0"], 1);
  const claude = new FakeAdapter([]);

  await expect(runAuditedReviewLoop(input(chatgpt, claude, gate(raw("ACCEPT"))))).rejects.toBeInstanceOf(AuditedReviewLoopError);
  expect(chatgpt.prompts).toHaveLength(1);
  expect(claude.prompts).toHaveLength(0);
});
