import Papa from "papaparse";
import {
  Prisma,
  type AttributionSource,
  type BillingInterval,
  type DealStatus,
  type PartnerApplicationStatus,
  type PartnerKind,
  type PartnerRequestKind,
  type PartnerRequestStatus,
  type PartnerStatus,
  type PlanKind,
  type TenantStatus,
} from "@deskzo/control-client";
import { csvFilename } from "@/lib/console-shared/format";
import { PARTNER_KIND, PARTNER_STATUS } from "@/lib/console-shared/labels";
import { isoDateOrUndefined, one, type RawParams } from "@/lib/console-shared/params";
import type { PartnerDirectoryFilters, RequestTab } from "@/lib/console-shared/partner-params";
import type { CsvExport } from "@/lib/console-shared/types";
import { COUNTRIES } from "@/lib/geo/countries";
import { attributionHistory, type AttributionFlags } from "@/lib/partners/attribution";
import { listPartnerAudit, refLabels } from "@/lib/partners/audit";
import { attributedMrr, customerFacts, type StandingKind } from "@/lib/partners/customers";
import { referralUrl } from "@/lib/partners/referrals";
import { PARTNER_SETTING_KEYS, partnerSettings, partnerTwoFactorDefault, type PartnerSettings } from "@/lib/partners/settings";
import { termsHistory } from "@/lib/partners/terms";
import {
  PARTNER_AUDIT_ACTIONS,
  PARTNER_LIMITS,
  PartnerRefused,
  type Money,
  type Paged,
  type PartnerAuditFilters,
  type PartnerAuditRow,
  type PartnerTwoFactorMode,
  type PartnerUserRow,
  type PayoutMask,
} from "@/lib/partners/types";
import { listPartnerUsers } from "@/lib/partners/users";
import { consoleClock } from "@/lib/platform/console-clock";
import { controlDb } from "@/lib/platform/control-db";
import { indiaClock } from "@/lib/time/zone";

/**
 * What the console shows about partners (spec §9.2–§9.3): the /partners directory and its CSV, a
 * partner's 360 — a loader per tab —, the /partners/requests queue, the workspace 360's Attribution
 * panel, the partner picker and the programme settings. Commissions and statements are
 * commission-data.ts.
 *
 * Plain async functions for server pages and for actions after `requireStaff` (console spec §5.0):
 * every query has an explicit select, and no sealed column is ever selected — bank details, request
 * payloads' sealed copies, passwords, setup links, authenticator secrets and session ids stay in the
 * database; an invitation is named by the hash of its code (an opaque handle), never the code.
 *
 * Money — amounts, MRR, rates, terms, tax ids, the payout mask — is for SELLERS only: a loader with
 * money in it takes `withMoney`, and when it is false the money is not even read. SUPPORT and READONLY
 * see partners, their people and customers, and nothing they are paid.
 *
 * `now` comes last and `asOf: now` goes back where a page shows "Updated". Refusals are PartnerRefused.
 */

const PAGE_SIZE = 50;
const DIRECTORY_EXPORT_CAP = 5_000;
const PIPELINE_ROWS = 200;
const CUSTOMER_ROWS = 500;
const MRR_CONCURRENCY = 4;
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const COUNTRY_NAMES = new Map(COUNTRIES.map((c) => [c.code, c.name]));

/** A partner as a link: `/partners/<slug>`, its name. */
export type PartnerRef = { slug: string; displayName: string };

/** A workspace that is not closed: what "a customer" counts. */
const LIVE_TENANT = { status: { not: "DEPROVISIONED" } } as const satisfies Prisma.TenantWhereInput;

/** A current attribution flagged at signup (a conflict, or outside the territories) that nobody has reviewed. */
const FLAGGED_OPEN = { validTo: null, reviewedAt: null, flags: { not: Prisma.AnyNull } } as const satisfies Prisma.TenantAttributionWhereInput;

const cleanId = (value: unknown) => String(value ?? "").trim().slice(0, 40);

function clampPage(page: number, total: number, pageSize: number): number {
  const last = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.max(1, Math.trunc(page) || 1), last);
}

/** Amounts per currency — never added across currencies — the zero ones left out, by currency code. */
export function moneyOf(rows: { currency: string; minor: number | bigint | null | undefined }[]): Money[] {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const currency = r.currency.trim().toUpperCase();
    sums.set(currency, (sums.get(currency) ?? 0) + Number(r.minor ?? 0));
  }
  return [...sums]
    .map(([currency, minor]) => ({ currency, minor }))
    .filter((m) => m.minor !== 0)
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * Names for `createdBy`-style references ("staff:<id>", "partner:<id>", "script", "signup", "tick",
 * "engine"), looked up once for a whole list. Somebody since removed reads as a former one.
 */
export async function refNamer(refs: (string | null | undefined)[]): Promise<(ref: string | null | undefined) => string> {
  const labels = await refLabels(refs);
  return (ref) => {
    if (!ref) return "—";
    if (ref === "signup") return "Signup";
    if (ref === "tick") return "The platform tick";
    if (ref === "engine") return "Commission engine";
    const label = labels.get(ref);
    if (!label || label === ref) {
      if (ref.startsWith("staff:")) return "A former staff member";
      if (ref.startsWith("partner:")) return "A former partner user";
    }
    return label ?? ref;
  };
}

/** MRR per group of workspaces (a partner's customers, a country's), the same rule as everywhere (`attributedMrr`), a few groups at a time. */
export async function mrrByGroup(groups: Map<string, string[]>): Promise<Map<string, Money[]>> {
  const out = new Map<string, Money[]>();
  const keys = [...groups.keys()];
  for (let i = 0; i < keys.length; i += MRR_CONCURRENCY) {
    await Promise.all(
      keys.slice(i, i + MRR_CONCURRENCY).map(async (key) => {
        const ids = groups.get(key) ?? [];
        out.set(key, ids.length ? await attributedMrr(ids) : []);
      }),
    );
  }
  return out;
}

/** Stored attribution flags with the other partners named — for staff only; the portal never sees them. */
export type AttributionFlagsView = { outsideTerritory: boolean; conflicts: { partner: PartnerRef | null; source: AttributionSource }[] };

function flagsOf(raw: unknown): AttributionFlags | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const x = raw as { outsideTerritory?: unknown; conflicts?: unknown };
  const conflicts = Array.isArray(x.conflicts)
    ? x.conflicts.flatMap((c) => {
        const row = c as { partnerId?: unknown; source?: unknown } | null;
        return row && typeof row.partnerId === "string" && typeof row.source === "string" ? [{ partnerId: row.partnerId, source: row.source as AttributionSource }] : [];
      })
    : [];
  if (x.outsideTerritory !== true && !conflicts.length) return null;
  return { ...(x.outsideTerritory === true ? { outsideTerritory: true as const } : {}), ...(conflicts.length ? { conflicts } : {}) };
}

/** Flags as staff read them: every conflicting partner named, looked up once for a whole list. */
async function flagViews(raws: unknown[]): Promise<(raw: unknown) => AttributionFlagsView | null> {
  const ids = [...new Set(raws.flatMap((r) => flagsOf(r)?.conflicts?.map((c) => c.partnerId) ?? []))];
  const partners = ids.length ? await controlDb().partner.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true, displayName: true } }) : [];
  const byId = new Map(partners.map((p) => [p.id, { slug: p.slug, displayName: p.displayName }]));
  return (raw) => {
    const flags = flagsOf(raw);
    if (!flags) return null;
    return { outsideTerritory: flags.outsideTerritory === true, conflicts: (flags.conflicts ?? []).map((c) => ({ partner: byId.get(c.partnerId) ?? null, source: c.source })) };
  };
}

