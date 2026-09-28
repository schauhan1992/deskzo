import type { CommissionBasis } from "@/lib/partners/rates";

/**
 * Small pure helpers for the commission screens — the /commissions page and a partner's Commissions
 * and Statements tabs. Client-safe: nothing from src/lib/partners/** is imported at runtime (types
 * only), so the percent and money parsing the engine does is mirrored here for the dialogs' live
 * previews. The server checks every value again; these only decide what the dialogs show.
 */

export const COMMISSIONS_PATH = "/commissions";

/** Prices are set in these today; any other currency a list holds is added from its rows. */
export const COMMON_CURRENCIES = ["INR", "USD"] as const;

/** The §6.6 note, shown wherever a statement's tax lines are entered or read. */
export const TAX_NOTE = "Tax is not worked out here — see your accountant's rules for TDS, GST and withholding.";

/** Spec §6.6, in short: what the owner's accountant decides, listed under the note. */
export const ACCOUNTANT_POINTS = [
  "India, partner resident: TDS on commission (section 194H) at the rate and threshold in force, on the partner's PAN — higher without one.",
  "India, GST: a registered partner issues a tax invoice for its commission; whether reverse charge applies to an unregistered partner; the SAC code.",
  "Partners abroad: an import of services (IGST under reverse charge), and possibly withholding under section 195 or a tax treaty, with Form 15CA/15CB.",
  "Which document is the record — the statement or the partner's invoice — and keeping it for eight years.",
  "Statements are paid in their own currency; nothing is converted.",
] as const;

/**
 * `path` with `params`, some changed (null or "" removes a key). Unlike `withParams` the paging is
 * kept: opening a statement from page 3 of the list leaves the list on page 3 underneath it.
 */
export function hrefWith(path: string, params: Record<string, string>, changes: Record<string, string | number | null | undefined> = {}): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value && !(key in changes)) out.set(key, value);
  for (const [key, value] of Object.entries(changes)) if (value !== null && value !== undefined && value !== "") out.set(key, String(value));
  const query = out.toString();
  return query ? `${path}?${query}` : path;
}

/** A statement's drawer on the Statements tab, over the list `params` describe. */
export function statementHref(id: string, params: Record<string, string> = {}): string {
  return hrefWith(COMMISSIONS_PATH, { ...params, tab: "statements" }, { statement: id });
}

/** A partner's page. */
export const partnerHref = (slug: string) => `/partners/${encodeURIComponent(slug)}`;

/** Basis points for people: 1250 → "12.5 %", 1500 → "15 %" (as the engine's `bpToPercent`). */
export function bpText(bp: number): string {
  const n = Math.round(Number(bp) || 0);
  const abs = Math.abs(n);
  const cents = abs % 100;
  return `${n < 0 ? "-" : ""}${Math.floor(abs / 100)}${cents ? `.${String(cents).padStart(2, "0").replace(/0$/, "")}` : ""} %`;
}

/** "12.5", "15 %", "0.25" → basis points; null for anything else or outside 0–100 (as the engine's `percentToBp`). */
export function percentToBp(input: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(input ?? "").trim().replace(/\s*%$/, ""));
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bp >= 0 && bp <= 10_000 ? bp : null;
}

/** Decimal places of a currency's amounts: 2 for INR and USD, 0 for JPY. */
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * An amount typed in the currency's main unit ("1,499.50", "-250") → minor units, exactly (no
 * floating point: 0.1 + 0.2 must not become 30 paise and a bit). Null when it is not a number, has
 * more decimals than the currency has, or is negative where only a positive amount makes sense.
 */
export function toMinor(text: string, currency: string, opts: { signed?: boolean } = {}): number | null {
  const clean = String(text ?? "").replace(/[\s,]/g, "");
  const match = /^(-?)(\d{1,12})(?:\.(\d+))?$/.exec(clean);
  if (!match) return null;
  if (match[1] === "-" && !opts.signed) return null;
  const digits = minorDigits(currency);
  const fraction = match[3] ?? "";
  if (fraction.length > digits) return null;
  const value = Number(match[2]) * 10 ** digits + (digits ? Number(fraction.padEnd(digits, "0")) : 0);
  if (!Number.isSafeInteger(value)) return null;
  return match[1] === "-" ? -value : value;
}

/** `floor(total × rateBp / 10000)` without leaving safe integers — how the engine prices a rate-only tax line. */
export function rateAmount(total: number, rateBp: number): number {
  if (total <= 0 || rateBp <= 0) return 0;
  const whole = Math.floor(total / 10_000);
  const rest = total % 10_000;
  return whole * rateBp + Math.floor((rest * rateBp) / 10_000);
}

/** The currencies a picker offers: the common ones, then any the data holds, each once, sorted. */
export function currencyOptions(...lists: (readonly (string | null | undefined)[])[]): string[] {
  const all = new Set<string>(COMMON_CURRENCIES);
  for (const list of lists) for (const c of list) if (c && /^[A-Z]{3}$/.test(c)) all.add(c);
  return [...all].sort();
}

/** The last `count` IST months ending with `latest` ("2026-09"), newest first — the Period filter's choices. */
export function recentPeriods(latest: string, count = 12): string[] {
  const match = /^(\d{4})-(\d{2})$/.exec(latest);
  if (!match) return [];
  let year = Number(match[1]);
  let month = Number(match[2]);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}

const REVERSAL_REASON: Record<"refund" | "credit" | "void", string> = { refund: "Refund", credit: "Credit note", void: "Invoice voided" };

/** One line of how an entry was worked out, for staff (spec §5.8): the phase and what set the rate. */
export function basisLine(basis: CommissionBasis | null, note: string | null): string | null {
  if (!basis) return note;
  if (basis.type === "adjustment") return note;
  if (basis.type === "reversal") return `${REVERSAL_REASON[basis.reason] ?? "Taken back"} — takes back part of an entry`;
  if (basis.type === "override") return `Distributor override at ${bpText(basis.rateBp)}`;
  const by = [...new Set(basis.lines.map((l) => l.by))];
  const how = by.length === 1 ? { plan: "plan rate", country: "country rate", phase: basis.phase === "NEW" ? "new-customer rate" : "renewal rate", default: "default rate", territory: "territory rate" }[by[0]!] : "mixed rates";
  return `${basis.phase === "NEW" ? "New customer" : "Renewal"} · ${how}`;
}
