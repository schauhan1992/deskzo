/**
 * Phone numbers as iOS's caller ID takes them (owner, 22 Oct 2026): the whole international number as digits —
 * 919876543210 — in ascending order, each once (CallKit's Call Directory refuses anything else).
 *
 * Deskzo keeps a contact's number as somebody typed it. India writes a mobile with or without +91 or a 0 in front,
 * so a number of ten digits — or eleven starting with 0 — is India's; anything else is read only when it says its
 * country (+44…, or 0044…). A number with too few digits to place, like a landline without its area code, is left out
 * rather than guessed.
 */

/** The country a bare national number belongs to — Deskzo is India first. */
export const HOME_COUNTRY = "91";

/** The number as E.164 digits (no "+"), or null when it can't be placed. */
export function internationalDigits(raw: string, homeCountry: string = HOME_COUNTRY): string | null {
  const text = raw.trim();
  if (!text) return null;
  // An extension or a second number written after the first ("…, ext 12", "… / …") is not part of it.
  const first = text.split(/[,;/]|\bext\b|\bx\d/i)[0]!;
  let digits = first.replace(/\D/g, "");
  // "+91 098765 43210": the country, and the 0 India dials within it too — the 0 isn't part of the number.
  if (/^\s*\+/.test(first)) return valid(digits.length === 13 && digits.startsWith("910") ? `91${digits.slice(3)}` : digits);
  if (digits.startsWith("00")) return valid(digits.slice(2));
  if (homeCountry === "91") {
    if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    if (digits.length === 10) return /^[1-9]/.test(digits) ? `91${digits}` : null;
    if (digits.length === 12 && digits.startsWith("91")) return digits;
    if (digits.length === 13 && digits.startsWith("091")) return digits.slice(1);
    return null;
  }
  if (digits.startsWith("0")) digits = digits.slice(1);
  return valid(`${homeCountry}${digits}`);
}

/** E.164 is at most fifteen digits, and no country code starts with 0; fewer than eight is no whole number. */
const valid = (digits: string) => (digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0") ? digits : null);

export type DirectoryEntry = { number: string; label: string };

/** iOS shows a caller-ID label in one line: anything longer is cut, so it is cut here, at a word where it can be. */
export const LABEL_MAX = 60;

function shorten(label: string): string {
  const text = label.replace(/\s+/g, " ").trim();
  if (text.length <= LABEL_MAX) return text;
  const cut = text.slice(0, LABEL_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > LABEL_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * What the Call Directory extension is given: each number placed, once — the first label Deskzo gave it, which is the
 * best match it would pick itself — in ascending numeric order (the extension adds them as 64-bit integers, and iOS
 * throws out the whole list if one is out of order or repeated).
 */
export function directoryEntries(entries: { number: string; label: string }[], homeCountry: string = HOME_COUNTRY): DirectoryEntry[] {
  const byNumber = new Map<string, string>();
  for (const entry of entries) {
    const digits = internationalDigits(entry.number, homeCountry);
    const label = shorten(entry.label ?? "");
    if (!digits || !label || byNumber.has(digits)) continue;
    byNumber.set(digits, label);
  }
  // Same-length digit strings sort as their numbers do; a shorter one is a smaller number.
  return [...byNumber.entries()].sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).map(([number, label]) => ({ number, label }));
}

/** A number for the phone's dialler: digits and a leading +, nothing else. */
export const dialString = (number: string) => number.replace(/[^\d+]/g, "");
