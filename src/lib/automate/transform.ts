import type { TransformExpr } from "@/lib/automate/definition";
import { resolveValue, type RunContext } from "@/lib/automate/references";
import type { Clock } from "@/lib/time/zone";

/**
 * The fixed functions a transform step may use (Deskzo Automate) — all a workflow can compute. No
 * expressions and no code: a function name and its arguments, each argument a value or a reference.
 * Pure. A function given the wrong kind of value gives null rather than failing the run.
 */

const DAY_MS = 86_400_000;

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function time(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function applyTransform(expr: TransformExpr, context: RunContext, clock: Clock): unknown {
  const args = expr.args.map((arg) => resolveValue(arg, context));
  const [a, b, c] = args;
  switch (expr.fn) {
    case "text.upper":
      return text(a).toUpperCase();
    case "text.lower":
      return text(a).toLowerCase();
    case "text.trim":
      return text(a).trim();
    case "text.join":
      return args.map(text).join("");
    case "text.slice": {
      const start = num(b) ?? 0;
      const end = num(c);
      return end === null ? text(a).slice(start) : text(a).slice(start, end);
    }
    case "number.add": {
      const x = num(a);
      const y = num(b);
      return x === null || y === null ? null : x + y;
    }
    case "number.subtract": {
      const x = num(a);
      const y = num(b);
      return x === null || y === null ? null : x - y;
    }
    case "number.multiply": {
      const x = num(a);
      const y = num(b);
      return x === null || y === null ? null : x * y;
    }
    case "number.round": {
      const x = num(a);
      const digits = Math.min(Math.max(num(b) ?? 0, 0), 6);
      return x === null ? null : Math.round(x * 10 ** digits) / 10 ** digits;
    }
    case "date.addDays": {
      const t = time(a);
      const days = num(b);
      return t === null || days === null ? null : new Date(t + days * DAY_MS).toISOString();
    }
    case "date.day": {
      // The calendar day here, "yyyy-mm-dd" — what a due date or a report's day is.
      const t = time(a);
      return t === null ? null : clock.dateKey(new Date(t));
    }
    case "value.default":
      return a === null || a === undefined || a === "" ? b : a;
  }
}
