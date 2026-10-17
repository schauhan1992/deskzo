import { compare } from "@/lib/automate/conditions";
import type { Filter, RuleOp } from "@/lib/automate/definition";
import { resolveValue, type RunContext } from "@/lib/automate/references";

/**
 * A run waiting for an event (Deskzo Automate, Phase 6 — wait-for-event). Pure.
 *
 * When the wait begins, its rules' values are worked out from the run — "event.task.id equals
 * {{steps.kickoff.output.taskId}}" becomes "equals tsk_123" — and kept with the wait. An event of the
 * kind waited for then meets them or not, read as it came, without anything in it being read as a
 * reference: a value somebody typed into a record never becomes one.
 */

export type WaitRule = { ref: string; op: RuleOp; value: unknown };

/** The step's rules with their values fixed from the run, and whether any one is enough. */
export function fixRules(filter: Filter | undefined, context: RunContext): { rules: WaitRule[]; any: boolean } {
  if (!filter) return { rules: [], any: false };
  const rules = "all" in filter ? filter.all : filter.any;
  return { rules: rules.map((r) => ({ ref: r.ref, op: r.op, value: resolveValue(r.value, context) })), any: "any" in filter };
}

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** The value at "event.a.b" in an event's payload, or undefined. */
export function readEvent(payload: unknown, ref: string): unknown {
  const parts = ref.split(".");
  if (parts[0] !== "event" || parts.some((p) => FORBIDDEN.has(p))) return undefined;
  let value: unknown = payload;
  for (const part of parts.slice(1)) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Whether an event's payload meets a wait's rules. No rules: any event of the kind will do. */
export function eventMeets(payload: unknown, rules: WaitRule[], any: boolean): boolean {
  if (!rules.length) return true;
  const holds = (rule: WaitRule) => compare(rule.op, readEvent(payload, rule.ref), rule.value);
  return any ? rules.some(holds) : rules.every(holds);
}