function maskOf(raw: unknown): PayoutMask | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const x = raw as Record<string, unknown>;
  const str = (k: string) => (typeof x[k] === "string" ? (x[k] as string) : null);
  if (!str("accountHolder") || !str("bankName") || !str("last4")) return null;
  return {
    method: "BANK",
    accountHolder: str("accountHolder")!,
    bankName: str("bankName")!,
    country: str("country") ?? "",
    currency: str("currency") ?? "",
    last4: str("last4")!,
    ifsc: str("ifsc"),
    swift: str("swift"),
  };
}

function taxIdsOf(raw: unknown): { kind: string; value: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) => {
    const row = t as { kind?: unknown; value?: unknown } | null;
    return row && typeof row.kind === "string" && typeof row.value === "string" ? [{ kind: row.kind, value: row.value }] : [];
  });
}

// ─── Review counts (the /partners KPI, the requests tabs) ────────────────────────────────────────

/** What waits on staff: applications not yet decided, deals and requests pending, flagged attributions not reviewed. */
export type PartnerReviewCounts = { applications: number; deals: number; changes: number; resellers: number; attributions: number; total: number };

export async function partnerReviewCounts(): Promise<PartnerReviewCounts> {
  const control = controlDb();
  const [applications, deals, changes, resellers, attributions] = await Promise.all([
    control.partnerApplication.count({ where: { status: { in: ["NEW", "REVIEWING"] } } }),
    control.dealRegistration.count({ where: { status: "PENDING" } }),
    control.partnerRequest.count({ where: { status: "PENDING", kind: { in: ["PROFILE", "PAYOUT"] } } }),
    control.partnerRequest.count({ where: { status: "PENDING", kind: "NEW_RESELLER" } }),
    control.tenantAttribution.count({ where: FLAGGED_OPEN }),
  ]);
  return { applications, deals, changes, resellers, attributions, total: applications + deals + changes + resellers + attributions };
}

// ─── The directory (/partners) ───────────────────────────────────────────────────────────────────

/** One row of the directory. `mrr` and `pending` (PENDING commission) are null without money. */
export type PartnerDirectoryRow = {
  id: string;
  slug: string;
  displayName: string;
  legalName: string;
  kind: PartnerKind;
  status: PartnerStatus;
  territories: string[];
  parent: PartnerRef | null;
  /** Workspaces attributed to it now, closed ones left out. */
  customers: number;
  /** Active portal users. */
  users: number;
  createdAt: Date;
  mrr: Money[] | null;
  pending: Money[] | null;
};

/** The whole programme at a glance — not the filters. `mrr` and `toReview` are SELLERS' (null without money). */
export type PartnerDirectoryKpis = {
  active: number;
  distributors: number;
  resellers: number;
  customers: number;
  mrr: Money[] | null;
  toReview: number | null;
};

export type PartnerDirectory = Paged<PartnerDirectoryRow> & {
  kpis: PartnerDirectoryKpis;
  /** Every distributor, for the "Distributor" filter and the New partner dialog's parent picker. */
  distributors: (PartnerRef & { status: PartnerStatus; territories: string[] })[];
  asOf: Date;
};

