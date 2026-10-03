import Papa from "papaparse";
import { Prisma, type CommissionKind, type CommissionStatus, type PartnerKind, type PartnerStatus, type StatementStatus } from "@deskzo/control-client";
import { csvFilename } from "@/lib/console-shared/format";
import { PARTNER_KIND, PARTNER_STATUS } from "@/lib/console-shared/labels";
import { reportRange, type CommissionFilters, type ReportFilters, type StatementFilters } from "@/lib/console-shared/partner-params";
import type { CsvExport } from "@/lib/console-shared/types";
import { COUNTRIES } from "@/lib/geo/countries";
import { moneyOf, mrrByGroup, refNamer, type PartnerRef } from "@/lib/partners/console-data";
import { attributedMrr } from "@/lib/partners/customers";
import { CSV_MAX_ROWS, commissionCsv, statementCsv, type CommissionCsvRow } from "@/lib/partners/csv";
import type { CommissionBasis } from "@/lib/partners/rates";
import { partnerIdBySlug } from "@/lib/partners/registry";
import { twoPersonPayout } from "@/lib/partners/settings";
import { previousIstMonth } from "@/lib/partners/statements";
import { PartnerRefused, type Money, type Paged, type PayoutMask, type TaxLine } from "@/lib/partners/types";
import { controlDb } from "@/lib/platform/control-db";
import { indiaClock } from "@/lib/time/zone";

/**
 * The console's partner money (spec §9.2–§9.3): the /commissions page — the Review queue, every
 * statement, the Reports — its CSV exports, and a partner 360's Commissions and Statements tabs.
 *
 * SELLERS only, every one of them: the pages and actions that call these check the role first, so
 * nothing here takes `withMoney`. Plain async functions with explicit selects (console spec §5.0);
 * the sealed bank details are never read — a statement carries the payout mask it was approved with.
 * Amounts are minor units per currency, never added across currencies; statement sums, stored as
 * BigInt, come back as numbers (a page's props must serialise). Days are India's, half-open, whatever
 * zone the console keeps: commission is counted in India's months, as its statements are
 * (src/lib/partners/statements.ts).
 *
 * The Review queue puts first what deserves a second look (spec §9.2): an entry whose customer's
 * current attribution was flagged at signup and nobody has reviewed, or whose amount is more than
 * five times its partner's 90-day median in that currency.
 */

const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;
const MEDIAN_DAYS = 90;
const MEDIAN_TIMES = 5;
const STATEMENT_ENTRIES = 1_000;
const TAB_STATEMENTS = 100;
const COUNTRY_NAMES = new Map(COUNTRIES.map((c) => [c.code, c.name]));
const CLAWBACK_NOTE = "Refunded after the clawback window — not recovered.";

/** A current attribution flagged at signup that nobody has reviewed. */
const FLAGGED_OPEN = { validTo: null, reviewedAt: null, flags: { not: Prisma.AnyNull } } as const satisfies Prisma.TenantAttributionWhereInput;

const cleanId = (value: unknown) => String(value ?? "").trim().slice(0, 40);

function clampPage(page: number, total: number, pageSize: number): number {
  const last = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.max(1, Math.trunc(page) || 1), last);
}

const num = (v: bigint | number | null | undefined): number => Number(v ?? 0);

/** A half-open IST window from "yyyy-mm-dd" days (either end may be missing). */
function istWindow(from: string | undefined, to: string | undefined): { gte?: Date; lt?: Date } | null {
  return indiaClock.dayRange(from, to);
}

// ─── Entries ─────────────────────────────────────────────────────────────────────────────────────

/** One commission entry as staff see it — its basis included (the portal shows less of it). */
export type ConsoleCommissionRow = {
  id: string;
  earnedAt: Date;
  partner: PartnerRef;
  customer: { slug: string; name: string } | null;
  invoice: { id: string; number: string | null } | null;
  kind: CommissionKind;
  /** A negative entry taking back part of `reversesId` (a refund, a credit note, a void). */
  reversal: boolean;
  reversesId: string | null;
  status: CommissionStatus;
  /** Minor units. */
  base: number;
  rateBp: number;
  /** Minor units: positive owed to the partner, negative taken back. */
  amount: number;
  currency: string;
  statement: { id: string; number: string; status: StatementStatus } | null;
  /** An adjustment's note (shown to the partner too). */
  note: string | null;
  basis: CommissionBasis | null;
  createdByName: string;
  voided: { at: Date; byName: string; reason: string | null } | null;
  /**
   * PAID, and a refund of its invoice came after the clawback window (owner decision O3): nothing was
   * taken back. The page shows `clawbackNote`.
   */
  clawbackExpired: boolean;
  clawbackNote: string | null;
  /** Why it is worth a second look: its customer's attribution is flagged and unreviewed; it is over five times the partner's 90-day median. */
  flags: { attribution: boolean; overMedian: boolean };
};

