import { test, expect } from "@playwright/test";
import { assertExactNewIds, claudeOrdinalFromAriaLabel, newStableIds } from "../../scripts/smokeTurnIdentity";

test("set-based deltas survive virtualized disappearance of baseline nodes", () => {
  expect(newStableIds(new Set(["user:1", "user:3"]), ["user:5", "user:7"])).toEqual(["user:5", "user:7"]);
  expect(newStableIds(new Set(["assistant:2", "assistant:4"]), ["assistant:2", "assistant:4", "assistant:6", "assistant:8"])).toEqual(["assistant:6", "assistant:8"]);
});

test("exact expected new identities pass and extra or missing identities fail", () => {
  expect(assertExactNewIds("Claude users", new Set(["claude:message:1", "claude:message:3"]), ["claude:message:5", "claude:message:7"], 2)).toEqual(["claude:message:5", "claude:message:7"]);
  expect(() => assertExactNewIds("users", new Set(["1"]), ["2", "3", "4"], 2)).toThrow("exactly 2");
  expect(() => assertExactNewIds("users", new Set(["1"]), ["2"], 2)).toThrow("exactly 2");
});

test("role identity sets remain separated", () => {
  const users = new Set(["claude:message:5", "claude:message:7"]);
  const assistants = new Set(["claude:message:6", "claude:message:8"]);
  expect([...users].some(id => assistants.has(id))).toBe(false);
});

test("Claude identity ignores the changing Message total", () => {
  expect(claudeOrdinalFromAriaLabel("Message 5 of 8")).toBe("claude:message:5");
  expect(claudeOrdinalFromAriaLabel("Message 5 of 10")).toBe("claude:message:5");
});

test("fresh conversation has an empty baseline", () => {
  expect(newStableIds(new Set(), ["chatgpt:user:message:u1", "chatgpt:assistant:message:a1"])).toEqual(["chatgpt:user:message:u1", "chatgpt:assistant:message:a1"]);
});