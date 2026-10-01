import type { Prisma } from "@wroffy/control-client";
import { standingDate, standingOf, type Standing } from "@/lib/billing/lifecycle";
import { formatMoney } from "@/lib/billing/money";
import { istDayKey, plural, when } from "@/lib/console-shared/format";
import { INVOICE_STATUS, SUBSCRIPTION_STATUS, actorLabel, gatewayLabel, jobLabel, noticeLabel, schemaLabel, subscriptionKind } from "@/lib/console-shared/labels";
import type { TerminalState } from "@/lib/console-shared/params";
import { redactSecrets } from "@/lib/console-shared/redact";
import type { CatalogueModuleView, GatewayKey, GatewayModes, InvoiceStatusKey, PlanKindKey, SubscriptionStatusKey, Tone } from "@/lib/console-shared/types";
import { usageDay } from "@/lib/copilot/settings";
import { moduleEntitled, parseEntitlements, type Entitlements } from "@/lib/entitlements";
import { getModuleDefinition } from "@/lib/modules";
import { JOB_SAFE_SELECT, TENANT_SAFE_SELECT, clampInt, staffNameMap, toActivityItems, type SafeTenant } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { DomainRefused } from "@/lib/platform/domain-rules";
import { workspaceDomains, type WorkspaceDomains } from "@/lib/platform/domains";
import { LIVE_STATUSES } from "@/lib/platform/entitlements";
import { RETENTION_DAYS } from "@/lib/platform/lifecycle";
import { liveGatewaySubscription, moduleCatalogue } from "@/lib/platform/plans";
import { ConsoleRefused } from "@/lib/platform/refused";
import { behindBy, workspaceMigrationNames } from "@/lib/platform/schema-info";
import { customDomainsOffered, gatewayModes } from "@/lib/platform/settings";
import { activeSupportGrant, type ActiveGrant } from "@/lib/platform/support";
import { protocolFor } from "@/lib/tenancy/host";
import { subdomainHost } from "@/lib/tenancy/registry";

/**
 * Workspace 360: what the console shows about one workspace, a loader per tab (spec §5.5). The page
 * loads the header first — null is a 404 — then every tab's loader at once, and renders all eight
 * panels (the inactive ones hidden), so every tab is server-rendered.
 *
 * Read from the control plane only — never the workspace's own database (the Operations tab's
 * "Check database" is an action, run on a click). Every select is explicit and every workspace row
 * is read through `TENANT_SAFE_SELECT` or a subset of it (checked by `satisfies`), so no sealed
 * column ever reaches a page. Text written by tools — job errors, migration output, webhook errors —
 * passes through `redactSecrets` before it leaves.
 */

const DAY = 86_400_000;
/** At most this many notes are pinned on one workspace (the actions refuse a sixth). */
export const PIN_CAP = 5;
const GONE = "That workspace no longer exists.";
const FORMER_STAFF = "A former staff member";

/** Proven at compile time to be a subset of the safe select: no sealed column can be added here by mistake. */
const PLAN_TENANT = { status: true, country: true, entitlements: true, seatOverride: true, copilotTokenOverride: true, customDomainOverride: true } as const satisfies Partial<typeof TENANT_SAFE_SELECT>;
const USAGE_TENANT = { entitlements: true, seatOverride: true, copilotTokenOverride: true } as const satisfies Partial<typeof TENANT_SAFE_SELECT>;
const SUPPORT_TENANT = { ownerEmail: true } as const satisfies Partial<typeof TENANT_SAFE_SELECT>;
const OPS_TENANT = { dbName: true, dbRole: true, region: true, schemaVersion: true } as const satisfies Partial<typeof TENANT_SAFE_SELECT>;
/** The provisioning job's columns the Operations tab shows — no owner details, no password hash. */
const OPS_JOB = {
  id: true,
  status: true,
  step: true,
  attempts: true,
  runAfter: true,
  startedAt: true,
  finishedAt: true,
  error: true,
  createdAt: true,
} as const satisfies Partial<typeof JOB_SAFE_SELECT>;
const TIMELINE_JOB = { id: true, createdAt: true, finishedAt: true, status: true, step: true, attempts: true } as const satisfies Partial<typeof JOB_SAFE_SELECT>;

const NOTE_SELECT = { id: true, authorId: true, body: true, pinned: true, createdAt: true, updatedAt: true, editedBy: true } as const satisfies Prisma.TenantNoteSelect;
type NoteRow = Prisma.TenantNoteGetPayload<{ select: typeof NOTE_SELECT }>;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const firstLine = (text: string | null) => (text ? text.split("\n")[0].trim() : "");
const isGateway = (g: GatewayKey): g is "STRIPE" | "RAZORPAY" => g === "STRIPE" || g === "RAZORPAY";
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

// ─── Notes (features F6) ─────────────────────────────────────────────────────────────────────────

export type NoteView = { id: string; body: string; pinned: boolean; createdAt: Date; updatedAt: Date; authorId: string; author: string; editedBy: string | null; mine: boolean };

/** The staff ids a note list names: its authors and whoever last edited each. */
const noteStaffIds = (rows: NoteRow[]) => rows.flatMap((n) => (n.editedBy ? [n.authorId, n.editedBy] : [n.authorId]));

function noteViews(rows: NoteRow[], names: ReadonlyMap<string, string>, viewerId: string): NoteView[] {
  return rows.map((n) => ({
    id: n.id,
    body: n.body,
    pinned: n.pinned,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    authorId: n.authorId,
    author: names.get(n.authorId) ?? FORMER_STAFF,
    editedBy: n.editedBy ? (names.get(n.editedBy) ?? FORMER_STAFF) : null,
    mine: n.authorId === viewerId,
  }));
}