const ENTRY_SELECT = {
  id: true,
  earnedAt: true,
  kind: true,
  status: true,
  base: true,
  rateBp: true,
  amount: true,
  currency: true,
  reversesId: true,
  note: true,
  basis: true,
  createdBy: true,
  voidedAt: true,
  voidedBy: true,
  voidReason: true,
  tenantId: true,
  partnerId: true,
  partner: { select: { slug: true, displayName: true } },
  tenant: { select: { slug: true, name: true } },
  invoice: { select: { id: true, number: true, commissionState: { select: { clawbackExpiredAt: true } } } },
  statement: { select: { id: true, number: true, status: true } },
} as const satisfies Prisma.CommissionEntrySelect;
type EntryRecord = Prisma.CommissionEntryGetPayload<{ select: typeof ENTRY_SELECT }>;

const ORDER: Prisma.CommissionEntryOrderByWithRelationInput[] = [{ earnedAt: "desc" }, { id: "desc" }];

function basisOf(raw: Prisma.JsonValue): CommissionBasis | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const type = (raw as { type?: unknown }).type;
  // An accrual is read by its lines (basisLine maps them); a stored one without them is treated as
  // having no basis rather than crashing the page. The engine always writes them — this is for
  // hand-made rows.
  if (type === "accrual" && !Array.isArray((raw as { lines?: unknown }).lines)) return null;
  return type === "accrual" || type === "override" || type === "reversal" || type === "adjustment" ? (raw as unknown as CommissionBasis) : null;
}

type MedianLimit = { partnerId: string; currency: string; limit: number };

/**
 * Each partner's 90-day median accrual per currency (DIRECT and OVERRIDE, not void, positive), as the
 * amount an entry must exceed to be flagged: five times it, floored (amounts are whole numbers).
 */
async function medianLimits(now: Date, partnerId?: string): Promise<MedianLimit[]> {
  const since = new Date(now.getTime() - MEDIAN_DAYS * DAY_MS);
  const rows = await controlDb().$queryRaw<{ partnerId: string; currency: string; median: number | null }[]>`
    SELECT "partnerId", currency, (percentile_cont(0.5) WITHIN GROUP (ORDER BY amount))::float8 AS median
    FROM commission_entries
    WHERE "earnedAt" >= ${since} AND "earnedAt" <= ${now}
      AND kind IN ('DIRECT', 'OVERRIDE') AND "reversesId" IS NULL AND status <> 'VOID' AND amount > 0
      ${partnerId ? Prisma.sql`AND "partnerId" = ${partnerId}` : Prisma.empty}
    GROUP BY "partnerId", currency`;
  return rows
    .filter((r) => r.median !== null && Number.isFinite(Number(r.median)))
    .map((r) => ({ partnerId: r.partnerId, currency: r.currency, limit: Math.floor(MEDIAN_TIMES * Number(r.median)) }));
}

/** Entries worth a second look. Rows it cannot decide (no customer) fall to the amount test alone. */
function flaggedWhere(limits: MedianLimit[]): Prisma.CommissionEntryWhereInput {
  return {
    OR: [
      { tenant: { is: { attributions: { some: FLAGGED_OPEN } } } },
      ...limits.map((l) => ({ partnerId: l.partnerId, currency: l.currency, amount: { gt: l.limit } })),
    ],
  };
}

/** Exactly the entries `flaggedWhere` leaves out — written out rather than NOT(…), so an entry with no customer is not lost to SQL's NULL. */
function unflaggedWhere(limits: MedianLimit[]): Prisma.CommissionEntryWhereInput {
  return {
    AND: [
      { OR: [{ tenantId: null }, { tenant: { is: { attributions: { none: FLAGGED_OPEN } } } }] },
      ...limits.map((l) => ({ NOT: { partnerId: l.partnerId, currency: l.currency, amount: { gt: l.limit } } })),
    ],
  };
}

/** The filters as a where (null: a partner slug nobody has — nothing matches). `defaultStatus` applies when the URL names none. */
async function entryWhere(f: CommissionFilters, scope: { defaultStatus: CommissionStatus | null; partnerId?: string }): Promise<Prisma.CommissionEntryWhereInput | null> {
  let partnerId = scope.partnerId !== undefined ? cleanId(scope.partnerId) : undefined;
  if (partnerId === "") return null;
  if (partnerId === undefined && f.partner) {
    const found = await partnerIdBySlug(f.partner);
    if (!found) return null;
    partnerId = found;
  }
  const status = f.status ?? scope.defaultStatus;
  const earned = istWindow(f.from, f.to);
  return {
    ...(partnerId ? { partnerId } : {}),
    ...(status ? { status } : {}),
    ...(f.currency ? { currency: f.currency } : {}),
    ...(f.kind ? { kind: f.kind } : {}),
    ...(earned ? { earnedAt: earned } : {}),
  };
}

