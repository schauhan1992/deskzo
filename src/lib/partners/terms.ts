import { Prisma, type PartnerKind } from "@deskzo/control-client";
import { istDayKey } from "@/lib/console-shared/format";
import { COUNTRIES } from "@/lib/geo/countries";
import { istDateParts, istMidnight, startOfIndianDay } from "@/lib/india-time";
import { partnerAudit, type PartnerActor } from "@/lib/partners/audit";
import { PartnerRefused, percentToBp, type TermsInput, type TermsRates } from "@/lib/partners/types";
import { controlDb } from "@/lib/platform/control-db";
import type { Staff } from "@/lib/platform/staff-session";

/**
 * A partner's commission terms (partner_terms) — its rates from a day on.
 *
 * Terms are versioned, never edited: new terms are a new row from their `effectiveFrom`, and the row
 * in force at an instant is the partner's one with the greatest `effectiveFrom` at or before it. They
 * are never backdated (spec D19): a date before today is refused, and today itself means "from now",
 * so an invoice already paid today keeps the terms it was paid under.
 *
 * Rates arrive as percent strings ("15", "12.5") and are kept as basis points (1500 is 15 %). A
 * partner with no row in force earns nothing — the console warns "No terms in force".
 *
 * What the forms start from is DEFAULT_TERMS in src/lib/partners/types.ts (owner decision O1): terms
 * are only ever what staff saved.
 */

/** One row of a partner's terms, as the console and the portal list them. */
export type TermsRow = TermsRates & { id: string; effectiveFrom: Date; note: string | null; createdBy: string; createdAt: Date };

/** Terms checked and turned into basis points, ready to store. */
export type CleanTerms = TermsRates & { effectiveFrom: Date; note: string | null };

const COUNTRY_CODES = new Set(COUNTRIES.map((c) => c.code));
const MAX_RATE_ROWS = 50;

const TERMS_SELECT = {
  id: true,
  effectiveFrom: true,
  defaultRateBp: true,
  newRateBp: true,
  renewalRateBp: true,
  newMonths: true,
  durationMonths: true,
  overrideRateBp: true,
  territoryRateBp: true,
  planRates: true,
  countryRates: true,
  note: true,
  createdBy: true,
  createdAt: true,
} as const satisfies Prisma.PartnerTermsSelect;

type TermsRecord = Prisma.PartnerTermsGetPayload<{ select: typeof TERMS_SELECT }>;

const staffActor = (staff: Staff): PartnerActor => ({ kind: "staff", id: staff.id, name: staff.name });

// ─── India days ──────────────────────────────────────────────────────────────────────────────────

/** "yyyy-mm-dd" → the instant that India day begins; null for anything else, 31 February included. */
export function istDayStart(raw: string): Date | null {
  const text = String(raw ?? "").trim();
  const at = startOfIndianDay(text);
  // startOfIndianDay rolls 31 February over into March; a real date reads back as itself.
  return at && istDayKey(at) === text ? at : null;
}

/** The instant today began in India. */
export function startOfIstToday(now: Date): Date {
  const { year, month, day } = istDateParts(now);
  return istMidnight(year, month, day);
}

// ─── Checking ────────────────────────────────────────────────────────────────────────────────────

const blank = (raw: unknown) => raw === null || raw === undefined || String(raw).trim() === "";

function rateOf(raw: unknown, label: string): number {
  const bp = percentToBp(String(raw ?? ""));
  if (bp === null) throw new PartnerRefused(`The ${label} is a percentage from 0 to 100, with at most two decimals ("15" or "12.5").`);
  return bp;
}

const optionalRate = (raw: unknown, label: string): number | null => (blank(raw) ? null : rateOf(raw, label));

function wholeMonths(raw: unknown, min: number, max: number, refusal: string): number {
  const n = typeof raw === "number" ? raw : /^\s*\d{1,4}\s*$/.test(String(raw ?? "")) ? Number(String(raw).trim()) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new PartnerRefused(refusal);
  return n;
}

function noteOf(raw: unknown): string | null {
  if (blank(raw)) return null;
  let text = "";
  for (const ch of String(raw)) {
    const code = ch.codePointAt(0) ?? 0;
    text += code < 32 || code === 127 ? " " : ch;
  }
  text = text.replace(/\s{2,}/g, " ").trim();
  if (text.length > 500) throw new PartnerRefused("Keep the note to 500 characters.");
  return text || null;
}

/**
 * Refuses a territory default that would overlap another ACTIVE distributor's (spec §3.3): two
 * distributors both credited by default for direct signups from one country cannot both win.
 */
export async function assertNoTerritoryOverlap(partnerId: string | null, territories: string[], at: Date): Promise<void> {
  if (!territories.length) return;
  const others = await controlDb().partner.findMany({
    where: { status: "ACTIVE", kind: "DISTRIBUTOR", territories: { hasSome: territories }, ...(partnerId ? { NOT: { id: partnerId } } : {}) },
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true, territories: true },
  });
  for (const other of others) {
    const terms = await termsAt(other.id, at);
    if (terms?.territoryRateBp === null || terms?.territoryRateBp === undefined) continue;
    const shared = other.territories.filter((c) => territories.includes(c));
    throw new PartnerRefused(`Territory default overlaps ${other.displayName} in ${shared.join(", ")}.`);
  }
}

