import type { VisitorPurpose } from "@prisma/client";

/**
 * Matching one company name against another.
 *
 * The whole value of keeping a visitor-company list is that the fourth person from Northwind picks
 * the existing row instead of adding a fifth spelling of it. That depends entirely on this
 * function, and it fails silently: a normaliser that is too loose merges two genuinely different
 * firms, one that is too strict quietly grows "Acme Ltd", "Acme Ltd.", "ACME Limited" and "acme".
 */

/**
 * The suffixes that carry no distinguishing information.
 *
 * Deliberately short. Every entry here is a pair of companies that can no longer be told apart, so
 * it holds only the forms that are genuinely interchangeable — `Ltd`/`Limited`, `Pvt`/`Private`.
 * Nothing that could be part of a real name: "Industries" and "Solutions" stay, because "Sharma
 * Industries" and "Sharma Solutions" are two businesses.
 */
const SUFFIXES = [
  "private limited", "pvt ltd", "pvt limited", "private ltd",
  "limited", "ltd", "llp", "inc", "incorporated", "corp", "corporation", "co",
  "gmbh", "sa", "bv", "plc", "llc",
];

/**
 * The form two spellings of the same company share.
 *
 * Lowercased, punctuation dropped, whitespace collapsed, and a trailing legal suffix removed — but
 * only a trailing one, and only if something is left. "Ltd" on its own stays "ltd" rather than
 * becoming the empty string and colliding with every other name that normalises to nothing.
 */
export function normaliseCompany(input: string): string {
  let out = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Repeatedly, so "Acme Pvt Ltd" loses both halves rather than only the last one.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of SUFFIXES) {
      if (out.endsWith(` ${suffix}`)) {
        const shorter = out.slice(0, -(suffix.length + 1)).trim();
        if (shorter.length > 0) {
          out = shorter;
          changed = true;
          break;
        }
      }
    }
  }
  return out;
}

/** Whether what somebody typed is enough to be a company at all. */
export function isUsableCompany(input: string): boolean {
  return normaliseCompany(input).length >= 2;
}

/**
 * The shortest query worth answering from a public tablet.
 *
 * One character would return a large slice of the list per keystroke, which is enumeration with
 * extra steps. Two is short enough to be useful the moment somebody starts typing and long enough
 * that walking the whole list takes far more requests than the desk's rate limit allows.
 */
export const MIN_COMPANY_QUERY = 2;
export const MAX_COMPANY_RESULTS = 8;

/**
 * An email that could plausibly reach somebody.
 *
 * Deliberately loose. A tight regex rejects real addresses, and the cost of accepting a bad one at
 * a reception desk is an email nobody reads — while the cost of rejecting a good one is a visitor
 * standing at a tablet that will not let them in.
 */
export function looksLikeEmail(input: string): boolean {
  const trimmed = input.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed) && trimmed.length <= 254;
}

/**
 * Whether this visitor has to give an email address.
 *
 * Everybody except a courier. A delivery driver has a company — Blue Dart, Delhivery — and will
 * give you a phone number, but has no reason to hand over an email address and no intention of
 * doing so. Demanding one produces `a@a.com` typed forty times a week, which is worse than an empty
 * column: it looks like data.
 *
 * The company is still required of them, because that one they will answer honestly and it is the
 * thing you actually want to know about a stranger at the door.
 */
export function emailRequiredFor(purpose: VisitorPurpose): boolean {
  return purpose !== "DELIVERY";
}
