/**
 * A page inside the workspace for the Deskzo app's pages to land on (src/lib/app/web-session.ts): an absolute
 * path, nothing that leaves the workspace, and nothing that signs in again. Null for anything else.
 */
export function safeAppPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  // One leading slash: "//host" and "/\host" are other sites to a browser, which reads a backslash as a slash.
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if ([...value].some((ch) => ch === "\\" || ch.charCodeAt(0) <= 32 || ch.charCodeAt(0) === 127)) return null;
  if (/^\/(api|handoff|login|switch|link)(\/|\?|#|$)/.test(value)) return null;
  return value;
}
