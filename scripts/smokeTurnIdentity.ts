export type MessageRole = "user" | "assistant";
export interface StableMessage { id: string; role: MessageRole }

export function newStableIds(baseline: ReadonlySet<string>, finalIds: readonly string[]): string[] {
  return finalIds.filter(id => !baseline.has(id));
}

export function assertExactNewIds(label: string, baseline: ReadonlySet<string>, finalIds: readonly string[], expected: number): string[] {
  const newIds = newStableIds(baseline, finalIds);
  if (newIds.length !== expected) throw new Error(`${label} expected exactly ${expected} new messages, found ${newIds.length}`);
  return newIds;
}

export function claudeOrdinalFromAriaLabel(ariaLabel: string | null): string | undefined {
  const match = ariaLabel?.match(/^Message\s+(\d+)\s+of\s+\d+$/i);
  return match ? `claude:message:${match[1]}` : undefined;
}