/** Staff notes on a workspace, pinned first, newest first; deleted ones are kept but never shown. The body is plain text, for a text node. */
export async function workspaceNotes(tenantId: string, viewerId: string): Promise<NoteView[]> {
  const rows = await controlDb().tenantNote.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
    take: 100,
    select: NOTE_SELECT,
  });
  return noteViews(rows, await staffNameMap(noteStaffIds(rows)), viewerId);
}

// ─── Header (features F4) ────────────────────────────────────────────────────────────────────────

export type WorkspaceHeader = {
  tenant: SafeTenant & { domains: { host: string; kind: "CUSTOM" | "LEGACY"; status: "PENDING" | "ACTIVE" | "BROKEN"; isPrimary: boolean }[] };
  /** Its own subdomain, and the address links are built on (a live primary custom domain, or the subdomain). */
  host: string;
  primaryHost: string;
  hostUrl: string;
  /** The newest workspace migration this code carries, and how far behind the workspace is. */
  latest: string | null;
  schemaBehind: boolean;
  behindBy: number | null;
  standing: Standing;
  standingAt: Date | null;
  /** Its live subscriptions at a gateway. */
  gatewayPaying: { gateway: "STRIPE" | "RAZORPAY"; status: SubscriptionStatusKey; externalId: string | null }[];
  /** Paying at a gateway and also on a plan given by hand — exempt from billing while it pays (the remedy is `endManualPlan`). */
  exemptWhilePaying: boolean;
  grant: ActiveGrant | null;
  /** Only while it is held: since when, why, and who held it (from the latest `tenant.suspend` entry). */
  hold: { since: Date | null; for: "STAFF" | "BILLING" | null; reason: string | null; by: string | null } | null;
  /** Only once it is closed: when, the final backup's file, and when it may be purged. */
  closed: { at: Date; backup: string | null; purgeDueAt: Date } | null;
  pinnedNotes: NoteView[];
  asOf: Date;
};

/** What a workspace's standing and the "paying at a gateway" flags are worked out from — every subscription it has. */
const HEADER_SUB_SELECT = {
  gateway: true,
  status: true,
  trialEndsAt: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  pastDueSince: true,
  cancelledAt: true,
  externalId: true,
} as const satisfies Prisma.SubscriptionSelect;

const PAYING: readonly SubscriptionStatusKey[] = ["TRIALING", "ACTIVE", "PAST_DUE"];

/**
 * The page's header, banners and summary — null for a slug no workspace has. The addresses come
 * from its own domains (never the registry, so no sealed column is opened); the standing is
 * `standingOf` over its subscriptions, exactly as `billingStanding` works it out, from the one read
 * that also answers "does it pay at a gateway".
 */
export async function workspaceHeader(slug: string, viewerId: string, now = new Date()): Promise<WorkspaceHeader | null> {
  if (typeof slug !== "string" || !slug || slug.length > 100) return null;
  const control = controlDb();
  const tenant = await control.tenant.findUnique({
    where: { slug },
    select: { ...TENANT_SAFE_SELECT, domains: { select: { host: true, kind: true, status: true, isPrimary: true }, orderBy: { createdAt: "asc" } } },
  });
  if (!tenant) return null;

  const [subs, grant, holdRow, closeRow, pinnedRows] = await Promise.all([
    control.subscription.findMany({ where: { tenantId: tenant.id }, select: HEADER_SUB_SELECT }),
    activeSupportGrant(tenant.id, true),
    tenant.status === "SUSPENDED"
      ? control.platformAuditLog.findFirst({ where: { tenantId: tenant.id, action: "tenant.suspend" }, orderBy: { at: "desc" }, select: { at: true, actor: true, actorKind: true, detail: true } })
      : null,
    tenant.status === "DEPROVISIONED"
      ? control.platformAuditLog.findFirst({ where: { tenantId: tenant.id, action: "tenant.deprovision" }, orderBy: { at: "desc" }, select: { at: true, detail: true } })
      : null,
    control.tenantNote.findMany({ where: { tenantId: tenant.id, deletedAt: null, pinned: true }, orderBy: { createdAt: "desc" }, take: PIN_CAP, select: NOTE_SELECT }),
  ]);
  // An entry older than the hold itself is from an earlier one — its reason is not this hold's.
  const holdEntry = holdRow && (!tenant.suspendedAt || holdRow.at.getTime() >= tenant.suspendedAt.getTime() - 60_000) ? holdRow : null;
  const names = await staffNameMap([...noteStaffIds(pinnedRows), ...(holdEntry?.actorKind === "STAFF" ? [holdEntry.actor] : [])]);

  const standing = standingOf(tenant.isDefault, subs, now);
  const gatewayPaying = subs.flatMap((s) => (isGateway(s.gateway) && PAYING.includes(s.status) ? [{ gateway: s.gateway, status: s.status, externalId: s.externalId }] : []));
  const migrations = workspaceMigrationNames();
  const behind = behindBy(tenant.schemaVersion, migrations);
  const host = subdomainHost(tenant.slug);
  // As the registry serves it: a primary that is waiting or stopped is not where links go.
  const primaryHost = tenant.domains.find((d) => d.isPrimary && d.status === "ACTIVE")?.host ?? host;

  let hold: WorkspaceHeader["hold"] = null;
  if (tenant.status === "SUSPENDED") {
    hold = {
      since: tenant.suspendedAt,
      for: tenant.suspendedFor,
      reason: redactSecrets(textOf(record(holdEntry?.detail).reason)),
      by: holdEntry ? actorLabel(holdEntry.actorKind, holdEntry.actor, names) : null,
    };
  }
  let closed: WorkspaceHeader["closed"] = null;
  if (tenant.status === "DEPROVISIONED") {
    const at = tenant.deprovisionedAt ?? closeRow?.at ?? tenant.updatedAt;
    closed = { at, backup: textOf(record(closeRow?.detail).backup), purgeDueAt: new Date(at.getTime() + RETENTION_DAYS * DAY) };
  }

  return {
    tenant,
    host,
    primaryHost,
    hostUrl: `${protocolFor(primaryHost)}://${primaryHost}`,
    latest: migrations.at(-1) ?? null,
    schemaBehind: behind !== null && behind > 0,
    behindBy: behind,
    standing,
    standingAt: standingDate(standing),
    gatewayPaying,
    exemptWhilePaying: gatewayPaying.length > 0 && subs.some((s) => s.gateway === "MANUAL" && s.status === "ACTIVE"),
    grant,
    hold,
    closed,
    pinnedNotes: noteViews(pinnedRows, names, viewerId),
    asOf: now,
  };
}

