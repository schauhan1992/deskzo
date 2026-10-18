/**
 * Outside data turned into text without ever throwing (Deskzo Automate, Phase 8). A webhook body or an
 * API's answer is anybody's JSON: `String()` throws on `{"toString": 1}`, and `JSON.stringify` on data
 * nested a few thousand deep. Either, thrown from a condition or a checkpoint, stopped a workspace's
 * whole turn — so what comes in nested deeper than `MAX_NESTING` is refused or kept as text, and what
 * is turned into text goes through `safeText`.
 */

/** Deeper than this, data from outside is refused (a webhook) or kept as text (an answer). */
export const MAX_NESTING = 64;

/** Whether JSON-like data nests deeper than `limit` — counted without recursion, so it can't overflow either. */
export function nestsDeeperThan(value: unknown, limit = MAX_NESTING): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (item === null || typeof item !== "object") continue;
    if (depth > limit) return true;
    for (const child of Array.isArray(item) ? item : Object.values(item as Record<string, unknown>)) {
      if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  return false;
}

/** Any value as text: objects as JSON, never throwing — one that can't be written reads as a placeholder. */
export function safeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[data too deeply nested to show]";
  }
}
