import { expect, test } from "@playwright/test";
import {
  createTerminalConversationObserver,
  renderConversationEvent,
} from "../../src/cli/renderConversationEvent";
import type { ConversationEvent } from "../../src/conversation/conversationEvents";

const event = (fields: Record<string, unknown>): unknown => ({
  schemaVersion: 1,
  sequence: 1,
  emittedAt: "2026-01-01T00:00:00.000Z",
  ...fields,
});

test("terminal renderer covers each conversation lifecycle event without claiming decision authority", () => {
  expect(renderConversationEvent(event({ type: "conversation_started", task: "Review" }))).toBe("[Conversation] Started.");
  expect(renderConversationEvent(event({ type: "round_started", round: 1 }))).toBe("[Round 1] Started.");
  expect(renderConversationEvent(event({ type: "generator_completed", round: 0, responseLength: 42 }))).toContain("Initial response complete (42 chars)");
  expect(renderConversationEvent(event({ type: "reviewer_completed", round: 1, responseLength: 31 }))).toContain("Round 1 response complete (31 chars)");
  expect(renderConversationEvent(event({
    type: "jev_advisory_generated", round: 1,
    signal: { available: true, riskLevel: "advisory", flags: ["STAGNATION"], detail: ["No progress"] },
  }))).toBe("[JEV] Round 1 advisory: advisory; flags: STAGNATION.");
  expect(renderConversationEvent(event({ type: "human_gate_waiting", round: 1, recommendationKind: "CONTINUE_RECOMMENDED" })))
    .toContain("waiting for a human decision");
  expect(renderConversationEvent(event({
    type: "conversation_completed", roundsCompleted: 1, outcome: "REJECTED", outcomeOrigin: "HUMAN_OVERRODE_RECOMMENDATION",
  }))).toContain("Completed: REJECTED after 1 round");
});

test("malformed event data is skipped safely without producing misleading progress", () => {
  const malformed = [
    null,
    [],
    event({ type: "reviewer_completed", round: "1", responseLength: 5 }),
    event({ type: "generator_completed", round: 0, responseLength: -1 }),
    event({ type: "jev_advisory_generated", round: 1, signal: null }),
    event({ type: "jev_advisory_generated", round: 1, signal: { available: true, riskLevel: "elevated", flags: ["INVALID"], detail: [] } }),
    event({ type: "human_gate_waiting", round: 1, recommendationKind: "ACCEPT" }),
    event({ type: "conversation_completed", roundsCompleted: 1, outcome: "CONTINUE", outcomeOrigin: "HUMAN_AGREED_WITH_RECOMMENDATION" }),
    { ...event({ type: "round_started", round: 1 }) as Record<string, unknown>, schemaVersion: 99 },
    new Proxy({}, { get() { throw new Error("malformed proxy"); } }),
  ];
  const lines: string[] = [];
  const observer = createTerminalConversationObserver((line) => { lines.push(line); });
  for (const item of malformed) {
    expect(renderConversationEvent(item)).toBeUndefined();
    expect(() => observer.onEvent(item as ConversationEvent)).not.toThrow();
  }
  expect(lines).toEqual([]);
  expect(() => createTerminalConversationObserver(() => { throw new Error("terminal closed"); })
    .onEvent(event({ type: "conversation_started", task: "Review" }) as ConversationEvent)).not.toThrow();
});