// ─── Plan & modules (features F4, F16) ───────────────────────────────────────────────────────────

export type PlanPanel = {
  /** The plans on its live subscriptions, by hand or at a gateway. */
  items: { planKey: string; planName: string; kind: PlanKindKey; productKey: string | null; active: boolean; quantity: number; subscriptionId: string; gateway: GatewayKey; status: SubscriptionStatusKey }[];
  entitlements: Entitlements;
  /**
   * Every module a plan decides, and where this workspace stands with it: "plan" (it has it, from its
   * plans), "added" / "taken" (a staff override), "country" (not sold in its country), "none".
   */
  modules: { key: string; label: string; state: "plan" | "added" | "taken" | "none" | "country"; countries: readonly string[] | null; requires: readonly string[] }[];
  overrides: { moduleKey: string; label: string; granted: boolean; reason: string; byStaffId: string; byName: string; createdAt: Date }[];
  /** What its plans may be set to: every plan on sale, and retired ones it is on already — with the product each sells, to group them and keep one plan for each product. */
  choices: { key: string; name: string; kind: PlanKindKey; productKey: string | null; active: boolean; countries: string[] }[];
  limits: {
    seats: number | null;
    copilotTokens: number | null;
    customDomains: number | null;
    seatOverride: number | null;
    copilotTokenOverride: number | null;
    customDomainOverride: number | null;
  };
  /** Whether a save of its plans could go through: not closed, and not paying at a gateway (whose plans change there). */
  canSetPlans: boolean;
  gateway: { gateway: "STRIPE" | "RAZORPAY"; status: SubscriptionStatusKey } | null;
  catalogue: CatalogueModuleView[];
};

export async function workspacePlan(tenantId: string, now = new Date()): Promise<PlanPanel> {
  const control = controlDb();
  const [tenant, items, overrides, gateway] = await Promise.all([
    control.tenant.findUnique({ where: { id: tenantId }, select: PLAN_TENANT }),
    control.subscriptionItem.findMany({
      where: { subscription: { tenantId, status: { in: [...LIVE_STATUSES] } } },
      orderBy: [{ plan: { sortOrder: "asc" } }, { plan: { name: "asc" } }],
      select: {
        quantity: true,
        subscription: { select: { id: true, gateway: true, status: true } },
        plan: { select: { key: true, name: true, kind: true, productKey: true, active: true } },
      },
    }),
    control.tenantModuleOverride.findMany({
      where: { tenantId },
      orderBy: { moduleKey: "asc" },
      select: { moduleKey: true, granted: true, reason: true, byStaffId: true, createdAt: true },
    }),
    liveGatewaySubscription(tenantId, now),
  ]);
  if (!tenant) throw new ConsoleRefused(GONE);

  const currentKeys = [...new Set(items.map((i) => i.plan.key))];
  const [choices, names] = await Promise.all([
    control.plan.findMany({
      where: { OR: [{ active: true }, { key: { in: currentKeys } }] },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { key: true, name: true, kind: true, productKey: true, active: true, countries: true },
    }),
    staffNameMap(overrides.map((o) => o.byStaffId)),
  ]);

  const entitlements = parseEntitlements(tenant.entitlements);
  const catalogue: CatalogueModuleView[] = moduleCatalogue();
  const overrideOf = new Map(overrides.map((o) => [o.moduleKey, o.granted]));
  const stateOf = (m: CatalogueModuleView): PlanPanel["modules"][number]["state"] => {
    if (m.countries && !m.countries.includes(tenant.country)) return "country";
    const granted = overrideOf.get(m.key);
    if (granted === true) return "added";
    if (granted === false) return "taken";
    return moduleEntitled(entitlements, tenant.country, m.key) ? "plan" : "none";
  };

  return {
    items: items.map((i) => ({
      planKey: i.plan.key,
      planName: i.plan.name,
      kind: i.plan.kind,
      productKey: i.plan.productKey,
      active: i.plan.active,
      quantity: i.quantity,
      subscriptionId: i.subscription.id,
      gateway: i.subscription.gateway,
      status: i.subscription.status,
    })),
    entitlements,
    modules: catalogue.map((m) => ({ key: m.key, label: m.label, state: stateOf(m), countries: m.countries, requires: m.requires })),
    overrides: overrides.map((o) => ({
      moduleKey: o.moduleKey,
      label: getModuleDefinition(o.moduleKey)?.label ?? o.moduleKey,
      granted: o.granted,
      reason: o.reason,
      byStaffId: o.byStaffId,
      byName: names.get(o.byStaffId) ?? FORMER_STAFF,
      createdAt: o.createdAt,
    })),
    choices,
    limits: {
      seats: entitlements.seats,
      copilotTokens: entitlements.copilotTokens,
      customDomains: entitlements.customDomains,
      seatOverride: tenant.seatOverride,
      copilotTokenOverride: tenant.copilotTokenOverride,
      customDomainOverride: tenant.customDomainOverride,
    },
    canSetPlans: gateway === null && tenant.status !== "DEPROVISIONED",
    gateway,
    catalogue,
  };
}