/**
 * Terms as a form sent them → basis points and the instant they start, or a PartnerRefused saying
 * what to fix. `partner` is the one they are for (no `id` while it is being created): the override
 * and the territory default belong to distributors only, and a territory default may not overlap
 * another active distributor's.
 */
export async function cleanTerms(input: TermsInput, partner: { id?: string | null; kind: PartnerKind; territories: string[] }, now: Date = new Date()): Promise<CleanTerms> {
  if (!input || typeof input !== "object") throw new PartnerRefused("Give the commission terms.");

  let effectiveFrom: Date;
  if (blank(input.effectiveFrom)) effectiveFrom = now;
  else {
    const day = istDayStart(String(input.effectiveFrom));
    if (!day) throw new PartnerRefused("Give the day the terms start as yyyy-mm-dd.");
    if (day < startOfIstToday(now)) throw new PartnerRefused("Terms can't start in the past. Choose today or a later day.");
    // Today means from now: never backdated, not even to this morning (D19).
    effectiveFrom = day < now ? now : day;
  }

  if (blank(input.defaultRate)) throw new PartnerRefused("Give the default rate.");
  const defaultRateBp = rateOf(input.defaultRate, "default rate");
  const newRateBp = optionalRate(input.newRate, "new-customer rate");
  const renewalRateBp = optionalRate(input.renewalRate, "renewal rate");
  const newMonths = blank(input.newMonths) ? 12 : wholeMonths(input.newMonths, 1, 60, "A customer is new for 1 to 60 months.");
  const durationMonths = blank(input.durationMonths) ? null : wholeMonths(input.durationMonths, 1, 240, "Commission lasts 1 to 240 months, or leave it empty for the customer's lifetime.");

  const distributor = partner.kind === "DISTRIBUTOR";
  const overrideRateBp = optionalRate(input.overrideRate, "override rate");
  const territoryRateBp = optionalRate(input.territoryRate, "territory rate");
  if (!distributor && overrideRateBp !== null) throw new PartnerRefused("Only a distributor has an override rate.");
  if (!distributor && territoryRateBp !== null) throw new PartnerRefused("Only a distributor has a territory default.");

  const planInput = input.planRates === undefined || input.planRates === null ? [] : input.planRates;
  if (!Array.isArray(planInput)) throw new PartnerRefused("Plan rates are a list.");
  if (planInput.length > MAX_RATE_ROWS) throw new PartnerRefused(`At most ${MAX_RATE_ROWS} plan rates.`);
  const planRates: { planKey: string; rateBp: number }[] = [];
  for (const row of planInput) {
    const planKey = String((row as { planKey?: unknown } | null)?.planKey ?? "").trim().slice(0, 64);
    if (!planKey) throw new PartnerRefused("Choose the plan for each plan rate.");
    if (planRates.some((r) => r.planKey === planKey)) throw new PartnerRefused(`${planKey} has two rates. Give each plan one.`);
    planRates.push({ planKey, rateBp: rateOf((row as { rate?: unknown }).rate, `rate for ${planKey}`) });
  }
  if (planRates.length) {
    const plans = await controlDb().plan.findMany({ where: { key: { in: planRates.map((r) => r.planKey) } }, select: { key: true, kind: true } });
    for (const { planKey } of planRates) {
      const plan = plans.find((p) => p.key === planKey);
      if (!plan) throw new PartnerRefused(`There is no plan ${planKey}.`);
      if (plan.kind === "INTERNAL") throw new PartnerRefused(`${planKey} is an internal plan: nobody pays for it, so it has no rate.`);
    }
  }

  const countryInput = input.countryRates === undefined || input.countryRates === null ? [] : input.countryRates;
  if (!Array.isArray(countryInput)) throw new PartnerRefused("Country rates are a list.");
  if (countryInput.length > MAX_RATE_ROWS) throw new PartnerRefused(`At most ${MAX_RATE_ROWS} country rates.`);
  const countryRates: { country: string; rateBp: number }[] = [];
  for (const row of countryInput) {
    const country = String((row as { country?: unknown } | null)?.country ?? "").trim().toUpperCase().slice(0, 2);
    if (!COUNTRY_CODES.has(country)) throw new PartnerRefused("Choose a country for each country rate.");
    if (countryRates.some((r) => r.country === country)) throw new PartnerRefused(`${country} has two rates. Give each country one.`);
    countryRates.push({ country, rateBp: rateOf((row as { rate?: unknown }).rate, `rate for ${country}`) });
  }

  const note = noteOf(input.note);
  if (territoryRateBp !== null) await assertNoTerritoryOverlap(partner.id ?? null, partner.territories, effectiveFrom);

  return { effectiveFrom, defaultRateBp, newRateBp, renewalRateBp, newMonths, durationMonths, overrideRateBp, territoryRateBp, planRates, countryRates, note };
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

function planRatesOf(json: Prisma.JsonValue): { planKey: string; rateBp: number }[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((r) => {
    const row = r as Record<string, unknown> | null;
    return row && typeof row.planKey === "string" && Number.isInteger(row.rateBp) ? [{ planKey: row.planKey, rateBp: row.rateBp as number }] : [];
  });
}

function countryRatesOf(json: Prisma.JsonValue): { country: string; rateBp: number }[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((r) => {
    const row = r as Record<string, unknown> | null;
    return row && typeof row.country === "string" && Number.isInteger(row.rateBp) ? [{ country: row.country, rateBp: row.rateBp as number }] : [];
  });
}

function rowOf(r: TermsRecord): TermsRow {
  return {
    id: r.id,
    effectiveFrom: r.effectiveFrom,
    defaultRateBp: r.defaultRateBp,
    newRateBp: r.newRateBp,
    renewalRateBp: r.renewalRateBp,
    newMonths: r.newMonths,
    durationMonths: r.durationMonths,
    overrideRateBp: r.overrideRateBp,
    territoryRateBp: r.territoryRateBp,
    planRates: planRatesOf(r.planRates),
    countryRates: countryRatesOf(r.countryRates),
    note: r.note,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

/** The terms in force at `at`: the partner's row with the greatest `effectiveFrom` at or before it. Null: none — it earns nothing then. */
export async function termsAt(partnerId: string, at: Date): Promise<(TermsRates & { id: string }) | null> {
  const row = await controlDb().partnerTerms.findFirst({
    where: { partnerId: String(partnerId ?? "").slice(0, 40), effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: "desc" },
    select: TERMS_SELECT,
  });
  if (!row) return null;
  const { id, defaultRateBp, newRateBp, renewalRateBp, newMonths, durationMonths, overrideRateBp, territoryRateBp, planRates, countryRates } = rowOf(row);
  return { id, defaultRateBp, newRateBp, renewalRateBp, newMonths, durationMonths, overrideRateBp, territoryRateBp, planRates, countryRates };
}

/** Every version of a partner's terms, the latest start first — scheduled ones included. */
export async function termsHistory(partnerId: string): Promise<TermsRow[]> {
  const rows = await controlDb().partnerTerms.findMany({ where: { partnerId: String(partnerId ?? "").slice(0, 40) }, orderBy: { effectiveFrom: "desc" }, take: 200, select: TERMS_SELECT });
  return rows.map(rowOf);
}

// ─── Writing ─────────────────────────────────────────────────────────────────────────────────────

/** One terms row, inside the caller's transaction (a new partner and its first terms stand or fall together). */
export async function writeTerms(tx: Prisma.TransactionClient, partnerId: string, terms: CleanTerms, createdBy: string): Promise<TermsRow> {
  const row = await tx.partnerTerms.create({
    data: {
      partnerId,
      effectiveFrom: terms.effectiveFrom,
      defaultRateBp: terms.defaultRateBp,
      newRateBp: terms.newRateBp,
      renewalRateBp: terms.renewalRateBp,
      newMonths: terms.newMonths,
      durationMonths: terms.durationMonths,
      overrideRateBp: terms.overrideRateBp,
      territoryRateBp: terms.territoryRateBp,
      planRates: terms.planRates as Prisma.InputJsonValue,
      countryRates: terms.countryRates as Prisma.InputJsonValue,
      note: terms.note,
      createdBy,
    },
    select: TERMS_SELECT,
  });
  return rowOf(row);
}

const isUniqueViolation = (err: unknown) =>
  (err instanceof Prisma.PrismaClientKnownRequestError || (err instanceof Error && err.name === "PrismaClientKnownRequestError")) && (err as { code?: unknown }).code === "P2002";

/**
 * New terms for a partner from `effectiveFrom` on (console, SELLERS). The partner audit gets
 * `terms.set` (the start day only — rates are for money roles, on the terms page); the console
 * action writes the platform audit.
 */
export async function setPartnerTerms(partnerId: string, input: TermsInput, staff: Staff, now: Date = new Date()): Promise<TermsRow> {
  const partner = await controlDb().partner.findUnique({ where: { id: String(partnerId ?? "").slice(0, 40) }, select: { id: true, kind: true, status: true, territories: true } });
  if (!partner) throw new PartnerRefused("That partner no longer exists.");
  if (partner.status === "TERMINATED") throw new PartnerRefused("A terminated partner earns nothing more, so it takes no new terms.");
  const terms = await cleanTerms(input, partner, now);
  let row: TermsRow;
  try {
    row = await controlDb().$transaction(async (tx) => {
      const made = await writeTerms(tx, partner.id, terms, `staff:${staff.id}`);
      await partnerAudit(staffActor(staff), partner.id, "terms.set", "terms", made.id, { from: istDayKey(made.effectiveFrom) }, { tx });
      return made;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new PartnerRefused("Terms already start at that moment. Choose another day.");
    throw err;
  }
  return row;
}
