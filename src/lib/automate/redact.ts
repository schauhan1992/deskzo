import { redactSecrets } from "@/lib/console-shared/redact";

/**
 * What run history shows of a step's input and output (Deskzo Automate). Pure. The full values stay
 * in the run's encrypted context; this is a short, safe picture of them:
 *
 *   · a field whose name says it is secret (password, token, secret, key, otp, pin) shows as ••••;
 *   · text has credentials and keys masked (`redactSecrets`), and is cut at 160 characters;
 *   · lists show their first ten items, and nesting stops three levels down.
 */

const SECRET_NAME = /(pass(word)?|secret|token|api[_-]?key|private[_-]?key|authorization|otp|\bpin\b|cvv)/i;
const MAX_TEXT = 160;
const MAX_ITEMS = 10;
const MAX_DEPTH = 3;

export function summarize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    const masked = redactSecrets(value) ?? "";
    return masked.length > MAX_TEXT ? `${masked.slice(0, MAX_TEXT)}…` : masked;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[${value.length} items]` : "{…}";
  if (Array.isArray(value)) {
    const shown = value.slice(0, MAX_ITEMS).map((item) => summarize(item, depth + 1));
    return value.length > MAX_ITEMS ? [...shown, `…and ${value.length - MAX_ITEMS} more`] : shown;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_NAME.test(key) ? "••••" : summarize(item, depth + 1);
    }
    return out;
  }
  return String(value);
}