// ─── Billing (features F4, E4) ───────────────────────────────────────────────────────────────────

export type SubView = {
  id: string;
  gateway: GatewayKey;
  status: SubscriptionStatusKey;
  /** "Trial", "Given by hand", "Stripe", "Razorpay". */
  kind: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cancelledAt: Date | null;
  cancelAtPeriodEnd: boolean;
  pastDueSince: Date | null;
  externalId: string | null;
  externalCustomerId: string | null;
  currency: string | null;
  interval: "MONTH" | "YEAR" | null;
  syncedAt: Date | null;
  createdAt: Date;
  items: { id: string; quantity: number; plan: { key: string; name: string; kind: PlanKindKey; active: boolean }; price: { amount: number; currency: string; interval: "MONTH" | "YEAR"; perSeat: boolean } | null }[];
};
export type InvoiceView = {
  id: string;
  gateway: GatewayKey;
  externalId: string;
  number: string | null;
  status: InvoiceStatusKey;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  amountPaid: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  issuedAt: Date;
  paidAt: Date | null;
  hostedUrl: string | null;
  pdfUrl: string | null;
};
export type BillingPanel = {
  subscriptions: SubView[];
  /** One page of its invoices, newest first (`INVOICES_PER_PAGE` a page), and how many it has. */
  invoices: InvoiceView[];
  invoiceCount: number;
  /** Paid, per currency — never added across currencies. Minor units. */
  lifetimePaid: { currency: string; minor: number }[];
  notices: { key: string; sentAt: Date; label: string }[];
  events: { id: string; gateway: GatewayKey; type: string; receivedAt: Date; processedAt: Date | null; error: string | null }[];
  /** Its latest trial (a manual subscription with a trial end, running or ended) — what "extend the trial" changes. */
  trial: { subscriptionId: string; status: SubscriptionStatusKey; endsAt: Date | null } | null;
  /** Test or live keys at each gateway, for the dashboard links. Never a key. */
  modes: GatewayModes;
  asOf: Date;
};

export const INVOICES_PER_PAGE = 25;

export async function workspaceBilling(tenantId: string, opts: { invoicePage?: number } = {}, now = new Date()): Promise<BillingPanel> {
  const control = controlDb();
  const page = clampInt(opts?.invoicePage, 1, 10_000, 1);
  const [subscriptions, invoices, invoiceCount, paid, notices, events, modes] = await Promise.all([
    control.subscription.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        status: true,
        gateway: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        cancelledAt: true,
        cancelAtPeriodEnd: true,
        pastDueSince: true,
        externalId: true,
        externalCustomerId: true,
        currency: true,
        interval: true,
        syncedAt: true,
        createdAt: true,
        items: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            quantity: true,
            plan: { select: { key: true, name: true, kind: true, active: true } },
            price: { select: { amount: true, currency: true, interval: true, perSeat: true } },
          },
        },
      },
    }),
    control.invoice.findMany({
      where: { tenantId },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * INVOICES_PER_PAGE,
      take: INVOICES_PER_PAGE,
      select: {
        id: true,
        gateway: true,
        externalId: true,
        number: true,
        status: true,
        currency: true,
        subtotal: true,
        tax: true,
        total: true,
        amountPaid: true,
        periodStart: true,
        periodEnd: true,
        issuedAt: true,
        paidAt: true,
        hostedUrl: true,
        pdfUrl: true,
      },
    }),
    control.invoice.count({ where: { tenantId } }),
    control.invoice.groupBy({ by: ["currency"], where: { tenantId, status: "PAID" }, _sum: { amountPaid: true }, orderBy: { currency: "asc" } }),
    control.billingNotice.findMany({ where: { tenantId }, orderBy: { sentAt: "desc" }, take: 20, select: { key: true, sentAt: true } }),
    control.billingEvent.findMany({
      where: { tenantId },
      orderBy: { receivedAt: "desc" },
      take: 20,
      select: { id: true, gateway: true, type: true, receivedAt: true, processedAt: true, error: true },
    }),
    gatewayModes(),
  ]);

  // The subscription "extend the trial" changes — the same one `setTrialEnd` picks: the newest by hand with a trial end.
  const trialSub = subscriptions.find((s) => s.gateway === "MANUAL" && (s.status === "TRIALING" || s.status === "CANCELLED") && s.trialEndsAt !== null);

  return {
    subscriptions: subscriptions.map((s) => ({ ...s, kind: subscriptionKind(s.gateway, s.status) })),
    invoices,
    invoiceCount,
    lifetimePaid: paid.flatMap((p) => (p._sum.amountPaid ? [{ currency: p.currency, minor: p._sum.amountPaid }] : [])),
    notices: notices.map((n) => ({ key: n.key, sentAt: n.sentAt, label: noticeLabel(n.key) })),
    events: events.map((e) => ({ ...e, error: e.error ? cut(redactSecrets(e.error) ?? "", 1000) : null })),
    trial: trialSub ? { subscriptionId: trialSub.id, status: trialSub.status, endsAt: trialSub.trialEndsAt } : null,
    modes,
    asOf: now,
  };
}

// ─── Usage (features F4, F9) ─────────────────────────────────────────────────────────────────────

export type UsagePoint = { day: Date; seatsUsed: number; seatsLimit: number | null; copilotTokens: number };
export type UsagePanel = {
  /** One snapshot a day, oldest first. `day` is a calendar day (midnight UTC of the Indian date). */
  series: UsagePoint[];
  /** The newest snapshot, even when it is older than the window. */
  latest: UsagePoint | null;
  /** Copilot tokens per Indian calendar month ("2026-09"), oldest first: each month's highest snapshot — they count up through the month. */
  copilotByMonth: { month: string; tokens: number }[];
  limits: { seats: number | null; copilotTokens: number | null; seatOverride: number | null; copilotTokenOverride: number | null };
};