/** Records → rows, with their flags and the names of who made and voided them. */
async function entryRows(records: EntryRecord[], limits: MedianLimit[]): Promise<ConsoleCommissionRow[]> {
  const tenantIds = [...new Set(records.map((r) => r.tenantId).filter((t): t is string => !!t))];
  const [flagged, names] = await Promise.all([
    tenantIds.length
      ? controlDb().tenantAttribution.findMany({ where: { ...(FLAGGED_OPEN), tenantId: { in: tenantIds } }, select: { tenantId: true } })
      : Promise.resolve([]),
    refNamer(records.flatMap((r) => [r.createdBy, r.voidedBy])),
  ]);
  const flaggedTenants = new Set(flagged.map((f) => f.tenantId));
  const limitOf = new Map(limits.map((l) => [`${l.partnerId}|${l.currency}`, l.limit]));
  return records.map((r) => {
    const limit = limitOf.get(`${r.partnerId}|${r.currency}`);
    const clawbackExpired = r.kind !== "ADJUSTMENT" && r.reversesId === null && r.status === "PAID" && !!r.invoice?.commissionState?.clawbackExpiredAt;
    return {
      id: r.id,
      earnedAt: r.earnedAt,
      partner: r.partner,
      customer: r.tenant,
      invoice: r.invoice ? { id: r.invoice.id, number: r.invoice.number } : null,
      kind: r.kind,
      reversal: r.reversesId !== null,
      reversesId: r.reversesId,
      status: r.status,
      base: r.base,
      rateBp: r.rateBp,
      amount: r.amount,
      currency: r.currency,
      statement: r.statement,
      note: r.note,
      basis: basisOf(r.basis),
      createdByName: names(r.createdBy),
      voided: r.voidedAt ? { at: r.voidedAt, byName: names(r.voidedBy), reason: r.voidReason } : null,
      clawbackExpired,
      clawbackNote: clawbackExpired ? CLAWBACK_NOTE : null,
      flags: { attribution: !!r.tenantId && flaggedTenants.has(r.tenantId), overMedian: limit !== undefined && r.amount > limit },
    };
  });
}

function findEntries(where: Prisma.CommissionEntryWhereInput, skip: number, take: number): Promise<EntryRecord[]> {
  return take > 0 ? controlDb().commissionEntry.findMany({ where, orderBy: ORDER, skip, take, select: ENTRY_SELECT }) : Promise.resolve([]);
}

/** Money per currency, and how many entries. */
export type CurrencyTotal = { currency: string; amount: number; count: number };

// ─── Review (/commissions?tab=review) ────────────────────────────────────────────────────────────

export type CommissionReview = Paged<ConsoleCommissionRow> & {
  /** The status shown: the URL's, or PENDING. */
  status: CommissionStatus;
  /** How many of the matches are flagged (they come first). */
  flaggedCount: number;
  /** Every match, per currency — not only this page. */
  totals: CurrencyTotal[];
  asOf: Date;
};

/**
 * The Review tab: entries across partners (PENDING unless the URL says otherwise), filtered, the
 * flagged ones first, then the latest earned first; 50 a page, and the totals per currency.
 */
export async function commissionReview(f: CommissionFilters, now = new Date()): Promise<CommissionReview> {
  const status = f.status ?? "PENDING";
  const empty: CommissionReview = { rows: [], total: 0, page: 1, pageSize: PAGE_SIZE, status, flaggedCount: 0, totals: [], asOf: now };
  const where = await entryWhere(f, { defaultStatus: "PENDING" });
  if (!where) return empty;
  const limits = await medianLimits(now);
  const flagged: Prisma.CommissionEntryWhereInput = { AND: [where, flaggedWhere(limits)] };
  const scoped = f.flagged ? flagged : where;
  const control = controlDb();
  const [total, flaggedCount, sums] = await Promise.all([
    control.commissionEntry.count({ where: scoped }),
    control.commissionEntry.count({ where: flagged }),
    control.commissionEntry.groupBy({ by: ["currency"], where: scoped, _sum: { amount: true }, _count: { _all: true } }),
  ]);
  const page = clampPage(f.page, total, PAGE_SIZE);
  const skip = (page - 1) * PAGE_SIZE;
  let records: EntryRecord[];
  if (f.flagged) records = await findEntries(scoped, skip, PAGE_SIZE);
  else if (skip < flaggedCount) {
    const head = await findEntries(flagged, skip, PAGE_SIZE);
    const rest = await findEntries({ AND: [where, unflaggedWhere(limits)] }, 0, PAGE_SIZE - head.length);
    records = [...head, ...rest];
  } else records = await findEntries({ AND: [where, unflaggedWhere(limits)] }, skip - flaggedCount, PAGE_SIZE);
  return {
    rows: await entryRows(records, limits),
    total,
    page,
    pageSize: PAGE_SIZE,
    status,
    flaggedCount,
    totals: sums.map((s) => ({ currency: s.currency, amount: num(s._sum.amount), count: s._count._all })).sort((a, b) => a.currency.localeCompare(b.currency)),
    asOf: now,
  };
}

