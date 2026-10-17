/**
 * How a workflow reads data (Deskzo Automate): `{{trigger.…}}` for what started it and
 * `{{steps.<id>.output.…}}` for what an earlier step made. Pure.
 *
 *   · A string that is exactly one reference becomes that value, whatever its type — so an id stays an
 *     id and a number a number.
 *   · A reference inside other text is written into it; nothing found writes nothing.
 *   · Only own properties are read, and never `__proto__`, `constructor` or `prototype`.
 */

export type RunContext = {
  trigger: Record<string, unknown>;
  /** `failed`: why a step failed, in a workflow that carries on past failures. Never read by a reference. */
  steps: Record<string, { output: unknown; failed?: string }>;
  /** A test run's own: the draft it tests (it has no version), and whether its safe steps really run. */
  test?: { definition?: unknown; live?: boolean };
};

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const PATH = /^(trigger|steps)(\.[A-Za-z0-9_-]+)*$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** Whether a reference is well formed: `trigger.a.b` or `steps.<id>.output.a`. */
export function isReference(path: string): boolean {
  if (!PATH.test(path)) return false;
  const parts = path.split(".");
  if (parts.some((p) => FORBIDDEN.has(p))) return false;
  return parts[0] === "trigger" || (parts.length >= 3 && parts[2] === "output");
}

/** The value at a reference, or undefined. */
export function readPath(context: RunContext, path: string): unknown {
  if (!isReference(path)) return undefined;
  let value: unknown = context;
  for (const part of path.split(".")) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Every reference in a value, deep — strings, arrays and objects. */
export function referencesIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    for (const m of value.matchAll(TEMPLATE)) out.push(m[1]!.trim());
  } else if (Array.isArray(value)) {
    for (const item of value) referencesIn(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) referencesIn(item, out);
  }
  return out;
}

/** Whether a value is a template — a string with a reference in it. */
export function isTemplate(value: unknown): boolean {
  return typeof value === "string" && /\{\{[^{}]+\}\}/.test(value);
}

/**
 * A value with its references filled in from the run, deep. Something in braces that isn't a reference —
 * an action's own merge field, {{document.number}} — is left as typed, for the action to fill.
 */
export function resolveValue(value: unknown, context: RunContext): unknown {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    if (whole) return isReference(whole[1]!.trim()) ? readPath(context, whole[1]!.trim()) : value;
    return value.replace(TEMPLATE, (typed, path: string) => (isReference(path.trim()) ? asText(readPath(context, path.trim())) : typed));
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, context));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN.has(key)) continue;
      out[key] = resolveValue(item, context);
    }
    return out;
  }
  return value;
}