const USAGE_SELECT = { day: true, seatsUsed: true, seatsLimit: true, copilotTokens: true } as const satisfies Prisma.TenantUsageSelect;

export async function workspaceUsage(tenantId: string, days = 90, now = new Date()): Promise<UsagePanel> {
  const control = controlDb();
  const span = clampInt(days, 1, 400, 90);
  // Inclusive on a @db.Date: the first day of the window is in it.
  const from = usageDay(new Date(now.getTime() - (span - 1) * DAY));
  const [tenant, series] = await Promise.all([
    control.tenant.findUnique({ where: { id: tenantId }, select: USAGE_TENANT }),
    control.tenantUsage.findMany({ where: { tenantId, day: { gte: from } }, orderBy: { day: "asc" }, select: USAGE_SELECT }),
  ]);
  if (!tenant) throw new ConsoleRefused(GONE);
  const latest = series.at(-1) ?? (await control.tenantUsage.findFirst({ where: { tenantId }, orderBy: { day: "desc" }, select: USAGE_SELECT }));

  const byMonth = new Map<string, number>();
  for (const point of series) {
    // The column holds the calendar day itself, so its UTC date is the Indian date.
    const month = point.day.toISOString().slice(0, 7);
    byMonth.set(month, Math.max(byMonth.get(month) ?? 0, point.copilotTokens));
  }
  const entitlements = parseEntitlements(tenant.entitlements);
  return {
    series,
    latest,
    copilotByMonth: [...byMonth].map(([month, tokens]) => ({ month, tokens })).sort((a, b) => a.month.localeCompare(b.month)),
    limits: { seats: entitlements.seats, copilotTokens: entitlements.copilotTokens, seatOverride: tenant.seatOverride, copilotTokenOverride: tenant.copilotTokenOverride },
  };
}

// ─── Support (features F4, F23) ──────────────────────────────────────────────────────────────────

export type GrantView = { id: string; level: "READONLY" | "ADMIN"; reason: string; grantedByName: string; createdAt: Date; expiresAt: Date; revokedAt: Date | null; state: "live" | "expired" | "ended" };
export type SupportPanel = {
  grant: ActiveGrant | null;
  grants: GrantView[];
  /** Staff who went in, newest first. */
  entries: { at: Date; staffId: string; staff: string; level: string | null }[];
  /** The last time staff asked its owner for access, and when they may ask again (24 hours on). */
  lastRequest: { at: Date; by: string; byMe: boolean } | null;
  canRequestAgainAt: Date | null;
  ownerEmailKnown: boolean;
};

/** How long after asking a workspace's owner for access staff wait before asking again. */
export const SUPPORT_REQUEST_EVERY_MS = DAY;

export async function workspaceSupport(tenantId: string, viewerId: string, now = new Date()): Promise<SupportPanel> {
  const control = controlDb();
  const [tenant, grant, grants, entries, request] = await Promise.all([
    control.tenant.findUnique({ where: { id: tenantId }, select: SUPPORT_TENANT }),
    activeSupportGrant(tenantId, true),
    control.supportAccessGrant.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, level: true, reason: true, grantedByName: true, createdAt: true, expiresAt: true, revokedAt: true },
    }),
    control.platformAuditLog.findMany({ where: { tenantId, action: "support.enter" }, orderBy: { at: "desc" }, take: 20, select: { at: true, actor: true, detail: true } }),
    control.platformAuditLog.findFirst({ where: { tenantId, action: "support.request" }, orderBy: { at: "desc" }, select: { at: true, actor: true } }),
  ]);
  if (!tenant) throw new ConsoleRefused(GONE);
  const names = await staffNameMap([...entries.map((e) => e.actor), ...(request ? [request.actor] : [])]);
  const againAt = request ? new Date(request.at.getTime() + SUPPORT_REQUEST_EVERY_MS) : null;

  return {
    grant,
    grants: grants.map((g): GrantView => ({ ...g, state: g.revokedAt ? "ended" : g.expiresAt.getTime() <= now.getTime() ? "expired" : "live" })),
    entries: entries.map((e) => {
      const level = record(e.detail).level;
      return { at: e.at, staffId: e.actor, staff: names.get(e.actor) ?? FORMER_STAFF, level: typeof level === "string" ? level : null };
    }),
    lastRequest: request ? { at: request.at, by: names.get(request.actor) ?? FORMER_STAFF, byMe: request.actor === viewerId } : null,
    canRequestAgainAt: againAt && againAt.getTime() > now.getTime() ? againAt : null,
    ownerEmailKnown: !!tenant.ownerEmail,
  };
}

// ─── Operations (features F4) ────────────────────────────────────────────────────────────────────

