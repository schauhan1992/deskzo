import { BASE_CURRENCY, getCurrency, isBaseCurrency } from "@/lib/currency";

/**
 * Looking up what a currency was worth on a given day.
 *
 * ## What this is allowed to do, and what it is not
 *
 * It calls a third party. The only thing that leaves is a currency code and a date — no customer,
 * no amount, nothing about the document being written — but it is still an outbound request from
 * the server, and it is worth being explicit that the feature works without it. Every failure path
 * returns a reason and the form falls back to the field somebody types in. A rate is a commercial
 * fact the two parties agreed; a lookup is a convenience for finding it, never the authority on it.
 *
 * Called from the server, never the browser. A client-side fetch would hand the customer's IP to a
 * provider nobody chose and put the call outside anything the organisation can see or police.
 *
 * ## Why not the ECB
 *
 * The obvious source is the European Central Bank's daily reference rates: free, reputable, no
 * account. It publishes about thirty currencies and **the dirham and the riyal are not among them**
 * — both are pegged to the dollar, so there is no market rate for the ECB to observe. For a
 * business selling into the Gulf that is the wrong thirty currencies to have.
 *
 * So this uses a dataset that covers the pegged ones too, served from a CDN with a documented
 * mirror. It is indicative rather than authoritative, which is the right standing for a figure that
 * is overridable by design.
 *
 * ## Why the date matters
 *
 * The rate wanted is the one on the day the document is dated, not today's. Quoting in March and
 * reopening the quote in September must not change what it was worth — and for a back-dated invoice
 * the correct rate is the historical one, because that is what the books will be reconciled against.
 */

const SOURCE = "Daily FX reference data";

/**
 * Primary and mirror, in that order.
 *
 * The provider documents the second as a fallback for exactly this reason: one CDN having a bad
 * day should not stop a quote going out. Both serve the same dataset.
 */
const ENDPOINTS = [
  (date: string, code: string) =>
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/${code}.json`,
  (date: string, code: string) => `https://${date}.currency-api.pages.dev/v1/currencies/${code}.json`,
];

/**
 * Rates for a past date never change, so this only ever grows stale in the sense of being dropped.
 *
 * In memory rather than a table: the cost of a miss is one HTTP request, which does not justify a
 * migration, and a restart re-fetching a handful of rates is not a problem worth solving.
 */
const cache = new Map<string, { rate: number; source: string; onDate: string } | null>();

export type RateLookup =
  | { ok: true; rate: number; source: string; onDate: string }
  | { ok: false; reason: string };

async function readOne(date: string, code: string): Promise<{ rate: number; onDate: string } | null> {
  for (const build of ENDPOINTS) {
    try {
      // Aborted rather than left hanging: a form waiting on somebody else's server is a form that
      // looks broken, and the manual field is right there.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(build(date, code), { signal: controller.signal, headers: { accept: "application/json" } });
      clearTimeout(timer);
      if (!res.ok) continue;

      const body = (await res.json()) as { date?: string; [k: string]: unknown };
      const table = body[code] as Record<string, number> | undefined;
      const rate = table?.[BASE_CURRENCY.toLowerCase()];
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) continue;

      // The payload says which day it is actually for, which is not always the day asked for —
      // a weekend or a holiday returns the last publication. Reporting the requested date would be
      // claiming a precision the number does not have.
      return { rate: Math.round(rate * 10000) / 10000, onDate: body.date ?? date };
    } catch {
      // Offline, blocked, slow, or this endpoint is down. Try the mirror, then give up quietly.
    }
  }
  return null;
}

/**
 * What one unit of `code` was worth in rupees on `onDate`.
 *
 * Returns rupees-per-unit, which is the direction people quote and the direction the document
 * stores. The provider is asked the same way round so there is no inversion to get wrong.
 */
export async function lookupRate(code: string, onDate: string): Promise<RateLookup> {
  if (isBaseCurrency(code)) return { ok: false, reason: "A rupee document does not need a rate." };
  if (getCurrency(code).code !== code) return { ok: false, reason: "That currency isn't one we handle." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(onDate)) return { ok: false, reason: "That date isn't valid." };

  const key = `${onDate}:${code}`;
  if (cache.has(key)) {
    const hit = cache.get(key)!;
    return hit ? { ok: true, ...hit } : { ok: false, reason: `No rate published for ${code} on that date.` };
  }

  const lower = code.toLowerCase();
  // The dated dataset first. "latest" second, because a document dated today is often ahead of the
  // day's publication, and a rate from yesterday is far more useful than none — it says which day
  // it came from, so nobody is misled about what they are looking at.
  const found = (await readOne(onDate, lower)) ?? (await readOne("latest", lower));

  if (!found) {
    cache.set(key, null);
    return { ok: false, reason: `Couldn't find a rate for ${code} on that date. Enter the rate you agreed.` };
  }

  const hit = { rate: found.rate, source: SOURCE, onDate: found.onDate };
  cache.set(key, hit);
  return { ok: true, ...hit };
}
