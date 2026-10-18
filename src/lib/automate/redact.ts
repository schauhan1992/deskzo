import { redactSecrets } from "@/lib/console-shared/redact";
import { safeText } from "@/lib/automate/safe-text";

/**
 * What run history shows of a step's input and output (Deskzo Automate). Pure. The full values stay
 * in the run's encrypted context; this is a short, safe picture of them:
 *
 *   · a field whose name says it is secret (password, token, secret, key, signature, cookie, otp, pin)
 *     shows as ••••;
 *   · text has credentials and keys masked (`redactSecrets`, and `maskStepText`: secret-named query
 *     values, Slack and Teams hook addresses), and is cut at 160 characters;
 *   · lists show their first ten items, and nesting stops three levels down.
 */

const SECRET_NAME = /(pass(word)?|secret|token|api[_-]?key|private[_-]?key|\bkey\b|authorization|cookie|sig(nature)?\b|credential|otp|\bpin\b|cvv)/i;

/** A query value whose name says it is secret: ?token=…, &sig=…, ?api_key=… */
const SECRET_QUERY = /([?&](?:[a-z0-9_.-]*(?:token|secret|key|sig|signature|password|passwd|auth|code|credential)[a-z0-9_.-]*))=([^&#\s"']+)/gi;
/** An incoming-webhook address is its own secret: Slack's path, Teams' and Office's signed paths. */
const HOOK_ADDRESS = /(https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)[^\s"'?#]+/gi;

/**
 * Text from a step — an error, an answer, an address — with what Automate knows is secret masked, on
 * top of `redactSecrets`. What run history stores and shows; the full text stays in the encrypted context.
 */
export function maskStepText(text: string): string {
  return (redactSecrets(text) ?? "").replace(SECRET_QUERY, "$1=•••").replace(HOOK_ADDRESS, "$1•••");
}
const MAX_TEXT = 160;
const MAX_ITEMS = 10;
const MAX_DEPTH = 3;

export function summarize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    const masked = maskStepText(value);
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
  return safeText(value);
}
