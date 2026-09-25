import { redirect } from "next/navigation";
import { parseSeqQuery } from "@/lib/order-id";

/**
 * Readable URLs for records that carry a display sequence.
 *
 * `/leads/cmu9u5fou04vgufgk6079c8sw` is correct and unreadable. Every one of these records already
 * has a short number people quote at each other — LEAD-000123 — and it is unique, so it can identify
 * the record in a URL just as well as the cuid can.
 *
 * ## Both forms resolve, and that is not a transitional kindness
 *
 * A cuid link has to keep working permanently: they are in bookmarks, in emails, in tickets, and
 * pasted into chats months ago. So the segment is resolved either way, and only the *canonical* form
 * is what the address bar ends up showing.
 *
 * ## Why sequential URLs are safe here
 *
 * A cuid is unguessable; `/leads/2` plainly is not. That matters only where the URL is the
 * authorization, and here it is not: every detail route checks the record against the viewer's
 * account scope and answers `notFound()` when it fails — the same answer as for a record that does
 * not exist. So walking the numbers tells somebody nothing they could not already list, and cannot
 * distinguish "not yours" from "not there".
 */

export type RecordRef = { kind: "seq"; seq: number } | { kind: "id"; id: string };

/**
 * What a URL segment is pointing at.
 *
 * A cuid never parses as a sequence — `parseSeqQuery` wants an optional three-or-four letter prefix
 * and then digits only, while a cuid is lowercase alphanumeric throughout and starts with a letter.
 * So the two forms cannot be confused for one another.
 */
export function parseRecordRef(segment: string): RecordRef {
  const seq = parseSeqQuery(decodeURIComponent(segment));
  return seq === null ? { kind: "id", id: segment } : { kind: "seq", seq };
}

/**
 * Sends a cuid URL to its readable equivalent, once.
 *
 * **Call this after the authorization check, never before.** `redirect` throws to unwind the
 * request, so calling it first would answer a probe for somebody else's record with a tidy redirect
 * to a canonical URL — confirming the record exists, which is exactly what `notFound()` is there to
 * avoid disclosing.
 *
 * A segment that already parses as a sequence is left alone, whether it was typed as `123` or as
 * `LEAD-000123`. Both are readable, and bouncing somebody who typed the short form to the long one
 * is a redirect that buys nothing.
 */
export function canonicalise(
  segment: string,
  basePath: string,
  canonical: string,
  /**
   * The query the request arrived with, carried across the redirect.
   *
   * Not optional in spirit. Every tabbed record page links its tabs as a bare `?tab=leads`, which
   * resolves against whatever segment is in the address bar — so a redirect that rebuilt only the
   * path silently dropped the tab and put people back on the first one. It looked like the tabs
   * were broken; what was broken was the redirect underneath them.
   */
  query?: Record<string, string | string[] | undefined>,
): void {
  if (parseRecordRef(segment).kind === "seq") return;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) for (const v of value) search.append(key, v);
    else if (value !== undefined) search.set(key, value);
  }
  const suffix = search.size > 0 ? `?${search}` : "";
  redirect(`${basePath}/${canonical}${suffix}`);
}