const CSV_SELECT = {
  earnedAt: true,
  kind: true,
  status: true,
  base: true,
  rateBp: true,
  amount: true,
  currency: true,
  reversesId: true,
  partner: { select: { displayName: true } },
  tenant: { select: { slug: true, name: true } },
  invoice: { select: { number: true } },
  statement: { select: { number: true } },
} as const satisfies Prisma.CommissionEntrySelect;

function csvRow(r: Prisma.CommissionEntryGetPayload<{ select: typeof CSV_SELECT }>): CommissionCsvRow {
  return {
    earnedAt: r.earnedAt,
    partner: r.partner.displayName,
    customer: r.tenant?.name ?? null,
    workspace: r.tenant?.slug ?? null,
    invoice: r.invoice?.number ?? null,
    kind: r.kind,
    reversal: r.reversesId !== null,
    base: r.base,
    rateBp: r.rateBp,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    statement: r.statement?.number ?? null,
  };
}

/**
 * Entries as CSV, with the Partner column (spec §6.7): `"review"` — the Review tab's list (PENDING
 * unless the URL says otherwise; `flagged=1` only the flagged); `"partner"` — one partner's entries
 * (`f.partner` required; every status unless the URL says one). Up to 10,000; more is refused.
 */
export async function commissionsCsv(f: CommissionFilters, scope: "review" | "partner" = "review", now = new Date()): Promise<CsvExport> {
  if (scope === "partner" && !f.partner) throw new PartnerRefused("Choose the partner whose commissions to export.");
  const where = await entryWhere(f, { defaultStatus: scope === "review" ? "PENDING" : null });
  if (!where) throw new PartnerRefused("That partner no longer exists.");
  const scoped = scope === "review" && f.flagged ? { AND: [where, flaggedWhere(await medianLimits(now))] } : where;
  const rows = await controlDb().commissionEntry.findMany({ where: scoped, orderBy: ORDER, take: CSV_MAX_ROWS + 1, select: CSV_SELECT });
  return commissionCsv(rows.map(csvRow), { withPartner: true, filenamePrefix: scope === "partner" ? `${f.partner}-commissions` : "commissions" }, now);
}

// ─── A partner 360's Commissions tab ─────────────────────────────────────────────────────────────

export type PartnerCommissionsTab = Paged<ConsoleCommissionRow> & {
  /** The partner's whole balance per currency, whatever the filters: waiting, approved, paid (void left out). */
  totals: { currency: string; pending: number; approved: number; paid: number }[];
  /** Currencies it has entries in — the adjustment dialog's first choices. */
  currencies: string[];
  asOf: Date;
};

/** A partner's entries, every status unless the URL says one, the latest earned first, 50 a page. */
export async function partnerCommissionsTab(partnerId: string, f: CommissionFilters, now = new Date()): Promise<PartnerCommissionsTab> {
  const id = cleanId(partnerId);
  const empty: PartnerCommissionsTab = { rows: [], total: 0, page: 1, pageSize: PAGE_SIZE, totals: [], currencies: [], asOf: now };
  const where = await entryWhere(f, { defaultStatus: null, partnerId: id });
  if (!where) return empty;
  const control = controlDb();
  const [total, balance, limits] = await Promise.all([
    control.commissionEntry.count({ where }),
    control.commissionEntry.groupBy({ by: ["currency", "status"], where: { partnerId: id, status: { not: "VOID" } }, _sum: { amount: true } }),
    medianLimits(now, id),
  ]);
  const page = clampPage(f.page, total, PAGE_SIZE);
  const records = await findEntries(where, (page - 1) * PAGE_SIZE, PAGE_SIZE);
  const currencies = [...new Set(balance.map((b) => b.currency))].sort();
  const sumOf = (currency: string, status: CommissionStatus) => num(balance.find((b) => b.currency === currency && b.status === status)?._sum.amount);
  return {
    rows: await entryRows(records, limits),
    total,
    page,
    pageSize: PAGE_SIZE,
    totals: currencies.map((currency) => ({ currency, pending: sumOf(currency, "PENDING"), approved: sumOf(currency, "APPROVED"), paid: sumOf(currency, "PAID") })),
    currencies,
    asOf: now,
  };
}

// ─── Statements ──────────────────────────────────────────────────────────────────────────────────

/** A statement as staff list it. Amounts are minor units of its currency. */
export type ConsoleStatementRow = {
  id: string;
  number: string;
  partner: PartnerRef;
  /** The IST month it covers, "2026-09". */
  period: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  status: StatementStatus;
  entryCount: number;
  earned: number;
  reversed: number;
  adjustments: number;
  total: number;
  netPayable: number;
  /** The partner's own invoice number (entered in the portal once approved). */
  partnerInvoiceNumber: string | null;
  generatedAt: Date;
  generatedByName: string;
  approvedAt: Date | null;
  approvedByName: string | null;
  /** The staff member who approved it — with the two-person rule on, they cannot mark it paid. */
  approvedById: string | null;
  paidAt: Date | null;
  paidByName: string | null;
  paymentReference: string | null;
  voidedAt: Date | null;
  voidedByName: string | null;
  voidReason: string | null;
  /** The partner has bank details on file (approval needs them). */
  payoutOnFile: boolean;
};