function directoryWhere(f: PartnerDirectoryFilters): Prisma.PartnerWhereInput {
  const q = f.q?.trim();
  return {
    ...(q
      ? {
          OR: [
            { slug: { contains: q, mode: "insensitive" } },
            { displayName: { contains: q, mode: "insensitive" } },
            { legalName: { contains: q, mode: "insensitive" } },
            { contactEmail: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(f.kind ? { kind: f.kind } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.country ? { territories: { has: f.country } } : {}),
    ...(f.parent ? { parent: { slug: f.parent } } : {}),
  };
}

const DIRECTORY_SELECT = {
  id: true,
  slug: true,
  displayName: true,
  legalName: true,
  kind: true,
  status: true,
  territories: true,
  createdAt: true,
  parent: { select: { slug: true, displayName: true } },
  _count: { select: { tenants: { where: LIVE_TENANT }, users: { where: { active: true } } } },
} as const satisfies Prisma.PartnerSelect;

/**
 * The /partners directory: 50 a page, by name, filtered (partner-params.ts), with the programme's
 * KPIs. With money: each row's MRR and PENDING commission, the attributed MRR and the review count.
 */
export async function partnerDirectory(f: PartnerDirectoryFilters, withMoney: boolean, now = new Date()): Promise<PartnerDirectory> {
  const control = controlDb();
  const where = directoryWhere(f);
  const [total, active, distributors, resellers, customers, parents] = await Promise.all([
    control.partner.count({ where }),
    control.partner.count({ where: { status: "ACTIVE" } }),
    control.partner.count({ where: { kind: "DISTRIBUTOR", status: { not: "TERMINATED" } } }),
    control.partner.count({ where: { kind: "RESELLER", status: { not: "TERMINATED" } } }),
    control.tenant.count({ where: { ...LIVE_TENANT, partnerId: { not: null } } }),
    control.partner.findMany({ where: { kind: "DISTRIBUTOR" }, orderBy: [{ displayName: "asc" }, { slug: "asc" }], take: 500, select: { slug: true, displayName: true, status: true, territories: true } }),
  ]);
  const page = clampPage(f.page, total, PAGE_SIZE);
  const rows = total ? await control.partner.findMany({ where, orderBy: [{ displayName: "asc" }, { slug: "asc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, select: DIRECTORY_SELECT }) : [];

  let mrr = new Map<string, Money[]>();
  let pending = new Map<string, Money[]>();
  let kpiMrr: Money[] | null = null;
  let toReview: number | null = null;
  if (withMoney) {
    const ids = rows.map((r) => r.id);
    const [tenants, owed, attributed, review] = await Promise.all([
      ids.length ? control.tenant.findMany({ where: { ...LIVE_TENANT, partnerId: { in: ids } }, select: { id: true, partnerId: true } }) : Promise.resolve([]),
      ids.length ? control.commissionEntry.groupBy({ by: ["partnerId", "currency"], where: { partnerId: { in: ids }, status: "PENDING" }, _sum: { amount: true } }) : Promise.resolve([]),
      control.tenant.findMany({ where: { ...LIVE_TENANT, partnerId: { not: null } }, select: { id: true } }),
      partnerReviewCounts(),
    ]);
    const groups = new Map<string, string[]>();
    for (const t of tenants) if (t.partnerId) groups.set(t.partnerId, [...(groups.get(t.partnerId) ?? []), t.id]);
    mrr = await mrrByGroup(groups);
    pending = new Map(ids.map((id) => [id, moneyOf(owed.filter((o) => o.partnerId === id).map((o) => ({ currency: o.currency, minor: o._sum.amount })))]));
    kpiMrr = attributed.length ? await attributedMrr(attributed.map((t) => t.id)) : [];
    toReview = review.total;
  }

  return {
    rows: rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      displayName: r.displayName,
      legalName: r.legalName,
      kind: r.kind,
      status: r.status,
      territories: r.territories,
      parent: r.parent,
      customers: r._count.tenants,
      users: r._count.users,
      createdAt: r.createdAt,
      mrr: withMoney ? (mrr.get(r.id) ?? []) : null,
      pending: withMoney ? (pending.get(r.id) ?? []) : null,
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    kpis: { active, distributors, resellers, customers, mrr: kpiMrr, toReview },
    distributors: parents,
    asOf: now,
  };
}

const DIRECTORY_CSV_FIELDS = [
  "Slug",
  "Name",
  "Legal name",
  "Kind",
  "Status",
  "Country",
  "Territories",
  "Distributor",
  "Contact name",
  "Contact email",
  "Contact phone",
  "Customers",
  "Active users",
];

/**
 * The directory as the filters say, as CSV — every match, up to 5,000 (more is refused). The partners'
 * contacts, for MANAGERS (spec §12.5); no money, no tax id, no bank detail. Formulae are escaped. When
 * each was created, and the file's date, on the console's clock (Settings › Time zone), named in the header.
 */
export async function partnerDirectoryCsv(f: PartnerDirectoryFilters, now = new Date()): Promise<CsvExport> {
  const [rows, clock] = await Promise.all([
    controlDb().partner.findMany({
      where: directoryWhere(f),
      orderBy: [{ displayName: "asc" }, { slug: "asc" }],
      take: DIRECTORY_EXPORT_CAP + 1,
      select: { ...DIRECTORY_SELECT, country: true, contactName: true, contactEmail: true, contactPhone: true },
    }),
    consoleClock(),
  ]);
  if (rows.length > DIRECTORY_EXPORT_CAP) throw new PartnerRefused(`Narrow it down — at most ${new Intl.NumberFormat("en-IN").format(DIRECTORY_EXPORT_CAP)} partners in one export.`);
  const data = rows.map((r) => [
    r.slug,
    r.displayName,
    r.legalName,
    PARTNER_KIND[r.kind].label,
    PARTNER_STATUS[r.status].label,
    r.country,
    r.territories.join(" "),
    r.parent?.slug ?? "",
    r.contactName,
    r.contactEmail,
    r.contactPhone ?? "",
    r._count.tenants,
    r._count.users,
    clock.input(r.createdAt).replace("T", " "),
  ]);
  const fields = [...DIRECTORY_CSV_FIELDS, `Created (${clock.zone})`];
  return { filename: csvFilename("partners", now, clock), csv: Papa.unparse({ fields, data }, { escapeFormulae: true }), rows: data.length };
}

// ─── A partner's 360: the header ─────────────────────────────────────────────────────────────────

/** What every tab of /partners/<slug> sits under, and the banners' facts. No money in it. */
export type PartnerHeader = {
  id: string;
  slug: string;
  displayName: string;
  legalName: string;
  kind: PartnerKind;
  status: PartnerStatus;
  /** Staff's own words for the last status change — never shown to the partner. */
  statusReason: string | null;
  territories: string[];
  country: string;
  parent: PartnerRef | null;
  createdAt: Date;
  activatedAt: Date | null;
  suspendedAt: Date | null;
  terminatedAt: Date | null;
  /** Banner "No terms in force". */
  termsInForce: boolean;
  /** Banner "No active admin" when 0. */
  activeAdmins: number;
  /** Workspaces attributed to it now (closed ones left out) — the terminated banner's "N customers still attributed". */
  customersStillAttributed: number;
  /** Banner "Payout request waiting". */
  payoutRequestPending: boolean;
  /** Bank details are on file (whether "Reveal payout" has anything to reveal) — a yes or no, never the details. */
  payoutOnFile: boolean;
  asOf: Date;
};

/** The header of /partners/<slug>, or null for an address no partner has (the page turns it into a 404). */
export async function partnerHeader(slug: string, now = new Date()): Promise<PartnerHeader | null> {
  const key = String(slug ?? "").trim().toLowerCase();
  if (!SLUG.test(key)) return null;
  const control = controlDb();
  const p = await control.partner.findUnique({
    where: { slug: key },
    select: {
      id: true,
      slug: true,
      displayName: true,
      legalName: true,
      kind: true,
      status: true,
      statusReason: true,
      territories: true,
      country: true,
      createdAt: true,
      activatedAt: true,
      suspendedAt: true,
      terminatedAt: true,
      payoutUpdatedAt: true,
      parent: { select: { slug: true, displayName: true } },
    },
  });
  if (!p) return null;
  const [terms, admins, customers, payoutRequests] = await Promise.all([
    control.partnerTerms.count({ where: { partnerId: p.id, effectiveFrom: { lte: now } } }),
    control.partnerUser.count({ where: { partnerId: p.id, role: "ADMIN", active: true } }),
    control.tenant.count({ where: { ...LIVE_TENANT, partnerId: p.id } }),
    control.partnerRequest.count({ where: { partnerId: p.id, kind: "PAYOUT", status: "PENDING" } }),
  ]);
  return {
    id: p.id,
    slug: p.slug,
    displayName: p.displayName,
    legalName: p.legalName,
    kind: p.kind,
    status: p.status,
    statusReason: p.statusReason,
    territories: p.territories,
    country: p.country,
    parent: p.parent,
    createdAt: p.createdAt,
    activatedAt: p.activatedAt,
    suspendedAt: p.suspendedAt,
    terminatedAt: p.terminatedAt,
    termsInForce: terms > 0,
    activeAdmins: admins,
    customersStillAttributed: customers,
    payoutRequestPending: payoutRequests > 0,
    // Set whenever details are written (payout.ts); the mask itself is money, and this header is everybody's.
    payoutOnFile: p.payoutUpdatedAt !== null,
    asOf: now,
  };
}

// ─── Overview ────────────────────────────────────────────────────────────────────────────────────

/** A current attribution of one of its customers flagged at signup and not yet reviewed. */
export type PartnerOpenFlag = { attributionId: string; workspace: { slug: string; name: string; country: string }; since: Date; flags: AttributionFlagsView | null };

export type PartnerOverview = {
  profile: {
    legalName: string;
    displayName: string;
    kind: PartnerKind;
    status: PartnerStatus;
    country: string;
    territories: string[];
    website: string | null;
    publicListing: boolean;
    publicBlurb: string | null;
    parent: PartnerRef | null;
    createdAt: Date;
    createdByName: string;
    updatedAt: Date;
  };
  contact: { name: string; email: string; phone: string | null };
  address: { line1: string | null; line2: string | null; city: string | null; region: string | null; postalCode: string | null };
  /** Staff's notes about the partner (MANAGERS edit; every staff member reads) — never shown to the partner. */
  notes: string | null;
  /** SELLERS only; null without money. */
  money: null | {
    taxIds: { kind: string; value: string }[];
    payout: PayoutMask | null;
    payoutUpdatedAt: Date | null;
    mrr: Money[];
    /** Commission earned since 1 January (IST), void entries left out, reversals netted. */
    commissionThisYear: Money[];
  };
  /** A distributor's resellers ([] for a reseller). */
  resellers: (PartnerRef & { status: PartnerStatus; territories: string[]; customers: number })[];
  customers: number;
  flags: PartnerOpenFlag[];
  /** Requests waiting for staff, oldest first. */
  pendingRequests: { id: string; kind: PartnerRequestKind; createdAt: Date }[];
  asOf: Date;
};

/** The Overview tab. Null when the partner is gone. */
export async function partnerOverview(partnerId: string, withMoney: boolean, now = new Date()): Promise<PartnerOverview | null> {
  const id = cleanId(partnerId);
  const control = controlDb();
  const p = id
    ? await control.partner.findUnique({
        where: { id },
        select: {
          id: true,
          legalName: true,
          displayName: true,
          kind: true,
          status: true,
          country: true,
          territories: true,
          website: true,
          publicListing: true,
          publicBlurb: true,
          contactName: true,
          contactEmail: true,
          contactPhone: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
          notes: true,
          createdBy: true,
          createdAt: true,
          updatedAt: true,
          parent: { select: { slug: true, displayName: true } },
        },
      })
    : null;
  if (!p) return null;
  // India's year: commission is counted in India's months, as its statements are (src/lib/partners/statements.ts).
  const { year } = indiaClock.parts(now);
  const [resellers, tenants, flagged, requests, names, money] = await Promise.all([
    control.partner.findMany({
      where: { parentId: p.id },
      orderBy: [{ displayName: "asc" }, { slug: "asc" }],
      select: { slug: true, displayName: true, status: true, territories: true, _count: { select: { tenants: { where: LIVE_TENANT } } } },
    }),
    control.tenant.findMany({ where: { ...LIVE_TENANT, partnerId: p.id }, select: { id: true } }),
    control.tenantAttribution.findMany({
      where: { ...FLAGGED_OPEN, partnerId: p.id },
      orderBy: { validFrom: "desc" },
      take: 50,
      select: { id: true, validFrom: true, flags: true, tenant: { select: { slug: true, name: true, country: true } } },
    }),
    control.partnerRequest.findMany({ where: { partnerId: p.id, status: "PENDING" }, orderBy: { createdAt: "asc" }, select: { id: true, kind: true, createdAt: true } }),
    refNamer([p.createdBy]),
    withMoney
      ? Promise.all([
          control.partner.findUnique({ where: { id: p.id }, select: { taxIds: true, payoutMask: true, payoutUpdatedAt: true } }),
          control.commissionEntry.groupBy({
            by: ["currency"],
            where: { partnerId: p.id, status: { not: "VOID" }, earnedAt: { gte: indiaClock.midnight(year, 0, 1), lte: now } },
            _sum: { amount: true },
          }),
        ])
      : Promise.resolve(null),
  ]);
  const flagView = await flagViews(flagged.map((f) => f.flags));
  let moneyView: PartnerOverview["money"] = null;
  if (money) {
    const [held, earned] = money;
    moneyView = {
      taxIds: taxIdsOf(held?.taxIds),
      payout: maskOf(held?.payoutMask),
      payoutUpdatedAt: held?.payoutUpdatedAt ?? null,
      mrr: tenants.length ? await attributedMrr(tenants.map((t) => t.id)) : [],
      commissionThisYear: moneyOf(earned.map((e) => ({ currency: e.currency, minor: e._sum.amount }))),
    };
  }
  return {
    profile: {
      legalName: p.legalName,
      displayName: p.displayName,
      kind: p.kind,
      status: p.status,
      country: p.country,
      territories: p.territories,
      website: p.website,
      publicListing: p.publicListing,
      publicBlurb: p.publicBlurb,
      parent: p.parent,
      createdAt: p.createdAt,
      createdByName: names(p.createdBy),
      updatedAt: p.updatedAt,
    },
    contact: { name: p.contactName, email: p.contactEmail, phone: p.contactPhone },
    address: { line1: p.addressLine1, line2: p.addressLine2, city: p.city, region: p.region, postalCode: p.postalCode },
    notes: p.notes,
    money: moneyView,
    resellers: resellers.map((r) => ({ slug: r.slug, displayName: r.displayName, status: r.status, territories: r.territories, customers: r._count.tenants })),
    customers: tenants.length,
    flags: flagged.map((f) => ({ attributionId: f.id, workspace: f.tenant, since: f.validFrom, flags: flagView(f.flags) })),
    pendingRequests: requests,
    asOf: now,
  };
}

// ─── Customers ───────────────────────────────────────────────────────────────────────────────────

/** One attributed workspace, as staff see it. Money (list prices, MRR) is null without money. */
export type PartnerCustomerRow = {
  attributionId: string;
  tenantId: string;
  slug: string;
  name: string;
  country: string;
  status: TenantStatus;
  createdAt: Date;
  standing: { kind: StandingKind; at: Date | null };
  plans: { key: string; name: string; kind: PlanKind; quantity: number; interval: BillingInterval | null; unitAmount: number | null; currency: string | null }[];
  currency: string | null;
  mrr: Money[] | null;
  renewsAt: Date | null;
  endsAt: Date | null;
  source: AttributionSource;
  reference: string | null;
  /** When it became this partner's. */
  since: Date;
  commissionable: boolean;
  flags: AttributionFlagsView | null;
  reviewedAt: Date | null;
};

export type PartnerCustomers = { rows: PartnerCustomerRow[]; total: number; asOf: Date };

/**
 * The Customers tab: the workspaces attributed to the partner now, the latest first (500 at most;
 * `total` counts them all), with their standing, plans and — with money — MRR (`customerFacts`).
 */
export async function partnerCustomers(partnerId: string, withMoney: boolean, now = new Date()): Promise<PartnerCustomers> {
  const id = cleanId(partnerId);
  if (!id) return { rows: [], total: 0, asOf: now };
  const control = controlDb();
  const where: Prisma.TenantAttributionWhereInput = { partnerId: id, validTo: null };
  const [total, current] = await Promise.all([
    control.tenantAttribution.count({ where }),
    control.tenantAttribution.findMany({
      where,
      orderBy: [{ validFrom: "desc" }, { id: "asc" }],
      take: CUSTOMER_ROWS,
      select: { id: true, tenantId: true, source: true, reference: true, commissionable: true, flags: true, reviewedAt: true, validFrom: true },
    }),
  ]);
  const [facts, flagView] = await Promise.all([customerFacts(current.map((c) => c.tenantId), now), flagViews(current.map((c) => c.flags))]);
  const rows: PartnerCustomerRow[] = [];
  for (const c of current) {
    const f = facts.get(c.tenantId);
    if (!f) continue;
    rows.push({
      attributionId: c.id,
      tenantId: f.tenantId,
      slug: f.slug,
      name: f.name,
      country: f.country,
      status: f.status,
      createdAt: f.createdAt,
      standing: f.standing,
      plans: f.plans.map((pl) => ({ ...pl, unitAmount: withMoney ? pl.unitAmount : null })),
      currency: f.currency,
      mrr: withMoney ? f.mrr : null,
      renewsAt: f.renewsAt,
      endsAt: f.endsAt,
      source: c.source,
      reference: c.reference,
      since: c.validFrom,
      commissionable: c.commissionable,
      flags: flagView(c.flags),
      reviewedAt: c.reviewedAt,
    });
  }
  return { rows, total, asOf: now };
}

// ─── Pipeline ────────────────────────────────────────────────────────────────────────────────────

/** A partner's invitation code, named by the hash of its code — the code itself is shown only once, to whoever made it. */
export type PipelineInvite = {
  codeHash: string;
  codeHint: string | null;
  note: string | null;
  planName: string | null;
  uses: number;
  maxUses: number;
  expiresAt: Date | null;
  state: "live" | "used" | "expired" | "ended";
  createdAt: Date;
  createdByName: string;
  customers: { slug: string; name: string }[];
};

export type PipelineLink = {
  id: string;
  code: string;
  url: string;
  label: string | null;
  planName: string | null;
  signups: number;
  /** Workspaces it brought. */
  customers: number;
  expiresAt: Date | null;
  endedAt: Date | null;
  state: "live" | "expired" | "ended";
  createdAt: Date;
  createdByName: string;
};

export type PipelineDeal = {
  id: string;
  companyName: string;
  domain: string;
  country: string;
  contactName: string | null;
  contactEmail: string | null;
  expectedPlanName: string | null;
  note: string | null;
  status: DealStatus;
  /** APPROVED and past its protection: the daily tick will mark it EXPIRED. */
  lapsed: boolean;
  expiresAt: Date | null;
  decisionNote: string | null;
  decidedAt: Date | null;
  decidedByName: string | null;
  submittedByName: string;
  customer: { slug: string; name: string } | null;
  createdAt: Date;
};

export type PartnerPipeline = {
  invites: PipelineInvite[];
  links: PipelineLink[];
  deals: PipelineDeal[];
  /** How many there are in all — each list holds the latest 200. */
  totals: { invites: number; links: number; deals: number };
  /** Signups started with one of its live codes or links and not yet verified — a count only. */
  signupsInProgress: number;
  asOf: Date;
};

/** The Pipeline tab: invitation codes, referral links, deal registrations (the latest 200 of each) and signups under way. */
export async function partnerPipeline(partnerId: string, now = new Date()): Promise<PartnerPipeline> {
  const id = cleanId(partnerId);
  const empty: PartnerPipeline = { invites: [], links: [], deals: [], totals: { invites: 0, links: 0, deals: 0 }, signupsInProgress: 0, asOf: now };
  if (!id) return empty;
  const control = controlDb();
  const partner = await control.partner.findUnique({ where: { id }, select: { id: true, terminatedAt: true } });
  if (!partner) return empty;

  const [invites, links, deals, inviteTotal, linkTotal, dealTotal] = await Promise.all([
    control.signupInvite.findMany({
      where: { partnerId: id },
      orderBy: [{ createdAt: "desc" }, { codeHash: "asc" }],
      take: PIPELINE_ROWS,
      select: { codeHash: true, codeHint: true, note: true, planKey: true, uses: true, maxUses: true, expiresAt: true, createdAt: true, createdBy: true },
    }),
    control.partnerReferralLink.findMany({
      where: { partnerId: id },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: PIPELINE_ROWS,
      select: { id: true, code: true, label: true, planKey: true, expiresAt: true, endedAt: true, signups: true, createdBy: true, createdAt: true },
    }),
    control.dealRegistration.findMany({
      where: { partnerId: id },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: PIPELINE_ROWS,
      select: {
        id: true,
        companyName: true,
        domain: true,
        country: true,
        contactName: true,
        contactEmail: true,
        expectedPlanKey: true,
        note: true,
        status: true,
        submittedBy: true,
        decidedBy: true,
        decidedAt: true,
        decisionNote: true,
        expiresAt: true,
        createdAt: true,
        tenant: { select: { slug: true, name: true } },
      },
    }),
    control.signupInvite.count({ where: { partnerId: id } }),
    control.partnerReferralLink.count({ where: { partnerId: id } }),
    control.dealRegistration.count({ where: { partnerId: id } }),
  ]);

  const hash8 = (hash: string) => hash.slice(0, 8);
  const inviteRefs = invites.map((i) => `invite:${hash8(i.codeHash)}`);
  const linkRefs = links.map((l) => `link:${l.code}`);
  const planKeys = [...new Set([...invites.map((i) => i.planKey), ...links.map((l) => l.planKey), ...deals.map((d) => d.expectedPlanKey)].filter((k): k is string => !!k))];
  const liveHashes = invites.filter((i) => i.uses < i.maxUses && (!i.expiresAt || i.expiresAt > now)).map((i) => i.codeHash);
  const liveCodes = links.filter((l) => !l.endedAt && (!l.expiresAt || l.expiresAt > now)).map((l) => l.code);

  const [ended, made, plans, names, inProgress] = await Promise.all([
    invites.length
      ? control.partnerAuditLog.findMany({ where: { partnerId: id, action: "invite.end", entityId: { in: invites.map((i) => hash8(i.codeHash)) } }, select: { entityId: true } })
      : Promise.resolve([]),
    inviteRefs.length || linkRefs.length
      ? control.tenantAttribution.findMany({
          where: { partnerId: id, reference: { in: [...inviteRefs, ...linkRefs] } },
          orderBy: { validFrom: "asc" },
          select: { reference: true, tenantId: true, tenant: { select: { slug: true, name: true } } },
        })
      : Promise.resolve([]),
    planKeys.length ? control.plan.findMany({ where: { key: { in: planKeys } }, select: { key: true, name: true } }) : Promise.resolve([]),
    refNamer([...invites.map((i) => i.createdBy), ...links.map((l) => l.createdBy), ...deals.flatMap((d) => [d.submittedBy, d.decidedBy])]),
    liveHashes.length || liveCodes.length
      ? control.pendingSignup.count({
          where: {
            verifiedAt: null,
            codeExpiresAt: { gt: now },
            OR: [...(liveHashes.length ? [{ inviteCodeHash: { in: liveHashes } }] : []), ...(liveCodes.length ? [{ referralCode: { in: liveCodes } }] : [])],
          },
        })
      : Promise.resolve(0),
  ]);
  const endedSet = new Set(ended.map((e) => e.entityId));
  const planName = new Map(plans.map((p) => [p.key, p.name]));
  const byRef = new Map<string, { tenantId: string; slug: string; name: string }[]>();
  for (const m of made) {
    if (!m.reference) continue;
    const list = byRef.get(m.reference) ?? [];
    if (!list.some((x) => x.tenantId === m.tenantId)) list.push({ tenantId: m.tenantId, slug: m.tenant.slug, name: m.tenant.name });
    byRef.set(m.reference, list);
  }

  return {
    invites: invites.map((i) => {
      const expired = !!i.expiresAt && i.expiresAt <= now;
      // Ended by the partner (its invite.end row), or by the termination that set every live code's end to that instant.
      const endedHere = expired && i.uses < i.maxUses && (endedSet.has(hash8(i.codeHash)) || (!!partner.terminatedAt && i.expiresAt!.getTime() === partner.terminatedAt.getTime()));
      return {
        codeHash: i.codeHash,
        codeHint: i.codeHint,
        note: i.note,
        planName: i.planKey ? (planName.get(i.planKey) ?? i.planKey) : null,
        uses: i.uses,
        maxUses: i.maxUses,
        expiresAt: i.expiresAt,
        state: i.uses >= i.maxUses ? "used" : endedHere ? "ended" : expired ? "expired" : "live",
        createdAt: i.createdAt,
        createdByName: names(i.createdBy),
        customers: (byRef.get(`invite:${hash8(i.codeHash)}`) ?? []).map(({ slug, name }) => ({ slug, name })),
      };
    }),
    links: links.map((l) => ({
      id: l.id,
      code: l.code,
      url: referralUrl(l.code),
      label: l.label,
      planName: l.planKey ? (planName.get(l.planKey) ?? l.planKey) : null,
      signups: l.signups,
      customers: (byRef.get(`link:${l.code}`) ?? []).length,
      expiresAt: l.expiresAt,
      endedAt: l.endedAt,
      state: l.endedAt ? "ended" : l.expiresAt && l.expiresAt <= now ? "expired" : "live",
      createdAt: l.createdAt,
      createdByName: names(l.createdBy),
    })),
    deals: deals.map((d) => ({
      id: d.id,
      companyName: d.companyName,
      domain: d.domain,
      country: d.country,
      contactName: d.contactName,
      contactEmail: d.contactEmail,
      expectedPlanName: d.expectedPlanKey ? (planName.get(d.expectedPlanKey) ?? d.expectedPlanKey) : null,
      note: d.note,
      status: d.status,
      lapsed: d.status === "APPROVED" && !!d.expiresAt && d.expiresAt <= now,
      expiresAt: d.expiresAt,
      decisionNote: d.decisionNote,
      decidedAt: d.decidedAt,
      decidedByName: d.decidedBy ? names(d.decidedBy) : null,
      submittedByName: names(d.submittedBy),
      customer: d.tenant,
      createdAt: d.createdAt,
    })),
    totals: { invites: inviteTotal, links: linkTotal, deals: dealTotal },
    signupsInProgress: inProgress,
    asOf: now,
  };
}

// ─── Users ───────────────────────────────────────────────────────────────────────────────────────

export type PartnerUsersView = {
  users: PartnerUserRow[];
  activeUsers: number;
  activeAdmins: number;
  /** At most this many active users a partner. */
  limit: number;
};

/** The Users tab: the partner's portal accounts (never a password, a link or a secret — `listPartnerUsers`). */
export async function partnerUsersView(partnerId: string, now = new Date()): Promise<PartnerUsersView> {
  const users = await listPartnerUsers(cleanId(partnerId), {}, now);
  return {
    users,
    activeUsers: users.filter((u) => u.active).length,
    activeAdmins: users.filter((u) => u.active && u.role === "ADMIN").length,
    limit: PARTNER_LIMITS.users,
  };
}

// ─── Terms (SELLERS) ─────────────────────────────────────────────────────────────────────────────

/** One version of a partner's terms, in basis points (`bpToPercent` shows them). */
export type ConsoleTermsRow = {
  id: string;
  effectiveFrom: Date;
  defaultRateBp: number;
  newRateBp: number | null;
  renewalRateBp: number | null;
  newMonths: number;
  durationMonths: number | null;
  overrideRateBp: number | null;
  territoryRateBp: number | null;
  planRates: { planKey: string; planName: string | null; rateBp: number }[];
  countryRates: { country: string; countryName: string | null; rateBp: number }[];
  note: string | null;
  createdAt: Date;
  createdByName: string;
};

export type PartnerTermsView = {
  kind: PartnerKind;
  /** The row in force now; null: it earns nothing ("No terms in force"). */
  inForce: ConsoleTermsRow | null;
  /** Starting later, the soonest first. */
  scheduled: ConsoleTermsRow[];
  /** Replaced, the latest first. */
  past: ConsoleTermsRow[];
  /** What a plan rate may name in the "New terms" form: plans on offer, never an internal one. */
  plans: { key: string; name: string }[];
};

/**
 * The Terms tab — money, so SELLERS only: null without money (the page then says "Commission terms
 * are visible to billing staff."), and null for a partner that is gone.
 */
export async function partnerTermsView(partnerId: string, withMoney: boolean, now = new Date()): Promise<PartnerTermsView | null> {
  if (!withMoney) return null;
  const id = cleanId(partnerId);
  const control = controlDb();
  const partner = id ? await control.partner.findUnique({ where: { id }, select: { kind: true } }) : null;
  if (!partner) return null;
  const history = await termsHistory(id);
  const keys = [...new Set(history.flatMap((t) => t.planRates.map((r) => r.planKey)))];
  const [plans, offered, names] = await Promise.all([
    keys.length ? control.plan.findMany({ where: { key: { in: keys } }, select: { key: true, name: true } }) : Promise.resolve([]),
    control.plan.findMany({ where: { active: true, kind: { not: "INTERNAL" } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { key: true, name: true } }),
    refNamer(history.map((t) => t.createdBy)),
  ]);
  const planName = new Map(plans.map((p) => [p.key, p.name]));
  const rows: ConsoleTermsRow[] = history.map((t) => ({
    id: t.id,
    effectiveFrom: t.effectiveFrom,
    defaultRateBp: t.defaultRateBp,
    newRateBp: t.newRateBp,
    renewalRateBp: t.renewalRateBp,
    newMonths: t.newMonths,
    durationMonths: t.durationMonths,
    overrideRateBp: t.overrideRateBp,
    territoryRateBp: t.territoryRateBp,
    planRates: t.planRates.map((r) => ({ planKey: r.planKey, planName: planName.get(r.planKey) ?? null, rateBp: r.rateBp })),
    countryRates: t.countryRates.map((r) => ({ country: r.country, countryName: COUNTRY_NAMES.get(r.country) ?? null, rateBp: r.rateBp })),
    note: t.note,
    createdAt: t.createdAt,
    createdByName: names(t.createdBy),
  }));
  // History is the latest start first: the first one already started is in force.
  const started = rows.filter((r) => r.effectiveFrom <= now);
  return {
    kind: partner.kind,
    inForce: started[0] ?? null,
    scheduled: rows.filter((r) => r.effectiveFrom > now).reverse(),
    past: started.slice(1),
    plans: offered,
  };
}

// ─── Activity ────────────────────────────────────────────────────────────────────────────────────

/** Actions whose detail holds money (amounts, rates, references, the payout's country and currency). */
const MONEY_ACTIONS = /^(terms|payout|commission|statement|export)\./;

/** The Activity tab's filters from the URL: `action` (a catalogue name, or a prefix ending "."), `from`, `to` (days on the console's clock), `page` — each after `prefix`. */
export function parseActivityFilters(raw: RawParams, prefix = ""): PartnerAuditFilters {
  const action = one(raw, `${prefix}action`, 60);
  const known = action && ((PARTNER_AUDIT_ACTIONS as readonly string[]).includes(action) || /^[a-z-]+\.$/.test(action));
  const from = isoDateOrUndefined(one(raw, `${prefix}from`, 20));
  const to = isoDateOrUndefined(one(raw, `${prefix}to`, 20));
  const n = Number(one(raw, `${prefix}page`, 10));
  return {
    ...(known ? { action } : {}),
    ...(from && to && from > to ? { from: to, to: from } : { ...(from ? { from } : {}), ...(to ? { to } : {}) }),
    page: Number.isInteger(n) && n >= 1 ? Math.min(n, 10_000) : 1,
  };
}

/**
 * The Activity tab: the partner's own log, every row — those it is not shown marked by
 * `visibleToPartner: false`. Without money, the detail of money actions is left out (the title stays).
 */
export async function partnerActivity(partnerId: string, filters: PartnerAuditFilters, withMoney: boolean): Promise<Paged<PartnerAuditRow>> {
  const page = await listPartnerAudit(cleanId(partnerId), filters ?? {}, "staff");
  if (withMoney) return page;
  return { ...page, rows: page.rows.map((r) => (MONEY_ACTIONS.test(r.action) ? { ...r, detail: null } : r)) };
}

// ─── The requests queue (/partners/requests, SELLERS) ────────────────────────────────────────────

export type RequestsBoardFilters = {
  /** "open": what waits on staff (the default); "all": everything, decided too. */
  show: "open" | "all";
  page: number;
};

/** URL keys: `show=all`, `page`. The tab is `parseRequestTab` (partner-params.ts). */
export function parseRequestsFilters(raw: RawParams): RequestsBoardFilters {
  const n = Number(one(raw, "page", 10));
  return { show: one(raw, "show", 10)?.toLowerCase() === "all" ? "all" : "open", page: Number.isInteger(n) && n >= 1 ? Math.min(n, 10_000) : 1 };
}

export type ApplicationQueueRow = {
  id: string;
  companyName: string;
  website: string | null;
  country: string;
  kindWanted: PartnerKind;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  message: string;
  status: PartnerApplicationStatus;
  notes: string | null;
  /** The partner it was turned into. */
  partner: PartnerRef | null;
  handledByName: string | null;
  createdAt: Date;
};

export type DealQueueRow = PipelineDeal & { partner: PartnerRef & { status: PartnerStatus; territories: string[] } };

/** A field of a PROFILE request: what is on file now, and what is asked — as text. */
export type ProfileChange = { field: string; label: string; from: string | null; to: string | null };

export type ChangeQueueRow = {
  id: string;
  kind: Extract<PartnerRequestKind, "PROFILE" | "PAYOUT">;
  status: PartnerRequestStatus;
  partner: PartnerRef;
  requestedByName: string;
  createdAt: Date;
  decidedAt: Date | null;
  decidedByName: string | null;
  decisionNote: string | null;
  /** PROFILE: the fields asked to change. */
  profile: ProfileChange[] | null;
  /** PAYOUT: the new details' mask and the one on file — masks only, never the details. */
  payout: { requested: PayoutMask | null; current: PayoutMask | null } | null;
};

export type ResellerQueueRow = {
  id: string;
  status: PartnerRequestStatus;
  distributor: PartnerRef & { status: PartnerStatus; territories: string[] };
  proposal: { legalName: string; displayName: string; country: string; territories: string[]; contactName: string; contactEmail: string; note: string | null };
  /** A console address to start the approval dialog from (staff choose the final one). */
  suggestedSlug: string;
  requestedByName: string;
  createdAt: Date;
  decidedAt: Date | null;
  decidedByName: string | null;
  decisionNote: string | null;
  /** Approved: the reseller made. */
  resultPartner: PartnerRef | null;
};

export type AttributionQueueRow = {
  id: string;
  workspace: { slug: string; name: string; country: string };
  partner: (PartnerRef & { territories: string[] }) | null;
  source: AttributionSource;
  reference: string | null;
  since: Date;
  flags: AttributionFlagsView | null;
  reviewedAt: Date | null;
  reviewedByName: string | null;
};

export type RequestsBoardRows =
  | { tab: "applications"; rows: ApplicationQueueRow[] }
  | { tab: "deals"; rows: DealQueueRow[] }
  | { tab: "changes"; rows: ChangeQueueRow[] }
  | { tab: "resellers"; rows: ResellerQueueRow[] }
  | { tab: "attributions"; rows: AttributionQueueRow[] };

/**
 * One tab of /partners/requests, 50 a page: waiting deals and requests the oldest first (a queue),
 * everything else the newest first. `counts` are every tab's open items (the tab labels).
 */
export type RequestsBoard = RequestsBoardRows & {
  show: "open" | "all";
  counts: PartnerReviewCounts;
  total: number;
  page: number;
  pageSize: number;
  asOf: Date;
};

const PROFILE_LABELS: Record<string, string> = {
  legalName: "Legal name",
  country: "Country",
  contactName: "Contact name",
  contactEmail: "Contact email",
  addressLine1: "Address line 1",
  addressLine2: "Address line 2",
  city: "City",
  region: "State or region",
  postalCode: "Postal code",
  taxIds: "Tax ids",
};

function profileText(field: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (field === "taxIds") {
    const ids = taxIdsOf(value);
    return ids.length ? ids.map((t) => `${t.kind} ${t.value}`).join("; ") : null;
  }
  if (field === "country" && typeof value === "string") return COUNTRY_NAMES.get(value) ? `${COUNTRY_NAMES.get(value)} (${value})` : value;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function suggestSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return SLUG.test(base) ? base : "";
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** One tab of the requests queue (spec §9.2): applications, deals, profile and payout changes, reseller proposals, flagged attributions. */
export async function requestsBoard(tab: RequestTab, f: RequestsBoardFilters, now = new Date()): Promise<RequestsBoard> {
  const control = controlDb();
  const open = f?.show !== "all";
  const counts = await partnerReviewCounts();
  const base = { show: open ? ("open" as const) : ("all" as const), counts, pageSize: PAGE_SIZE, asOf: now };
  const at = (total: number) => clampPage(f?.page ?? 1, total, PAGE_SIZE);

  if (tab === "applications") {
    const where: Prisma.PartnerApplicationWhereInput = open ? { status: { in: ["NEW", "REVIEWING"] } } : {};
    const total = await control.partnerApplication.count({ where });
    const page = at(total);
    const rows = total
      ? await control.partnerApplication.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          select: {
            id: true,
            companyName: true,
            website: true,
            country: true,
            kindWanted: true,
            contactName: true,
            contactEmail: true,
            contactPhone: true,
            message: true,
            status: true,
            notes: true,
            handledBy: true,
            createdAt: true,
            partner: { select: { slug: true, displayName: true } },
          },
        })
      : [];
    const names = await refNamer(rows.map((r) => r.handledBy));
    return { ...base, tab, total, page, rows: rows.map(({ handledBy, ...r }) => ({ ...r, handledByName: handledBy ? names(handledBy) : null })) };
  }

  if (tab === "deals") {
    const where: Prisma.DealRegistrationWhereInput = open ? { status: "PENDING" } : {};
    const total = await control.dealRegistration.count({ where });
    const page = at(total);
    const rows = total
      ? await control.dealRegistration.findMany({
          where,
          orderBy: [{ createdAt: open ? "asc" : "desc" }, { id: "asc" }],
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          select: {
            id: true,
            companyName: true,
            domain: true,
            country: true,
            contactName: true,
            contactEmail: true,
            expectedPlanKey: true,
            note: true,
            status: true,
            submittedBy: true,
            decidedBy: true,
            decidedAt: true,
            decisionNote: true,
            expiresAt: true,
            createdAt: true,
            tenant: { select: { slug: true, name: true } },
            partner: { select: { slug: true, displayName: true, status: true, territories: true } },
          },
        })
      : [];
    const keys = [...new Set(rows.map((r) => r.expectedPlanKey).filter((k): k is string => !!k))];
    const [plans, names] = await Promise.all([
      keys.length ? control.plan.findMany({ where: { key: { in: keys } }, select: { key: true, name: true } }) : Promise.resolve([]),
      refNamer(rows.flatMap((r) => [r.submittedBy, r.decidedBy])),
    ]);
    const planName = new Map(plans.map((p) => [p.key, p.name]));
    return {
      ...base,
      tab,
      total,
      page,
      rows: rows.map((d) => ({
        id: d.id,
        companyName: d.companyName,
        domain: d.domain,
        country: d.country,
        contactName: d.contactName,
        contactEmail: d.contactEmail,
        expectedPlanName: d.expectedPlanKey ? (planName.get(d.expectedPlanKey) ?? d.expectedPlanKey) : null,
        note: d.note,
        status: d.status,
        lapsed: d.status === "APPROVED" && !!d.expiresAt && d.expiresAt <= now,
        expiresAt: d.expiresAt,
        decisionNote: d.decisionNote,
        decidedAt: d.decidedAt,
        decidedByName: d.decidedBy ? names(d.decidedBy) : null,
        submittedByName: names(d.submittedBy),
        customer: d.tenant,
        createdAt: d.createdAt,
        partner: d.partner,
      })),
    };
  }

  if (tab === "changes" || tab === "resellers") {
    const kinds: PartnerRequestKind[] = tab === "changes" ? ["PROFILE", "PAYOUT"] : ["NEW_RESELLER"];
    const where: Prisma.PartnerRequestWhereInput = { kind: { in: kinds }, ...(open ? { status: "PENDING" } : {}) };
    const total = await control.partnerRequest.count({ where });
    const page = at(total);
    const rows = total
      ? await control.partnerRequest.findMany({
          where,
          orderBy: [{ createdAt: open ? "asc" : "desc" }, { id: "asc" }],
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          // The payload only: a PAYOUT request's is its mask; its sealed copy is never read here.
          select: {
            id: true,
            kind: true,
            status: true,
            payload: true,
            requestedBy: true,
            decidedBy: true,
            decidedAt: true,
            decisionNote: true,
            resultPartnerId: true,
            createdAt: true,
            partner: {
              select: {
                slug: true,
                displayName: true,
                status: true,
                territories: true,
                legalName: true,
                country: true,
                contactName: true,
                contactEmail: true,
                addressLine1: true,
                addressLine2: true,
                city: true,
                region: true,
                postalCode: true,
                taxIds: true,
                payoutMask: true,
              },
            },
          },
        })
      : [];
    const resultIds = [...new Set(rows.map((r) => r.resultPartnerId).filter((x): x is string => !!x))];
    const [results, names] = await Promise.all([
      resultIds.length ? control.partner.findMany({ where: { id: { in: resultIds } }, select: { id: true, slug: true, displayName: true } }) : Promise.resolve([]),
      refNamer(rows.flatMap((r) => [r.requestedBy, r.decidedBy])),
    ]);
    const resultOf = new Map(results.map((p) => [p.id, { slug: p.slug, displayName: p.displayName }]));
    const common = (r: (typeof rows)[number]) => ({
      requestedByName: names(r.requestedBy),
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      decidedByName: r.decidedBy ? names(r.decidedBy) : null,
      decisionNote: r.decisionNote,
    });
    if (tab === "changes") {
      return {
        ...base,
        tab,
        total,
        page,
        rows: rows.map((r) => {
          const payload = (r.payload && typeof r.payload === "object" && !Array.isArray(r.payload) ? r.payload : {}) as Record<string, unknown>;
          const current = r.partner as unknown as Record<string, unknown>;
          return {
            id: r.id,
            kind: r.kind as "PROFILE" | "PAYOUT",
            status: r.status,
            partner: { slug: r.partner.slug, displayName: r.partner.displayName },
            ...common(r),
            profile:
              r.kind === "PROFILE"
                ? Object.keys(PROFILE_LABELS)
                    .filter((field) => payload[field] !== undefined)
                    .map((field) => ({ field, label: PROFILE_LABELS[field]!, from: profileText(field, current[field]), to: profileText(field, payload[field]) }))
                : null,
            payout: r.kind === "PAYOUT" ? { requested: maskOf(payload), current: maskOf(r.partner.payoutMask) } : null,
          };
        }),
      };
    }
    return {
      ...base,
      tab,
      total,
      page,
      rows: rows.map((r) => {
        const x = (r.payload && typeof r.payload === "object" && !Array.isArray(r.payload) ? r.payload : {}) as Record<string, unknown>;
        const proposal = {
          legalName: str(x.legalName),
          displayName: str(x.displayName),
          country: str(x.country),
          territories: Array.isArray(x.territories) ? x.territories.filter((c): c is string => typeof c === "string") : [],
          contactName: str(x.contactName),
          contactEmail: str(x.contactEmail),
          note: typeof x.note === "string" && x.note ? x.note : null,
        };
        return {
          id: r.id,
          status: r.status,
          distributor: { slug: r.partner.slug, displayName: r.partner.displayName, status: r.partner.status, territories: r.partner.territories },
          proposal,
          suggestedSlug: suggestSlug(proposal.displayName),
          ...common(r),
          resultPartner: r.resultPartnerId ? (resultOf.get(r.resultPartnerId) ?? null) : null,
        };
      }),
    };
  }

  // Attributions: current rows flagged at signup — the unreviewed ones, or (all) every flagged current one.
  const where: Prisma.TenantAttributionWhereInput = open ? FLAGGED_OPEN : { validTo: null, flags: { not: Prisma.AnyNull } };
  const total = await control.tenantAttribution.count({ where });
  const page = at(total);
  const rows = total
    ? await control.tenantAttribution.findMany({
        where,
        orderBy: [{ validFrom: "desc" }, { id: "asc" }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          source: true,
          reference: true,
          validFrom: true,
          flags: true,
          reviewedAt: true,
          reviewedBy: true,
          tenant: { select: { slug: true, name: true, country: true } },
          partner: { select: { slug: true, displayName: true, territories: true } },
        },
      })
    : [];
  const [flagView, names] = await Promise.all([flagViews(rows.map((r) => r.flags)), refNamer(rows.map((r) => r.reviewedBy))]);
  return {
    ...base,
    tab: "attributions",
    total,
    page,
    rows: rows.map((r) => ({
      id: r.id,
      workspace: r.tenant,
      partner: r.partner,
      source: r.source,
      reference: r.reference,
      since: r.validFrom,
      flags: flagView(r.flags),
      reviewedAt: r.reviewedAt,
      reviewedByName: r.reviewedBy ? names(r.reviewedBy) : null,
    })),
  };
}

// ─── The workspace 360's Attribution panel ───────────────────────────────────────────────────────

export type WorkspaceAttributionView = {
  /** The row in force; null: the workspace has never had one (direct). A row with `partner: null` was made direct by staff. */
  current: null | {
    id: string;
    partner: (PartnerRef & { kind: PartnerKind; status: PartnerStatus; territories: string[] }) | null;
    source: AttributionSource;
    reference: string | null;
    commissionable: boolean;
    validFrom: Date;
    flags: AttributionFlagsView | null;
    reviewedAt: Date | null;
    reviewedByName: string | null;
    /** Staff's reason for a STAFF row — staff read it; the partner never does. */
    reason: string | null;
    createdByName: string;
  };
  /** The five rows before the current one, the latest first. */
  history: { id: string; partner: PartnerRef | null; source: AttributionSource; commissionable: boolean; validFrom: Date; validTo: Date | null; createdByName: string; reason: string | null }[];
  /** For the change dialog's "not set up for KE" warning. */
  tenantCountry: string;
};

/** The workspace 360's Attribution panel (every staff member reads it). An unknown workspace reads as direct with no history. */
export async function workspaceAttribution(tenantId: string): Promise<WorkspaceAttributionView> {
  const id = cleanId(tenantId);
  const control = controlDb();
  const tenant = id ? await control.tenant.findUnique({ where: { id }, select: { id: true, country: true } }) : null;
  if (!tenant) return { current: null, history: [], tenantCountry: "" };
  const rows = await attributionHistory(tenant.id, 6);
  const current = rows.find((r) => r.validTo === null) ?? null;
  const [partner, names, flagView] = await Promise.all([
    current?.partner ? control.partner.findUnique({ where: { id: current.partner.id }, select: { slug: true, displayName: true, kind: true, status: true, territories: true } }) : Promise.resolve(null),
    refNamer(rows.flatMap((r) => [r.createdBy, r.reviewedBy])),
    flagViews(current ? [current.flags] : []),
  ]);
  return {
    current: current
      ? {
          id: current.id,
          partner,
          source: current.source,
          reference: current.reference,
          commissionable: current.commissionable,
          validFrom: current.validFrom,
          flags: flagView(current.flags),
          reviewedAt: current.reviewedAt,
          reviewedByName: current.reviewedBy ? names(current.reviewedBy) : null,
          reason: current.reason,
          createdByName: names(current.createdBy),
        }
      : null,
    history: rows
      .filter((r) => r !== current)
      .slice(0, 5)
      .map((r) => ({
        id: r.id,
        partner: r.partner ? { slug: r.partner.slug, displayName: r.partner.displayName } : null,
        source: r.source,
        commissionable: r.commissionable,
        validFrom: r.validFrom,
        validTo: r.validTo,
        createdByName: names(r.createdBy),
        reason: r.reason,
      })),
    tenantCountry: tenant.country,
  };
}

// ─── The partner picker (attribution dialog, adjustments) ────────────────────────────────────────

export type PartnerPickerRow = { id: string; slug: string; displayName: string; kind: PartnerKind; status: PartnerStatus; territories: string[] };

/** Up to 20 partners that are not terminated, matching `q` (slug, name or legal name), by name. */
export async function partnerPicker(q: string): Promise<PartnerPickerRow[]> {
  const text = String(q ?? "").trim().slice(0, 100);
  return controlDb().partner.findMany({
    where: {
      status: { not: "TERMINATED" },
      ...(text
        ? { OR: [{ slug: { contains: text, mode: "insensitive" } }, { displayName: { contains: text, mode: "insensitive" } }, { legalName: { contains: text, mode: "insensitive" } }] }
        : {}),
    },
    orderBy: [{ displayName: "asc" }, { slug: "asc" }],
    take: 20,
    select: { id: true, slug: true, displayName: true, kind: true, status: true, territories: true },
  });
}

// ─── Programme settings ──────────────────────────────────────────────────────────────────────────

export type ProgrammeSettingsView = {
  settings: PartnerSettings;
  /** What two-factor is while nobody has chosen (this environment's default). */
  twoFactorDefault: PartnerTwoFactorMode;
  /** The last change to any of them, and who made it. */
  lastChange: { at: Date; byName: string } | null;
};

/** The /partners "Programme settings" dialog (OWNERS edit, every staff member reads). */
export async function programmeSettingsView(): Promise<ProgrammeSettingsView> {
  const [settings, rows] = await Promise.all([
    partnerSettings(),
    controlDb().platformSetting.findMany({ where: { key: { in: [...PARTNER_SETTING_KEYS] } }, orderBy: { updatedAt: "desc" }, take: 1, select: { updatedAt: true, updatedBy: true } }),
  ]);
  const last = rows[0];
  // `updatedBy` holds a staff member's id, or "script" from the CLI.
  const ref = last?.updatedBy ? (last.updatedBy.includes(":") || last.updatedBy === "script" ? last.updatedBy : `staff:${last.updatedBy}`) : null;
  const names = await refNamer([ref]);
  return { settings, twoFactorDefault: partnerTwoFactorDefault(), lastChange: last ? { at: last.updatedAt, byName: names(ref) } : null };
}