export type OpsPanel = {
  leases: { job: string; label: string; leasedUntil: Date; holder: string; lastStartedAt: Date | null; lastFinishedAt: Date | null; lastOk: boolean | null; lastError: string | null; runningNow: boolean }[];
  jobs: { id: string; status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED"; step: string; attempts: number; runAfter: Date; startedAt: Date | null; finishedAt: Date | null; error: string | null; createdAt: Date }[];
  migrations: { id: string; runId: string; target: string; startedAt: Date; finishedAt: Date | null; ok: boolean | null; fromVersion: string | null; toVersion: string | null; output: string | null }[];
  terminals: { serial: string; createdAt: Date; lastSeenAt: Date | null; state: TerminalState }[];
  /** Its addresses with their state, records and last check (src/lib/platform/domains.ts), and whether owners may add them now. */
  domains: WorkspaceDomains & { offered: boolean };
  database: { dbName: string | null; dbRole: string | null; region: string; schemaVersion: string | null; latest: string | null; behindBy: number | null };
};

/** A terminal by when it last reached the server: in the last day, the last week, longer ago, or never. */
function terminalState(lastSeenAt: Date | null, now: Date): TerminalState {
  if (!lastSeenAt) return "never";
  const age = now.getTime() - lastSeenAt.getTime();
  return age < DAY ? "live" : age <= 7 * DAY ? "quiet" : "stale";
}

export async function workspaceOps(tenantId: string, now = new Date()): Promise<OpsPanel> {
  const control = controlDb();
  const [tenant, leases, jobs, runs, routes, domains, offered] = await Promise.all([
    control.tenant.findUnique({ where: { id: tenantId }, select: OPS_TENANT }),
    control.tenantJobLease.findMany({
      where: { tenantId },
      orderBy: { job: "asc" },
      select: { job: true, leasedUntil: true, holder: true, lastStartedAt: true, lastFinishedAt: true, lastOk: true, lastError: true },
    }),
    control.provisioningJob.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 5, select: OPS_JOB }),
    control.tenantMigrationRun.findMany({
      where: { tenantId },
      orderBy: { startedAt: "desc" },
      take: 20,
      select: { id: true, runId: true, target: true, startedAt: true, finishedAt: true, ok: true, fromVersion: true, toVersion: true, output: true },
    }),
    control.biometricDeviceRoute.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" }, select: { serial: true, createdAt: true, lastSeenAt: true } }),
    workspaceDomains(tenantId).catch((err) => {
      if (err instanceof DomainRefused) throw new ConsoleRefused(GONE);
      throw err;
    }),
    customDomainsOffered(),
  ]);
  if (!tenant) throw new ConsoleRefused(GONE);
  const migrations = workspaceMigrationNames();

  return {
    leases: leases.map((l) => ({
      ...l,
      label: jobLabel(l.job),
      lastError: redactSecrets(l.lastError),
      runningNow: l.leasedUntil.getTime() > now.getTime() && (!l.lastFinishedAt || (!!l.lastStartedAt && l.lastFinishedAt.getTime() < l.lastStartedAt.getTime())),
    })),
    jobs: jobs.map((j) => ({ ...j, error: redactSecrets(j.error) })),
    migrations: runs.map((r) => ({ ...r, output: redactSecrets(r.output) })),
    terminals: routes.map((t) => ({ ...t, state: terminalState(t.lastSeenAt, now) })),
    domains: { ...domains, offered },
    database: { ...tenant, latest: migrations.at(-1) ?? null, behindBy: behindBy(tenant.schemaVersion, migrations) },
  };
}

// ─── Timeline (features F5) ──────────────────────────────────────────────────────────────────────

export type TimelineKind = "audit" | "billing-event" | "invoice" | "subscription" | "grant" | "notice" | "provisioning" | "migration" | "note" | "handoff";
export const TIMELINE_KINDS: readonly TimelineKind[] = ["audit", "billing-event", "invoice", "subscription", "grant", "notice", "provisioning", "migration", "note", "handoff"];

export type TimelineEvent = {
  /** Unique within a page: the source and its row (and which of a row's moments). */
  id: string;
  at: Date;
  kind: TimelineKind;
  /** Past tense, and never a phrase kept for the roles allowed to act. */
  title: string;
  detail: string | null;
  tone: Tone;
  actor: string | null;
  /** A console page it leads to, one every role may open — or null. */
  href: string | null;
  /** The audit action, a webhook's type, an invoice's number, a reminder's key. */
  code: string | null;
};

/**
 * `before`: only what happened strictly before it — pass the previous page's `nextBefore`.
 * `kinds`: which sources (all when empty or left out).
 *
 * Each happening appears once. When a source that shows it in more detail is asked for as well,
 * the audit entries it duplicates are left out: `support.grant` and `support.end` (grant),
 * `tenant.note.add` (note), `tenant.provision.requested` and `tenant.provision.done`
 * (provisioning), `tenant.migration.failed` (migration). Asked for "audit" alone, they are there.
 */
export type TimelineOptions = { before?: Date; kinds?: TimelineKind[]; limit?: number /* 50, max 100 */ };
/** `nextBefore`: where the next page starts, or null at the end. `todayKey`: today's Indian date, for "Today" / "Yesterday" headings. */
export type TimelinePage = { events: TimelineEvent[]; nextBefore: string | null; todayKey: string };

const COVERED_AUDIT: Partial<Record<TimelineKind, readonly string[]>> = {
  grant: ["support.grant", "support.end"],
  note: ["tenant.note.add"],
  provisioning: ["tenant.provision.requested", "tenant.provision.done"],
  migration: ["tenant.migration.failed"],
};

/** Rows with several moments (a subscription's start, cancellation, failed payment, trial end; a job's start and end) are read whole, up to this many. */
const WHOLE_ROWS = 200;

const levelText = (level: string) => (level === "ADMIN" ? "Administrator" : "Read-only");

/**
 * One workspace's history, newest first, merged from every source asked for.
 *
 * Paging never skips or repeats: each source is read newest first, one more row than the page
 * holds; the page keeps every event strictly newer than the first one that did not fit, and the
 * next page starts just after it (`nextBefore` is that event's time plus a millisecond, the
 * precision the columns keep). Events that share the exact instant therefore stay on one page — a
 * page holds more than `limit` only when more than `limit` things happened at that one instant.
 */