const STATEMENT_SELECT = {
  id: true,
  number: true,
  period: true,
  periodStart: true,
  periodEnd: true,
  currency: true,
  status: true,
  entryCount: true,
  earned: true,
  reversed: true,
  adjustments: true,
  total: true,
  netPayable: true,
  partnerInvoiceNumber: true,
  generatedAt: true,
  generatedBy: true,
  approvedAt: true,
  approvedBy: true,
  paidAt: true,
  paidBy: true,
  paymentReference: true,
  voidedAt: true,
  voidedBy: true,
  voidReason: true,
  partner: { select: { slug: true, displayName: true, payoutUpdatedAt: true } },
} as const satisfies Prisma.PartnerStatementSelect;
type StatementRecord = Prisma.PartnerStatementGetPayload<{ select: typeof STATEMENT_SELECT }>;

async function statementRows(records: StatementRecord[]): Promise<ConsoleStatementRow[]> {
  const names = await refNamer(records.flatMap((r) => [r.generatedBy, r.approvedBy, r.paidBy, r.voidedBy]));
  return records.map((r) => ({
    id: r.id,
    number: r.number,
    partner: { slug: r.partner.slug, displayName: r.partner.displayName },
    period: r.period,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    currency: r.currency,
    status: r.status,
    entryCount: r.entryCount,
    earned: num(r.earned),
    reversed: num(r.reversed),
    adjustments: num(r.adjustments),
    total: num(r.total),
    netPayable: num(r.netPayable),
    partnerInvoiceNumber: r.partnerInvoiceNumber,
    generatedAt: r.generatedAt,
    generatedByName: names(r.generatedBy),
    approvedAt: r.approvedAt,
    approvedByName: r.approvedBy ? names(r.approvedBy) : null,
    approvedById: r.approvedBy?.startsWith("staff:") ? r.approvedBy.slice(6) : null,
    paidAt: r.paidAt,
    paidByName: r.paidBy ? names(r.paidBy) : null,
    paymentReference: r.paymentReference,
    voidedAt: r.voidedAt,
    voidedByName: r.voidedBy ? names(r.voidedBy) : null,
    voidReason: r.voidReason,
    payoutOnFile: r.partner.payoutUpdatedAt !== null,
  }));
}

export type StatementsBoard = Paged<ConsoleStatementRow> & {
  /** Per status, with the other filters applied. */
  counts: Record<StatementStatus, number>;
  /** Whoever approved a statement cannot also mark it paid (owner decision O4). */
  twoPersonPayout: boolean;
  /** The IST month "Generate statements" would draft now. */
  nextPeriod: string;
  asOf: Date;
};

