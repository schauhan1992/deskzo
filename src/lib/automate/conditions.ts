import type { Filter, Rule, RuleOp } from "@/lib/automate/definition";
import { readPath, resolveValue, type RunContext } from "@/lib/automate/references";

/**
 * Whether a condition holds (Deskzo Automate). Pure. `all` needs every rule, `any` one of them; an
 * empty `all` holds and an empty `any` doesn't.
 *
 * Comparisons are forgiving the way a person means them: "5" equals 5, text compares without case,
 * and dates compare as dates when both sides read as one.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T|$)/;

function empty(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && ISO_DATE.test(value)) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function same(a: unknown, b: unknown): boolean {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na === nb;
  const ta = asTime(a);
  const tb = asTime(b);
  if (ta !== null && tb !== null) return ta === tb;
  if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b);
  if (empty(a) && empty(b)) return true;
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

/** -1, 0 or 1, or null when the two can't be ordered. */
function order(a: unknown, b: unknown): number | null {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return Math.sign(na - nb);
  const ta = asTime(a);
  const tb = asTime(b);
  if (ta !== null && tb !== null) return Math.sign(ta - tb);
  return null;
}

function contains(haystack: unknown, needle: unknown): boolean {
  if (Array.isArray(haystack)) return haystack.some((item) => same(item, needle));
  if (typeof haystack === "string") return haystack.toLowerCase().includes(String(needle ?? "").toLowerCase());
  return false;
}

export function ruleHolds(rule: Rule, context: RunContext): boolean {
  return compare(rule.op, readPath(context, rule.ref), resolveValue(rule.value, context));
}

/** One comparison, the way a rule makes it — also how a waiting run's rules meet an event (src/lib/automate/waits.ts). */
export function compare(op: RuleOp, left: unknown, right: unknown): boolean {
  switch (op) {
    case "eq":
      return same(left, right);
    case "ne":
      return !same(left, right);
    case "gt":
      return order(left, right) === 1;
    case "gte":
      return [0, 1].includes(order(left, right) ?? -2);
    case "lt":
      return order(left, right) === -1;
    case "lte":
      return [0, -1].includes(order(left, right) ?? 2);
    case "in":
      return Array.isArray(right) && right.some((item) => same(left, item));
    case "notIn":
      return Array.isArray(right) && !right.some((item) => same(left, item));
    case "contains":
      return contains(left, right);
    case "notContains":
      return !contains(left, right);
    case "isEmpty":
      return empty(left);
    case "isNotEmpty":
      return !empty(left);
  }
}

export function filterHolds(filter: Filter | undefined, context: RunContext): boolean {
  if (!filter) return true;
  if ("all" in filter) return filter.all.every((rule) => ruleHolds(rule, context));
  return filter.any.some((rule) => ruleHolds(rule, context));
}
