/**
 * What a new workspace may be called — its address, `<name>.<PLATFORM_DOMAIN>`. Pure: the signup
 * form's live hint, the signup action, provisioning and the checks share it.
 *
 * Every new workspace, whoever makes it — signup, staff, a script (`slugProblem` in provisioning.ts):
 *   · the address pattern, and none of the platform's reserved subdomains (src/lib/tenancy/host.ts);
 *   · never one that carries our name or a competitor's, so no workspace can pass itself off as
 *     either: our names anywhere in it ("deskzo-support"), a competitor's as a whole word of it
 *     ("zoho-india", "tallysolutions") — not inside another word, so "digitallyyours" is fine.
 *
 * A business signing itself up, as well (owner decisions, 1 Oct 2026):
 *   · at least eight letters or digits;
 *   · made from its registered business name: the name's letters in order, starting at one of its
 *     words and running on without skipping — for "Acme Technologies Pvt Ltd": acmetechnologies,
 *     acme-technologies, acmetech, technologies; never techacme, acme-tech-ltd-india or bestcrm. A
 *     hyphen may only stand where the name has a break between words. It may not start on "Pvt",
 *     "Ltd" or another word that only says what kind of company it is.
 *
 * A name these refuse can still be given by staff, who set up workspaces outside signup.
 */

export const MIN_SIGNUP_NAME = 8;

/** Ours: refused anywhere in an address. Distinctive enough never to sit inside an ordinary word. */
const OUR_NAMES = ["deskzo", "wroffy"] as const;

/** Competitors': refused as a word of the address (between hyphens, or how it starts). */
const COMPETITOR_NAMES = ["zoho", "tally", "odoo", "salesforce", "hubspot", "freshworks", "freshdesk", "freshsales", "pipedrive", "netsuite", "quickbooks"] as const;

/** Words that say what kind of company it is, not which: an address can't start on one. */
const COMPANY_KIND_WORDS = new Set([
  "private", "pvt", "pvtltd", "limited", "ltd", "llp", "llc", "inc", "incorporated", "corp", "corporation", "co", "company",
  "plc", "gmbh", "ag", "sa", "bv", "pte", "sdn", "bhd", "opc", "pty", "the", "and", "of", "m", "s",
]);

/** The words of a registered name — accents dropped, "&" read as "and" or as nothing (both are tried). */
export function legalNameWords(legalName: string): string[][] {
  const base = String(legalName ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  const words = (text: string) => text.replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const withAnd = words(base.replace(/&/g, " and "));
  const without = words(base.replace(/&/g, ""));
  return withAnd.join(" ") === without.join(" ") ? [withAnd] : [withAnd, without];
}

/** Whether `slug` is the name's letters in order from the start of one of its (meaningful) words. */
function builtFrom(slug: string, words: string[]): boolean {
  const parts = slug.split("-");
  const letters = parts.join("");
  const joined = words.join("");
  // Where each word starts in the run of letters — the only places a hyphen, or the address, may start.
  const starts: number[] = [];
  let at = 0;
  for (const w of words) {
    starts.push(at);
    at += w.length;
  }
  const breaks = new Set([...starts, joined.length]);
  return words.some((word, i) => {
    // "The" may start one (theindianhotels); what kind of company it is may not (pvtltd…).
    if (COMPANY_KIND_WORDS.has(word) && word !== "the") return false;
    const from = starts[i]!;
    if (!joined.startsWith(letters, from)) return false;
    let cut = from;
    for (const part of parts.slice(0, -1)) {
      cut += part.length;
      if (!breaks.has(cut)) return false;
    }
    return true;
  });
}

/** Our name, or a competitor's, carried by an address; null when it carries neither. */
export function protectedNameIn(slug: string): string | null {
  const s = slug.toLowerCase();
  const ours = OUR_NAMES.find((n) => s.replace(/-/g, "").includes(n));
  if (ours) return ours;
  const parts = s.split("-");
  return COMPETITOR_NAMES.find((n) => parts.includes(n) || s.startsWith(n)) ?? null;
}

/** An address made from the registered name, for the form to offer: its words, as many as fit in 40. */
export function suggestedName(legalName: string): string {
  const words = legalNameWords(legalName)[0]!;
  const firstReal = words.findIndex((w) => !COMPANY_KIND_WORDS.has(w));
  if (firstReal < 0) return "";
  const meaningful = words.slice(firstReal);
  // The name without what kind of company it is ("Acme Technologies", not "… Pvt Ltd") — unless that
  // is too short to be an address, when the rest is kept.
  let end = meaningful.length;
  while (end > 1 && COMPANY_KIND_WORDS.has(meaningful[end - 1]!)) end -= 1;
  const core = meaningful.slice(0, end).join("");
  const name = core.length >= MIN_SIGNUP_NAME ? core : meaningful.join("");
  return name.slice(0, 40).replace(/-+$/, "");
}

/**
 * Why a business signing itself up can't have this address, in words for the form; null when it
 * can. Run after the general checks (pattern, reserved, taken) — this is only what signup adds.
 */
export function signupNameProblem(slug: string, legalName: string): string | null {
  const s = slug.trim().toLowerCase();
  const letters = s.replace(/-/g, "");
  const variants = legalNameWords(legalName);
  if (!variants[0]!.length) return "Give your registered business name first — your address is made from it.";
  const tooShort = `Your registered business name is too short for an address of ${MIN_SIGNUP_NAME} letters. Contact us and we'll set your workspace up.`;
  // However it is cut, the name gives fewer than eight letters: nothing typed could pass.
  if (Math.max(...variants.map((w) => w.join("").length)) < MIN_SIGNUP_NAME) return tooShort;
  if (letters.length < MIN_SIGNUP_NAME) return `Use at least ${MIN_SIGNUP_NAME} letters or digits.`;
  if (variants.some((words) => builtFrom(s, words))) return null;
  const example = suggestedName(legalName);
  return example.replace(/-/g, "").length >= MIN_SIGNUP_NAME ? `Your address must come from your registered business name, in order — for example ${example}.` : tooShort;
}