/** The Statements tab: every statement, filtered, the latest month first; 50 a page. */
export async function statementsBoard(f: StatementFilters, now = new Date()): Promise<StatementsBoard> {
  const counts: Record<StatementStatus, number> = { DRAFT: 0, APPROVED: 0, PAID: 0, VOID: 0 };
  const base = { twoPersonPayout: await twoPersonPayout(), nextPeriod: previousIstMonth(now).period, asOf: now };
  let partnerId: string | undefined;
  if (f.partner) {
    const found = await partnerIdBySlug(f.partner);
    if (!found) return { rows: [], total: 0, page: 1, pageSize: PAGE_SIZE, counts, ...base };
    partnerId = found;
  }
  const others: Prisma.PartnerStatementWhereInput = { ...(partnerId ? { partnerId } : {}), ...(f.currency ? { currency: f.currency } : {}), ...(f.period ? { period: f.period } : {}) };
  const where: Prisma.PartnerStatementWhereInput = { ...others, ...(f.status ? { status: f.status } : {}) };
  const control = controlDb();
  const [total, byStatus] = await Promise.all([control.partnerStatement.count({ where }), control.partnerStatement.groupBy({ by: ["status"], where: others, _count: { _all: true } })]);
  for (const s of byStatus) counts[s.status] = s._count._all;
  const page = clampPage(f.page, total, PAGE_SIZE);
  const records = total
    ? await control.partnerStatement.findMany({ where, orderBy: [{ period: "desc" }, { number: "asc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, select: STATEMENT_SELECT })
    : [];
  return { rows: await statementRows(records), total, page, pageSize: PAGE_SIZE, counts, ...base };
}

/** What a statement recorded of the partner when it was drafted — the payout mask refreshed at approval. Never the bank details. */
export type StatementSnapshot = {
  legalName: string;
  displayName: string;
  country: string;
  address: { line1: string | null; line2: string | null; city: string | null; region: string | null; postalCode: string | null };
  taxIds: { kind: string; value: string }[];
  payout: PayoutMask | null;
};

export type ConsoleStatementDetail = ConsoleStatementRow & {
  snapshot: StatementSnapshot;
  taxLines: TaxLine[];
  paymentNote: string | null;
  /** Its entries, the earliest earned first (1,000 at most; `entryCount` has them all). A void statement holds none. */
  entries: ConsoleCommissionRow[];
};

function snapshotOf(raw: Prisma.JsonValue): StatementSnapshot {
  const x = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const address = (x.address && typeof x.address === "object" && !Array.isArray(x.address) ? x.address : {}) as Record<string, unknown>;
  const payout = (x.payout && typeof x.payout === "object" && !Array.isArray(x.payout) ? x.payout : null) as Record<string, unknown> | null;
  return {
    legalName: s(x.legalName) ?? "",
    displayName: s(x.displayName) ?? "",
    country: s(x.country) ?? "",
    address: { line1: s(address.line1), line2: s(address.line2), city: s(address.city), region: s(address.region), postalCode: s(address.postalCode) },
    taxIds: Array.isArray(x.taxIds)
      ? x.taxIds.flatMap((t) => {
          const row = t as { kind?: unknown; value?: unknown } | null;
          return row && typeof row.kind === "string" && typeof row.value === "string" ? [{ kind: row.kind, value: row.value }] : [];
        })
      : [],
    payout:
      payout && s(payout.accountHolder) && s(payout.last4)
        ? {
            method: "BANK",
            accountHolder: s(payout.accountHolder)!,
            bankName: s(payout.bankName) ?? "",
            country: s(payout.country) ?? "",
            currency: s(payout.currency) ?? "",
            last4: s(payout.last4)!,
            ifsc: s(payout.ifsc),
            swift: s(payout.swift),
          }
        : null,
  };
}

function taxLinesOf(raw: Prisma.JsonValue): TaxLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l) => {
    const x = l as Record<string, unknown> | null;
    if (!x || typeof x.label !== "string" || (x.kind !== "ADD" && x.kind !== "WITHHOLD") || !Number.isFinite(Number(x.amount))) return [];
    return [{ label: x.label, kind: x.kind, rateBp: Number.isInteger(x.rateBp) ? (x.rateBp as number) : null, amount: Number(x.amount) }];
  });
}

/** One statement with its snapshot, tax lines and entries (the Statements tab's drawer), or null. */
export async function statementDetail(statementId: string, now = new Date()): Promise<ConsoleStatementDetail | null> {
  const id = cleanId(statementId);
  if (!id) return null;
  const control = controlDb();
  const st = await control.partnerStatement.findUnique({ where: { id }, select: { ...STATEMENT_SELECT, partnerId: true, taxLines: true, partnerSnapshot: true, paymentNote: true } });
  if (!st) return null;
  const [[row], records, limits] = await Promise.all([
    statementRows([st]),
    control.commissionEntry.findMany({ where: { statementId: st.id }, orderBy: [{ earnedAt: "asc" }, { id: "asc" }], take: STATEMENT_ENTRIES, select: ENTRY_SELECT }),
    medianLimits(now, st.partnerId),
  ]);
  return { ...row!, snapshot: snapshotOf(st.partnerSnapshot), taxLines: taxLinesOf(st.taxLines), paymentNote: st.paymentNote, entries: await entryRows(records, limits) };
}

/** One statement as CSV (spec §6.7): its entries, then the total, each tax line and the net payable. Null for no such statement. */
export async function statementCsvById(statementId: string, now = new Date()): Promise<(CsvExport & { number: string; partnerSlug: string }) | null> {
  const id = cleanId(statementId);
  if (!id) return null;
  const control = controlDb();
  const st = await control.partnerStatement.findUnique({ where: { id }, select: { id: true, number: true, currency: true, total: true, netPayable: true, taxLines: true, partner: { select: { slug: true } } } });
  if (!st) return null;
  const rows = await control.commissionEntry.findMany({ where: { statementId: st.id }, orderBy: [{ earnedAt: "asc" }, { id: "asc" }], take: CSV_MAX_ROWS + 1, select: CSV_SELECT });
  // The statement CSV has no Partner column: it is one partner's.
  const out = statementCsv({ number: st.number, currency: st.currency, total: st.total, netPayable: st.netPayable, taxLines: taxLinesOf(st.taxLines) }, rows.map(csvRow), now);
  return { ...out, number: st.number, partnerSlug: st.partner.slug };
}

// ─── A partner 360's Statements tab ──────────────────────────────────────────────────────────────

export type PartnerStatementsTab = {
  /** The latest 100, the latest month first. */
  rows: ConsoleStatementRow[];
  total: number;
  payoutOnFile: boolean;
  twoPersonPayout: boolean;
  /** The IST month "Generate statements" would draft now. */
  nextPeriod: string;
  /** PENDING entries on no statement yet, per currency — what later statements will take. */
  awaitingStatement: Money[];
  asOf: Date;
};

export async function partnerStatementsTab(partnerId: string, now = new Date()): Promise<PartnerStatementsTab> {
  const id = cleanId(partnerId);
  const control = controlDb();
  const [partner, total, records, waiting, twoPerson] = await Promise.all([
    id ? control.partner.findUnique({ where: { id }, select: { payoutUpdatedAt: true } }) : Promise.resolve(null),
    id ? control.partnerStatement.count({ where: { partnerId: id } }) : Promise.resolve(0),
    id ? control.partnerStatement.findMany({ where: { partnerId: id }, orderBy: [{ period: "desc" }, { number: "asc" }], take: TAB_STATEMENTS, select: STATEMENT_SELECT }) : Promise.resolve([]),
    id ? control.commissionEntry.groupBy({ by: ["currency"], where: { partnerId: id, status: "PENDING", statementId: null }, _sum: { amount: true } }) : Promise.resolve([]),
    twoPersonPayout(),
  ]);
  return {
    rows: await statementRows(records),
    total,
    payoutOnFile: !!partner?.payoutUpdatedAt,
    twoPersonPayout: twoPerson,
    nextPeriod: previousIstMonth(now).period,
    awaitingStatement: moneyOf(waiting.map((w) => ({ currency: w.currency, minor: w._sum.amount }))),
    asOf: now,
  };
}

// ─── Reports (/commissions?tab=reports) ──────────────────────────────────────────────────────────

export type PartnerReportRow = {
  partner: PartnerRef & { kind: PartnerKind; status: PartnerStatus };
  /** Now: workspaces attributed to it (closed ones left out), and their MRR. */
  customers: number;
  mrr: Money[];
  /** In the window: its customers' invoiced amounts before tax (DIRECT accrual bases less reversal bases). */
  netInvoiced: Money[];
  /** In the window: commission earned (every entry but void ones — reversals and adjustments netted). */
  earned: Money[];
  /** In the window: commission paid — the totals of its statements marked paid (before tax lines). */
  paid: Money[];
};

export type CountryReportRow = { country: string; name: string; partnerCustomers: number; directCustomers: number; partnerMrr: Money[]; directMrr: Money[] };

export type PartnerReport = {
  /** The IST window, "yyyy-mm-dd" (`reportRange`: the current IST year to date unless the URL says). */
  from: string;
  to: string;
  partners: PartnerReportRow[];
  /** Countries with workspaces now, by name. */
  countries: CountryReportRow[];
  totals: { partnerCustomers: number; directCustomers: number; partnerMrr: Money[]; directMrr: Money[]; netInvoiced: Money[]; earned: Money[]; paid: Money[] };
  asOf: Date;
};

/**
 * The Reports tab (spec §9.2): per partner — customers and MRR now; net invoiced, commission earned and
 * commission paid in the IST window — and per country, partner-sold against direct customers and MRR.
 * Every partner is listed; money per currency, never added across currencies.
 */
export async function partnerReport(f: ReportFilters, now = new Date()): Promise<PartnerReport> {
  const { from, to } = reportRange(f ?? {}, now);
  const span = istWindow(from, to) ?? {};
  const control = controlDb();
  const [partners, tenants, accruals, reversals, earned, paid] = await Promise.all([
    control.partner.findMany({ orderBy: [{ displayName: "asc" }, { slug: "asc" }], select: { id: true, slug: true, displayName: true, kind: true, status: true } }),
    control.tenant.findMany({ where: { status: { not: "DEPROVISIONED" } }, select: { id: true, country: true, partnerId: true } }),
    control.commissionEntry.groupBy({ by: ["partnerId", "currency"], where: { kind: "DIRECT", reversesId: null, status: { not: "VOID" }, earnedAt: span }, _sum: { base: true } }),
    control.commissionEntry.groupBy({ by: ["partnerId", "currency"], where: { kind: "DIRECT", reversesId: { not: null }, status: { not: "VOID" }, earnedAt: span }, _sum: { base: true } }),
    control.commissionEntry.groupBy({ by: ["partnerId", "currency"], where: { status: { not: "VOID" }, earnedAt: span }, _sum: { amount: true } }),
    control.partnerStatement.groupBy({ by: ["partnerId", "currency"], where: { status: "PAID", paidAt: span }, _sum: { total: true } }),
  ]);

  const byPartner = new Map<string, string[]>();
  const byCountry = new Map<string, { partner: string[]; direct: string[] }>();
  for (const t of tenants) {
    if (t.partnerId) byPartner.set(t.partnerId, [...(byPartner.get(t.partnerId) ?? []), t.id]);
    const c = byCountry.get(t.country) ?? { partner: [], direct: [] };
    (t.partnerId ? c.partner : c.direct).push(t.id);
    byCountry.set(t.country, c);
  }
  const countryGroups = new Map<string, string[]>();
  for (const [country, c] of byCountry) {
    countryGroups.set(`p|${country}`, c.partner);
    countryGroups.set(`d|${country}`, c.direct);
  }
  const partnerIds = tenants.filter((t) => t.partnerId).map((t) => t.id);
  const directIds = tenants.filter((t) => !t.partnerId).map((t) => t.id);
  const [partnerMrr, countryMrr, allPartnerMrr, allDirectMrr] = await Promise.all([
    mrrByGroup(byPartner),
    mrrByGroup(countryGroups),
    partnerIds.length ? attributedMrr(partnerIds) : Promise.resolve([]),
    directIds.length ? attributedMrr(directIds) : Promise.resolve([]),
  ]);

  const ofPartner = <T extends { partnerId: string; currency: string }>(rows: T[], id: string, pick: (r: T) => number | bigint | null | undefined) =>
    moneyOf(rows.filter((r) => r.partnerId === id).map((r) => ({ currency: r.currency, minor: pick(r) })));
  const rows: PartnerReportRow[] = partners.map((p) => {
    const invoiced = ofPartner(accruals, p.id, (r) => r._sum.base);
    const taken = ofPartner(reversals, p.id, (r) => r._sum.base);
    return {
      partner: { slug: p.slug, displayName: p.displayName, kind: p.kind, status: p.status },
      customers: byPartner.get(p.id)?.length ?? 0,
      mrr: partnerMrr.get(p.id) ?? [],
      netInvoiced: moneyOf([...invoiced, ...taken.map((m) => ({ currency: m.currency, minor: -m.minor }))]),
      earned: ofPartner(earned, p.id, (r) => r._sum.amount),
      paid: ofPartner(paid, p.id, (r) => r._sum.total),
    };
  });
  const countries: CountryReportRow[] = [...byCountry]
    .map(([country, c]) => ({
      country,
      name: COUNTRY_NAMES.get(country) ?? country,
      partnerCustomers: c.partner.length,
      directCustomers: c.direct.length,
      partnerMrr: countryMrr.get(`p|${country}`) ?? [],
      directMrr: countryMrr.get(`d|${country}`) ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const all = (pick: (r: PartnerReportRow) => Money[]) => moneyOf(rows.flatMap(pick));
  return {
    from,
    to,
    partners: rows,
    countries,
    totals: {
      partnerCustomers: partnerIds.length,
      directCustomers: directIds.length,
      partnerMrr: allPartnerMrr,
      directMrr: allDirectMrr,
      netInvoiced: all((r) => r.netInvoiced),
      earned: all((r) => r.earned),
      paid: all((r) => r.paid),
    },
    asOf: now,
  };
}

/** How many decimal places a currency's amounts have: 2 for INR and USD, 0 for JPY (as csv.ts and revenue.ts). */
function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

const major = (minor: number, currency: string): number => {
  const d = minorDigits(currency);
  return Number((minor / 10 ** d).toFixed(d));
};

const REPORT_FIELDS = ["Partner", "Slug", "Kind", "Status", "Customers", "Currency", "MRR", "Net invoiced", "Commission earned", "Commission paid"];
const COUNTRY_FIELDS = ["Country", "Code", "Partner customers", "Direct customers", "Currency", "Partner MRR", "Direct MRR"];

/**
 * The report as CSV: a row per partner and currency (a partner with no money yet has one row with no
 * currency), a blank row, then the country table under its own header. Amounts in each currency's
 * main unit, as numbers; formulae escaped; CRLF.
 */
export async function partnerReportCsv(f: ReportFilters, now = new Date()): Promise<CsvExport> {
  const report = await partnerReport(f, now);
  const amountIn = (list: Money[], currency: string) => {
    const m = list.find((x) => x.currency === currency);
    return m ? major(m.minor, currency) : "";
  };
  const data: (string | number)[][] = [];
  for (const r of report.partners) {
    const currencies = [...new Set([...r.mrr, ...r.netInvoiced, ...r.earned, ...r.paid].map((m) => m.currency))].sort();
    const head = [r.partner.displayName, r.partner.slug, PARTNER_KIND[r.partner.kind].label, PARTNER_STATUS[r.partner.status].label, r.customers];
    if (!currencies.length) data.push([...head, "", "", "", "", ""]);
    for (const c of currencies) data.push([...head, c, amountIn(r.mrr, c), amountIn(r.netInvoiced, c), amountIn(r.earned, c), amountIn(r.paid, c)]);
  }
  const partnerRows = data.length;
  data.push(REPORT_FIELDS.map(() => ""), COUNTRY_FIELDS);
  for (const c of report.countries) {
    const currencies = [...new Set([...c.partnerMrr, ...c.directMrr].map((m) => m.currency))].sort();
    if (!currencies.length) data.push([c.name, c.country, c.partnerCustomers, c.directCustomers, "", "", ""]);
    for (const cur of currencies) data.push([c.name, c.country, c.partnerCustomers, c.directCustomers, cur, amountIn(c.partnerMrr, cur), amountIn(c.directMrr, cur)]);
  }
  const csv = Papa.unparse({ fields: REPORT_FIELDS, data }, { escapeFormulae: true, newline: "\r\n" });
  return { filename: csvFilename(`partner-report-${report.from}-to-${report.to}`, now, indiaClock), csv, rows: partnerRows };
}