export async function workspaceTimeline(tenantId: string, opts: TimelineOptions = {}, now = new Date()): Promise<TimelinePage> {
  const control = controlDb();
  const limit = clampInt(opts?.limit, 1, 100, 50);
  const take = limit + 1;
  const before = opts?.before instanceof Date && !Number.isNaN(opts.before.getTime()) ? opts.before : null;
  const asked = (opts?.kinds ?? []).filter((k) => TIMELINE_KINDS.includes(k));
  const wanted = asked.length ? asked : TIMELINE_KINDS;
  const has = (kind: TimelineKind) => wanted.includes(kind);
  /** A moment the source has not reached yet (a trial end, a grant's expiry) is not history. */
  const pastBound = before && before.getTime() < now.getTime() ? before : now;
  const lt = before ? { lt: before } : undefined;
  const setAndBefore = before ? { not: null, lt: before } : { not: null };
  const covered = wanted.flatMap((k) => COVERED_AUDIT[k] ?? []);
  /** A source's rows — or none, and no query, when its kind was not asked for. */
  const read = <T>(kind: TimelineKind, run: () => Promise<T[]>): Promise<T[]> => (has(kind) ? run() : Promise.resolve([]));

  const [audit, webhooks, issued, paid, subs, granted, revoked, expired, notices, jobs, runs, notes, handoffs] = await Promise.all([
    read("audit", () =>
      control.platformAuditLog.findMany({
        where: { tenantId, at: lt, ...(covered.length ? { action: { notIn: covered } } : {}) },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        take,
        select: { id: true, at: true, actorKind: true, actor: true, action: true, detail: true },
      }),
    ),
    read("billing-event", () =>
      control.billingEvent.findMany({
        where: { tenantId, receivedAt: lt },
        orderBy: { receivedAt: "desc" },
        take,
        select: { id: true, receivedAt: true, gateway: true, type: true, processedAt: true, error: true },
      }),
    ),
    read("invoice", () =>
      control.invoice.findMany({ where: { tenantId, issuedAt: lt }, orderBy: { issuedAt: "desc" }, take, select: { id: true, issuedAt: true, number: true, status: true, total: true, currency: true } }),
    ),
    read("invoice", () =>
      control.invoice.findMany({ where: { tenantId, paidAt: setAndBefore }, orderBy: { paidAt: "desc" }, take, select: { id: true, paidAt: true, number: true, total: true, currency: true } }),
    ),
    read("subscription", () =>
      control.subscription.findMany({
        where: { tenantId, createdAt: lt },
        orderBy: { createdAt: "desc" },
        take: WHOLE_ROWS,
        select: { id: true, createdAt: true, cancelledAt: true, pastDueSince: true, trialEndsAt: true, gateway: true, status: true },
      }),
    ),
    read("grant", () =>
      control.supportAccessGrant.findMany({ where: { tenantId, createdAt: lt }, orderBy: { createdAt: "desc" }, take, select: { id: true, createdAt: true, expiresAt: true, level: true, grantedByName: true } }),
    ),
    read("grant", () =>
      control.supportAccessGrant.findMany({ where: { tenantId, revokedAt: setAndBefore }, orderBy: { revokedAt: "desc" }, take, select: { id: true, revokedAt: true, level: true } }),
    ),
    read("grant", () =>
      control.supportAccessGrant.findMany({ where: { tenantId, revokedAt: null, expiresAt: { lt: pastBound } }, orderBy: { expiresAt: "desc" }, take, select: { id: true, expiresAt: true, level: true } }),
    ),
    read("notice", () => control.billingNotice.findMany({ where: { tenantId, sentAt: lt }, orderBy: { sentAt: "desc" }, take, select: { key: true, sentAt: true } })),
    read("provisioning", () => control.provisioningJob.findMany({ where: { tenantId, createdAt: lt }, orderBy: { createdAt: "desc" }, take: WHOLE_ROWS, select: TIMELINE_JOB })),
    read("migration", () =>
      control.tenantMigrationRun.findMany({ where: { tenantId, startedAt: lt }, orderBy: { startedAt: "desc" }, take, select: { id: true, startedAt: true, ok: true, fromVersion: true, toVersion: true } }),
    ),
    read("note", () =>
      control.tenantNote.findMany({ where: { tenantId, deletedAt: null, createdAt: lt }, orderBy: { createdAt: "desc" }, take, select: { id: true, createdAt: true, authorId: true, body: true } }),
    ),
    // The pass itself is never read — only when it was used, and what for.
    read("handoff", () => control.platformHandoffTicket.findMany({ where: { tenantId, usedAt: setAndBefore }, orderBy: { usedAt: "desc" }, take, select: { usedAt: true, purpose: true } })),
  ]);
  const names = await staffNameMap([...audit.filter((a) => a.actorKind === "STAFF").map((a) => a.actor), ...notes.map((n) => n.authorId)]);

  const events: TimelineEvent[] = [];
  const add = (e: Omit<TimelineEvent, "detail" | "actor" | "href" | "code"> & Partial<Pick<TimelineEvent, "detail" | "actor" | "href" | "code">>) => {
    if (before && e.at.getTime() >= before.getTime()) return;
    events.push({ detail: null, actor: null, href: null, code: null, ...e });
  };

  for (const item of toActivityItems(audit.map((a) => ({ ...a, tenant: null })), names)) {
    add({ id: `audit:${item.id}`, at: item.at, kind: "audit", title: item.title, detail: item.detail, tone: item.tone, actor: item.actor, href: item.href, code: item.code });
  }
  for (const e of webhooks) {
    const error = firstLine(redactSecrets(e.error));
    const [title, tone]: [string, Tone] = e.error ? ["Webhook failed", "danger"] : e.processedAt ? ["Webhook processed", "neutral"] : ["Webhook waiting", "warning"];
    add({ id: `billing-event:${e.id}`, at: e.receivedAt, kind: "billing-event", title, tone, detail: cut(error ? `${e.type}: ${error}` : e.type, 300), actor: gatewayLabel(e.gateway), code: e.type });
  }
  for (const i of issued) {
    const tone: Tone = i.status === "UNCOLLECTIBLE" ? "danger" : "neutral";
    add({ id: `invoice:${i.id}:issued`, at: i.issuedAt, kind: "invoice", title: "Invoice issued", tone, detail: `${i.number ?? "No number"} · ${formatMoney(i.total, i.currency)} · ${INVOICE_STATUS[i.status].label}`, code: i.number });
  }
  for (const i of paid) {
    if (i.paidAt) add({ id: `invoice:${i.id}:paid`, at: i.paidAt, kind: "invoice", title: "Invoice paid", tone: "success", detail: `${i.number ?? "No number"} · ${formatMoney(i.total, i.currency)}`, code: i.number });
  }
  for (const s of subs) {
    const gateway = isGateway(s.gateway) ? gatewayLabel(s.gateway) : null;
    const trial = s.gateway === "MANUAL" && (s.trialEndsAt !== null || s.status === "TRIALING");
    const detail = `${subscriptionKind(s.gateway, s.status)} · now ${SUBSCRIPTION_STATUS[s.status].label.toLowerCase()}`;
    const base = { kind: "subscription" as const, detail, actor: gateway };
    const started = trial ? "Trial started" : !gateway ? "Plans given by hand" : s.status === "INCOMPLETE" ? `Checkout started at ${gateway}` : `Subscribed through ${gateway}`;
    add({ ...base, id: `subscription:${s.id}:started`, at: s.createdAt, title: started, tone: trial ? "info" : gateway && s.status !== "INCOMPLETE" ? "success" : "neutral" });
    if (s.cancelledAt) {
      const title = trial ? "Trial closed" : !gateway ? "Plans given by hand ended" : `${gateway} subscription cancelled`;
      add({ ...base, id: `subscription:${s.id}:cancelled`, at: s.cancelledAt, title, tone: "warning" });
    }
    if (s.pastDueSince) add({ ...base, id: `subscription:${s.id}:past-due`, at: s.pastDueSince, title: gateway ? `Payment failed at ${gateway}` : "Payment failed", tone: "danger" });
    if (s.trialEndsAt && s.trialEndsAt.getTime() < pastBound.getTime()) {
      add({ ...base, id: `subscription:${s.id}:trial-ended`, at: s.trialEndsAt, title: gateway ? `Trial at ${gateway} ended` : "Trial ended", tone: "neutral" });
    }
  }
  for (const g of granted) {
    add({ id: `grant:${g.id}:granted`, at: g.createdAt, kind: "grant", title: "Support access granted", tone: "info", detail: `${levelText(g.level)} · until ${when(g.expiresAt)}`, actor: g.grantedByName });
  }
  for (const g of revoked) {
    if (g.revokedAt) add({ id: `grant:${g.id}:ended`, at: g.revokedAt, kind: "grant", title: "Support access ended", tone: "neutral", detail: levelText(g.level) });
  }
  for (const g of expired) add({ id: `grant:${g.id}:expired`, at: g.expiresAt, kind: "grant", title: "Support access expired", tone: "neutral", detail: levelText(g.level) });
  for (const n of notices) add({ id: `notice:${n.key}`, at: n.sentAt, kind: "notice", title: "Billing reminder sent", tone: "info", detail: noticeLabel(n.key), code: n.key });
  for (const j of jobs) {
    const detail = `${cut(j.step, 120)} · ${plural(j.attempts, "attempt")}`;
    add({ id: `provisioning:${j.id}:requested`, at: j.createdAt, kind: "provisioning", title: "Setup requested", tone: "neutral", detail });
    if (j.finishedAt) {
      const [title, tone]: [string, Tone] = j.status === "SUCCEEDED" ? ["Setup finished", "success"] : j.status === "FAILED" ? ["Setup failed", "danger"] : ["Setup attempt ended", "warning"];
      add({ id: `provisioning:${j.id}:finished`, at: j.finishedAt, kind: "provisioning", title, tone, detail });
    }
  }
  for (const r of runs) {
    const [title, tone]: [string, Tone] = r.ok === true ? ["Migrated", "success"] : r.ok === false ? ["Migration failed", "danger"] : ["Migration started", "info"];
    add({ id: `migration:${r.id}`, at: r.startedAt, kind: "migration", title, tone, detail: `${schemaLabel(r.fromVersion)} → ${schemaLabel(r.toVersion)}` });
  }
  for (const n of notes) {
    add({ id: `note:${n.id}`, at: n.createdAt, kind: "note", title: "Note added", tone: "neutral", detail: cut(n.body.replace(/\s+/g, " ").trim(), 140), actor: names.get(n.authorId) ?? FORMER_STAFF });
  }
  handoffs.forEach((h, i) => {
    if (!h.usedAt) return;
    const title = h.purpose === "owner-signup" ? "Owner handed in after signup" : h.purpose === "support" ? "Support pass used" : "One-time pass used";
    add({ id: `handoff:${h.usedAt.getTime()}:${i}`, at: h.usedAt, kind: "handoff", title, tone: "info", code: h.purpose });
  });

  events.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const todayKey = istDayKey(now);
  if (events.length <= limit) return { events, nextBefore: null, todayKey };

  // The first event that does not fit: everything strictly newer is on this page, and every source
  // has read at least that far back (each read one more row than the page holds).
  const boundary = events[limit].at.getTime();
  const page = events.filter((e) => e.at.getTime() > boundary);
  if (page.length) return { events: page, nextBefore: new Date(boundary + 1).toISOString(), todayKey };
  // More than a page happened at one instant: all of it goes on this page, and the next starts before it.
  return { events: events.filter((e) => e.at.getTime() === boundary), nextBefore: new Date(boundary).toISOString(), todayKey };
}
