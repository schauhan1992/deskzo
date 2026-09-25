/**
 * Finding companies that are probably the same one entered twice — "Xyz Technologies Pvt Ltd" and
 * "XYZ Companies", two records with one GSTIN. No database in here.
 *
 * ## What counts
 *
 *   · the same GSTIN on any of their addresses, or the same PAN (a GSTIN carries its PAN inside it) —
 *     strong, because a registration number is not a matter of spelling;
 *   · the same name once the words every company has are set aside — Pvt, Ltd, Technologies,
 *     Solutions, India… — strong;
 *   · names nearly the same (a typo, a missing letter) — likely;
 *   · a business email domain or a phone number in common — likely.
 *
 * Only companies of the same kind are compared: a customer and a vendor with one name are two
 * relationships with one business, not a duplicate, and they can't be merged anyway.
 *
 * ## Staying fast
 *
 * Every company isn't compared with every other. Companies are grouped by each signal — core name,
 * its first letters, GSTIN, PAN, domain, phone — and only companies sharing a group are compared, so
 * two thousand companies is a few thousand comparisons rather than two million.
 */

/** Words that say what kind of company it is, not which one. */
const NOISE = new Set([
  "pvt", "private", "ltd", "limited", "llp", "llc", "inc", "incorporated", "co", "company", "companies", "corp",
  "corporation", "plc", "opc", "the", "and", "of", "india", "indian", "technologies", "technology", "tech", "techno",
  "solutions", "solution", "services", "service", "systems", "system", "enterprises", "enterprise", "industries",
  "industry", "infotech", "infosystems", "software", "softwares", "consultancy", "consulting",
  "consultants", "international", "intl", "global", "group", "trading", "traders", "networks", "network",
  "computers", "computer", "it", "infra", "infrastructure", "associates", "ventures", "labs", "digital",
]);

/** The part of a name that says which company it is: "Xyz Technologies Pvt. Ltd." → "xyz". */
export function coreName(name: string): string {
  const tokens = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !NOISE.has(t));
  // A name made only of such words ("Tech Solutions Pvt Ltd") keeps them, rather than matching
  // every other company with the same vague name.
  if (tokens.length === 0) return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return tokens.join(" ");
}

/** 0 to 1: how alike two strings are, by edit distance. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = temp;
    }
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The PAN inside a GSTIN (characters 3 to 12), or null when it isn't one. */
export function panFromGstin(gstin: string): string | null {
  const g = gstin.trim().toUpperCase();
  return GSTIN.test(g) ? g.slice(2, 12) : null;
}

/** The last ten digits of a phone number — how India writes a mobile with or without +91 or 0. */
export function phoneKey(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** "https://www.Acme.co.in/about" → "acme.co.in". */
export function domainOf(value: string): string | null {
  const v = value.trim().toLowerCase();
  const host = v.includes("@") ? v.split("@").pop()! : v.replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0]!;
  const clean = host.replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean) ? clean : null;
}

/**
 * Which module owns a company. Each is its own directory and records don't move between them, so a
 * duplicate is only ever looked for — and a merge only allowed — inside one.
 */
export function companyFamily(type: string): "client" | "reseller" | "vendor" | "commission-party" {
  if (type === "CLIENT") return "client";
  if (type === "RESELLER") return "reseller";
  if (type === "COMMISSION_PARTY") return "commission-party";
  return "vendor";
}

export const FAMILY_LABELS: Record<ReturnType<typeof companyFamily>, string> = {
  client: "customer",
  reseller: "reseller",
  vendor: "vendor",
  "commission-party": "commission party",
};

export type DuplicateCandidate = {
  id: string;
  name: string;
  /** client, reseller, vendor or commission party — only the same family is compared. */
  family: string;
  managedByResellerId: string | null;
  gstins: string[];
  pan: string | null;
  /** Business domains only — free mailboxes are left out before this. */
  domains: string[];
  phones: string[];
};

export type DuplicatePair = { aId: string; bId: string; strength: "strong" | "likely"; reasons: string[] };

/** A pair's key, the same whichever way round — as the dismissals are stored. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

const BIG_GROUP = 40;

export function duplicatePairs(companies: DuplicateCandidate[], dismissed: Set<string> = new Set()): DuplicatePair[] {
  const cores = new Map(companies.map((c) => [c.id, coreName(c.name)]));
  const groups = new Map<string, DuplicateCandidate[]>();
  const add = (key: string, c: DuplicateCandidate) => {
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  };
  for (const c of companies) {
    const core = cores.get(c.id)!;
    add(`core:${core}`, c);
    if (core.length >= 4) add(`prefix:${core.slice(0, 4)}`, c);
    for (const g of c.gstins) add(`gstin:${g.toUpperCase()}`, c);
    const pans = new Set([c.pan, ...c.gstins.map(panFromGstin)].filter((p): p is string => !!p).map((p) => p.toUpperCase()));
    for (const p of pans) add(`pan:${p}`, c);
    for (const d of c.domains) add(`domain:${d}`, c);
    for (const p of c.phones) add(`phone:${p}`, c);
  }

  const found = new Map<string, DuplicatePair>();
  const note = (a: DuplicateCandidate, b: DuplicateCandidate, reason: string, strong: boolean) => {
    if (a.id === b.id || a.family !== b.family || a.managedByResellerId !== b.managedByResellerId) return;
    const key = pairKey(a.id, b.id);
    if (dismissed.has(key)) return;
    const [aId, bId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    const pair = found.get(key) ?? { aId, bId, strength: "likely" as const, reasons: [] };
    if (!pair.reasons.includes(reason)) pair.reasons.push(reason);
    if (strong) pair.strength = "strong";
    found.set(key, pair);
  };

  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const [kind, value] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    // A signal half the book shares — one shared switchboard number — identifies nobody.
    if (members.length > BIG_GROUP && kind !== "gstin" && kind !== "pan") continue;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i]!;
        const b = members[j]!;
        if (kind === "gstin") note(a, b, `Same GSTIN ${value}`, true);
        else if (kind === "pan") note(a, b, `Same PAN ${value}`, true);
        else if (kind === "core") note(a, b, "Same name once Pvt, Ltd and the like are set aside", true);
        else if (kind === "domain") note(a, b, `Same email domain ${value}`, false);
        else if (kind === "phone") note(a, b, `Same phone number …${value.slice(-4)}`, false);
        else if (kind === "prefix") {
          const ca = cores.get(a.id)!;
          const cb = cores.get(b.id)!;
          if (ca !== cb && similarity(ca, cb) >= 0.85) note(a, b, "Names nearly the same", false);
        }
      }
    }
  }

  // A shared GSTIN already says they share its PAN.
  for (const pair of found.values()) {
    if (pair.reasons.some((r) => r.startsWith("Same GSTIN"))) pair.reasons = pair.reasons.filter((r) => !r.startsWith("Same PAN"));
  }
  return [...found.values()].sort((x, y) => (x.strength === y.strength ? y.reasons.length - x.reasons.length : x.strength === "strong" ? -1 : 1));
}
