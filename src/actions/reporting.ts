"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { isModuleEnabled } from "@/actions/module";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { logActivity } from "@/lib/activity";
import { csvRow } from "@/lib/csv";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { reportWindow } from "@/lib/analytics/request";
import { resolveDateColumn } from "@/lib/analytics/types";
import {
  blankChart,
  blankDefinition,
  dateRangeSchema,
  definitionSchema,
  filterSchema,
  reportMetaSchema,
  type DateRange,
  type ReportChart,
  type ReportDefinition,
} from "@/lib/reporting/definition";
import { definitionProblem, resultTable } from "@/lib/reporting/engine";
import { accessTo, canEdit, sharedWithWhere, sharedWithWords, visibleWhere, type ReportAccess, type ReportViewer } from "@/lib/reporting/access";
import { describeSource, openSource, reportingCatalog, sourceEntry, SOURCE_GROUPS, type CatalogSource } from "@/lib/reporting/sources";
import { runOpen, type RunOutcome } from "@/lib/reporting/run";
import { REPORT_TEMPLATES, TEMPLATE_CATEGORIES, templateByKey } from "@/lib/reporting/templates";
import { rangeDays } from "@/lib/reporting/window";
import type { ChartRun } from "@/lib/reporting/result";
import type { ActionResult } from "@/actions/company";

/**
 * Reporting & Analytics (owner, 23 Oct 2026): saved reports, their sharing, and running them.
 *
 * Two questions, kept apart. Who may open a saved report — its owner and whoever it is shared with — is
 * src/lib/reporting/access.ts. What it shows them is never answered here: every chart runs as the person looking,
 * through their own access to its source (src/lib/reporting/run.ts), so a report shared with somebody who may see
 * fewer rows shows them fewer rows. A definition sent from the browser is checked field by field before it is kept
 * or run; nothing in it is ever a query.
 *
 * Every export is a function a browser can call directly, so each starts with the Reports module (`reportingUser`)
 * and checks access itself.
 */

type User = { id: string; name: string; departmentId: string | null };

/** The person asking — Reports in their plan and switched on for them — with their department, for shares. */
async function reportingUser(): Promise<User | null> {
  const user = await requireModuleUser("reports");
  if (!(await isModuleEnabled("reports"))) return null;
  const row = await db.user.findUnique({ where: { id: user.id }, select: { name: true, departmentId: true } });
  return { id: user.id, name: row?.name ?? user.name ?? "Someone", departmentId: row?.departmentId ?? null };
}

const OFF = "Reports is switched off for you.";
const MIGRATE = "Reporting will work once your workspace has the latest update.";
const viewerOf = (u: User): ReportViewer => ({ id: u.id, departmentId: u.departmentId });
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** A report's rows and shares, as access needs them. */
const reportInclude = {
  owner: { select: { id: true, name: true } },
  shares: { select: { id: true, userId: true, departmentId: true, canEdit: true, user: { select: { name: true } }, department: { select: { name: true } } } },
} as const;

async function loadReport(id: string, user: User) {
  const report = await db.savedReport.findUnique({ where: { id }, include: reportInclude });
  if (!report) return null;
  const access = accessTo(report, viewerOf(user));
  return access ? { report, access } : null;
}

/** A stored definition, read back through the schema — a row that no longer parses opens as an empty report. */
function storedDefinition(report: { sourceKey: string; definition: unknown }): ReportDefinition {
  const parsed = definitionSchema.safeParse(report.definition);
  return parsed.success ? parsed.data : blankDefinition(report.sourceKey, "createdAt");
}

const MAX_DEFINITION = 200_000;

// ─── The catalogue and templates ─────────────────────────────────────────────

/** Every source, open ones with their fields and the rest locked with the reason; and the templates. */
export async function reportingSetup(): Promise<ActionResult<{ sources: CatalogSource[]; templates: TemplateCard[]; groups: string[]; categories: string[]; hasDepartment: boolean }>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  const sources = await reportingCatalog(user.id, isModuleEnabled);
  return { ok: true, data: { sources, templates: templateCards(sources), groups: SOURCE_GROUPS, categories: TEMPLATE_CATEGORIES, hasDepartment: !!user.departmentId } };
}

export type TemplateCard = {
  key: string;
  name: string;
  description: string;
  category: string;
  source: string;
  sourceLabel: string;
  charts: number;
  /** The first chart that isn't a score, for the card's picture. */
  preview: { type: ReportChart["type"] };
  available: boolean;
  lockedReason: string | null;
};

function templateCards(sources: CatalogSource[]): TemplateCard[] {
  return REPORT_TEMPLATES.map((t) => {
    const src = sources.find((s) => s.key === t.definition.source);
    const charts = t.definition.pages.flatMap((p) => p.charts);
    return {
      key: t.key,
      name: t.name,
      description: t.description,
      category: t.category,
      source: t.definition.source,
      sourceLabel: src?.label ?? t.definition.source,
      charts: charts.length,
      preview: { type: (charts.find((c) => c.type !== "score") ?? charts[0]!).type },
      available: !!src?.available,
      lockedReason: src && !src.available ? src.lockedReason : null,
    };
  });
}

/** What the create dialog shows for a source: how many rows this person can see in the range, and its fields. */
export async function previewSource(input: { source: string; dateRange?: DateRange }): Promise<ActionResult<{ rows: number; capped: boolean; source: Extract<CatalogSource, { available: true }> }>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  const found = await openSource(String(input.source ?? ""), user.id, isModuleEnabled);
  if (!found.ok) return { ok: false, error: found.error };
  const { source, entry } = found.open;
  const range = dateRangeSchema.safeParse(input.dateRange ?? { preset: "thisFy" });
  if (!range.success) return { ok: false, error: "That date range isn't valid." };
  const clock = await workspaceClock();
  const days = rangeDays(range.data, clock.today());
  const bounds = reportWindow(clock, days.from, days.to);
  if ("error" in bounds) return { ok: false, error: bounds.error };
  try {
    const rows = await source.load({ userId: user.id, from: bounds.from, to: bounds.to, dateColumn: resolveDateColumn(source, source.dateFields[0]?.key) });
    return { ok: true, data: { rows: rows.length, capped: rows.length >= 50_000, source: describeSource(found.open) } };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: `${entry.label} will work once your workspace has the latest update.` };
    throw err;
  }
}

// ─── Listing ─────────────────────────────────────────────────────────────────

export type ReportRow = {
  id: string;
  name: string;
  description: string;
  source: string;
  sourceLabel: string;
  pages: number;
  charts: number;
  sharedWith: string;
  shared: boolean;
  access: ReportAccess;
  canEdit: boolean;
  favourite: boolean;
  owner: { id: string; name: string; initials: string };
  updatedAt: string;
  createdAt: string;
  /** Whether this person can open what it reads — a report shared with them may read a source their role can't. */
  sourceOpen: boolean;
};

type ListedReport = Prisma.SavedReportGetPayload<{ include: typeof reportInclude & { favourites: { select: { userId: true } } } }>;

function rowOf(report: ListedReport, user: User, open: ReadonlySet<string>): ReportRow {
  const def = storedDefinition(report);
  const access = accessTo(report, viewerOf(user)) ?? "view";
  return {
    id: report.id,
    name: report.name,
    description: report.description ?? "",
    source: report.sourceKey,
    sourceLabel: sourceEntry(report.sourceKey)?.label ?? report.sourceKey,
    pages: def.pages.length,
    charts: def.pages.reduce((n, p) => n + p.charts.length, 0),
    sharedWith: report.ownerId === user.id ? sharedWithWords(report.shares) : `Shared by ${report.owner.name}`,
    shared: report.shares.length > 0,
    access,
    canEdit: canEdit(access),
    favourite: report.favourites.some((f) => f.userId === user.id),
    owner: { id: report.owner.id, name: report.owner.name, initials: initials(report.owner.name) },
    updatedAt: report.updatedAt.toISOString(),
    createdAt: report.createdAt.toISOString(),
    sourceOpen: open.has(report.sourceKey),
  };
}

/** The sources this person can open, by key. */
async function openKeys(user: User): Promise<Set<string>> {
  return new Set((await reportingCatalog(user.id, isModuleEnabled)).filter((s) => s.available).map((s) => s.key));
}

const listSchema = z.object({
  tab: z.enum(["all", "mine", "shared", "favourites"]).default("all"),
  search: z.string().trim().max(100).optional().default(""),
  source: z.string().max(40).optional().default(""),
  status: z.enum(["", "shared", "private"]).optional().default(""),
  sort: z.enum(["edited", "name", "created"]).default("edited"),
  page: z.number().int().min(1).max(1000).default(1),
  pageSize: z.number().int().min(1).max(50).default(10),
});

export async function listReports(input: unknown): Promise<ActionResult<{ rows: ReportRow[]; total: number; counts: { mine: number; shared: number; favourites: number } }>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  const parsed = listSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, error: "That list request isn't valid." };
  const q = parsed.data;
  const viewer = viewerOf(user);
  const tabWhere: Prisma.SavedReportWhereInput =
    q.tab === "mine" ? { ownerId: user.id } : q.tab === "shared" ? sharedWithWhere(viewer) : q.tab === "favourites" ? { AND: [visibleWhere(viewer), { favourites: { some: { userId: user.id } } }] } : visibleWhere(viewer);
  const where: Prisma.SavedReportWhereInput = {
    AND: [
      tabWhere,
      q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { description: { contains: q.search, mode: "insensitive" } }] } : {},
      q.source ? { sourceKey: q.source } : {},
      q.status === "shared" ? { shares: { some: {} } } : q.status === "private" ? { shares: { none: {} } } : {},
    ],
  };
  const orderBy: Prisma.SavedReportOrderByWithRelationInput = q.sort === "name" ? { name: "asc" } : q.sort === "created" ? { createdAt: "desc" } : { updatedAt: "desc" };
  try {
    const [rows, total, mine, shared, favourites, open] = await Promise.all([
      db.savedReport.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { ...reportInclude, favourites: { where: { userId: user.id }, select: { userId: true } } } }),
      db.savedReport.count({ where }),
      db.savedReport.count({ where: { ownerId: user.id } }),
      db.savedReport.count({ where: sharedWithWhere(viewer) }),
      db.savedReport.count({ where: { AND: [visibleWhere(viewer), { favourites: { some: { userId: user.id } } }] } }),
      openKeys(user),
    ]);
    return { ok: true, data: { rows: rows.map((r) => rowOf(r, user, open)), total, counts: { mine, shared, favourites } } };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: MIGRATE };
    throw err;
  }
}

// ─── The overview ────────────────────────────────────────────────────────────

export type HomeKpi = {
  key: string;
  label: string;
  footer: string;
  source: string;
  run: ChartRun;
};

export type ReportingHome = {
  range: DateRange;
  windowLabel: string;
  kpis: HomeKpi[];
  /** With the chart its card draws small — the first one on its first page that isn't a number or a table. */
  favourites: (ReportRow & { previewChart: ReportChart | null })[];
  recentlyViewed: { id: string; name: string; sourceLabel: string; viewedAt: string }[];
  recent: ReportRow[];
  total: number;
  activity: { id: string; who: string; initials: string; what: string; at: string }[];
  templates: TemplateCard[];
  migrated: boolean;
};

/** Headline figures for the overview, in order of preference, each only where its source is open. */
const HOME_KPIS: { key: string; source: string; label: string; footer: string; chart: () => ReportChart }[] = [
  { key: "revenue", source: "invoices", label: "Total revenue", footer: "Accounts · Invoices", chart: () => ({ ...blankChart("k-revenue", "score", "net", null), compare: "previousYear" }) },
  { key: "expenses", source: "expenses", label: "Expense claims", footer: "Accounts · Expense claims", chart: () => ({ ...blankChart("k-expenses", "score", "amount", null), compare: "previousYear" }) },
  { key: "outstanding", source: "invoices", label: "Outstanding invoices", footer: "Accounts · Invoices", chart: () => ({ ...blankChart("k-outstanding", "score", "outstanding", null), compare: "previousYear" }) },
  { key: "stock", source: "stock", label: "Inventory value", footer: "Inventory · Stock on hand", chart: () => ({ ...blankChart("k-stock", "score", "value", null), compare: "none" }) },
  { key: "orders", source: "orders", label: "Order value", footer: "Sales · Sales orders", chart: () => ({ ...blankChart("k-orders", "score", "value", null), compare: "previousYear" }) },
  { key: "collections", source: "payments", label: "Collections", footer: "Accounts · Payments received", chart: () => ({ ...blankChart("k-collections", "score", "amount", null), compare: "previousYear" }) },
  { key: "pipeline", source: "leads", label: "New leads", footer: "CRM · Leads and deals", chart: () => ({ ...blankChart("k-pipeline", "score", "count", null), compare: "previousYear" }) },
];

export async function reportingHome(input?: { range?: unknown }): Promise<ActionResult<ReportingHome>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  const parsedRange = dateRangeSchema.safeParse(input?.range ?? { preset: "thisFy" });
  const range: DateRange = parsedRange.success ? parsedRange.data : { preset: "thisFy" };
  const clock = await workspaceClock();
  const today = clock.today();
  const sources = await reportingCatalog(user.id, isModuleEnabled);

  // The headline figures: four, from whichever sources this person can open.
  const chosen = HOME_KPIS.filter((k) => sources.some((s) => s.key === k.source && s.available)).slice(0, 4);
  const bySource = new Map<string, typeof chosen>();
  for (const k of chosen) bySource.set(k.source, [...(bySource.get(k.source) ?? []), k]);
  const kpis: HomeKpi[] = [];
  await Promise.all(
    [...bySource.entries()].map(async ([key, list]) => {
      const found = await openSource(key, user.id, isModuleEnabled);
      if (!found.ok) return;
      const definition: ReportDefinition = { ...blankDefinition(key, found.open.source.dateFields[0]!.key, range), pages: [{ id: "p1", name: "Home", charts: list.map((k) => k.chart()) }] };
      const ran = await runOpen(user, found.open, { definition, reportName: "Reporting overview" });
      for (const k of list) kpis.push({ key: k.key, label: k.label, footer: k.footer, source: key, run: ran.ok ? (ran.charts[`k-${k.key}`] ?? { ok: false, error: "Not available.", code: "config" }) : { ok: false, error: ran.error, code: "source" } });
    }),
  );
  kpis.sort((a, b) => chosen.findIndex((k) => k.key === a.key) - chosen.findIndex((k) => k.key === b.key));

  const templates = templateCards(sources);
  const viewer = viewerOf(user);
  try {
    const include = { ...reportInclude, favourites: { where: { userId: user.id }, select: { userId: true } } };
    const [favs, recent, total, views] = await Promise.all([
      db.savedReport.findMany({ where: { AND: [visibleWhere(viewer), { favourites: { some: { userId: user.id } } }] }, orderBy: { updatedAt: "desc" }, take: 3, include }),
      db.savedReport.findMany({ where: visibleWhere(viewer), orderBy: { updatedAt: "desc" }, take: 6, include }),
      db.savedReport.count({ where: visibleWhere(viewer) }),
      db.savedReportView.findMany({ where: { userId: user.id, report: visibleWhere(viewer) }, orderBy: { viewedAt: "desc" }, take: 5, include: { report: { select: { id: true, name: true, sourceKey: true } } } }),
    ]);
    const open = new Set(sources.filter((s) => s.available).map((s) => s.key));
    const visibleIds = (await db.savedReport.findMany({ where: visibleWhere(viewer), select: { id: true }, orderBy: { updatedAt: "desc" }, take: 300 })).map((r) => r.id);
    const audit = visibleIds.length
      ? await db.auditLog.findMany({ where: { entityType: "SavedReport", entityId: { in: visibleIds } }, orderBy: { createdAt: "desc" }, take: 6, select: { id: true, entityLabel: true, createdAt: true, userId: true, user: { select: { name: true } } } })
      : [];
    return {
      ok: true,
      data: {
        range,
        windowLabel: rangeDays(range, today).label,
        kpis,
        favourites: favs.map((r) => {
          const def = storedDefinition(r);
          const first = def.pages[0]?.charts.find((c) => c.type !== "score" && c.type !== "table" && c.type !== "pivot");
          return { ...rowOf(r, user, open), previewChart: first ?? null };
        }),
        recentlyViewed: views.map((v) => ({ id: v.report.id, name: v.report.name, sourceLabel: sourceEntry(v.report.sourceKey)?.label ?? v.report.sourceKey, viewedAt: v.viewedAt.toISOString() })),
        recent: recent.map((r) => rowOf(r, user, open)),
        total,
        activity: audit.map((a) => ({ id: a.id, who: a.userId === user.id ? "You" : a.user.name, initials: initials(a.user.name), what: a.entityLabel, at: a.createdAt.toISOString() })),
        templates,
        migrated: true,
      },
    };
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return { ok: true, data: { range, windowLabel: rangeDays(range, today).label, kpis, favourites: [], recentlyViewed: [], recent: [], total: 0, activity: [], templates, migrated: false } };
  }
}

// ─── One report ──────────────────────────────────────────────────────────────

export type OpenedReport = {
  id: string;
  name: string;
  description: string;
  definition: ReportDefinition;
  access: ReportAccess;
  favourite: boolean;
  owner: { id: string; name: string; initials: string };
  sharedWith: string;
  shares: { id: string; userId: string | null; departmentId: string | null; name: string; canEdit: boolean }[];
  updatedAt: string;
  /** The source as this person may use it, or why they can't. */
  source: CatalogSource;
  canExport: boolean;
};

/** A report to view or edit — as this person may: their access to it, and to its source. Records that they opened it. */
export async function openReport(id: string): Promise<ActionResult<OpenedReport>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  try {
    const found = await loadReport(String(id ?? ""), user);
    // The same words whether it doesn't exist or isn't theirs: an id isn't a way to find out what exists.
    if (!found) return { ok: false, error: "That report isn't there, or hasn't been shared with you." };
    const { report, access } = found;
    const definition = storedDefinition(report);
    const opened = await openSource(report.sourceKey, user.id, isModuleEnabled);
    const source: CatalogSource = opened.ok
      ? describeSource(opened.open)
      : { key: report.sourceKey, label: sourceEntry(report.sourceKey)?.label ?? report.sourceKey, group: sourceEntry(report.sourceKey)?.group ?? "Accounts", description: "", available: false, lockedReason: sourceEntry(report.sourceKey)?.lockedReason ?? "Not open to you" };
    const [favourite] = await Promise.all([
      db.savedReportFavourite.findUnique({ where: { userId_reportId: { userId: user.id, reportId: report.id } } }),
      db.savedReportView.upsert({ where: { userId_reportId: { userId: user.id, reportId: report.id } }, create: { userId: user.id, reportId: report.id }, update: { viewedAt: new Date() } }),
    ]);
    const exportPermission = sourceEntry(report.sourceKey)?.exportPermission;
    return {
      ok: true,
      data: {
        id: report.id,
        name: report.name,
        description: report.description ?? "",
        definition,
        access,
        favourite: !!favourite,
        owner: { id: report.owner.id, name: report.owner.name, initials: initials(report.owner.name) },
        sharedWith: sharedWithWords(report.shares),
        // Who it's shared with is the owner's to see and change; others see the summary.
        shares:
          access === "owner"
            ? report.shares.map((s) => ({ id: s.id, userId: s.userId, departmentId: s.departmentId, name: s.user?.name ?? `${s.department?.name ?? "A department"} team`, canEdit: s.canEdit }))
            : [],
        updatedAt: report.updatedAt.toISOString(),
        source,
        canExport: source.available && !!exportPermission && (await can(user.id, exportPermission)),
      },
    };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: MIGRATE };
    throw err;
  }
}

const createSchema = z.object({
  name: z.string().trim().min(1, "Name the report.").max(120),
  description: z.string().trim().max(400).optional().default(""),
  source: z.string().max(40),
  templateKey: z.string().max(60).optional(),
  dateRange: dateRangeSchema.optional(),
  /** Share it with the person's own department as it is made — the dialog's "Access" choice. */
  shareWithDepartment: z.enum(["none", "view", "edit"]).optional().default("none"),
});

/** A new report: blank over a source, or a copy of a template — over a source this person can open. */
export async function createReport(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That report isn't valid." };
  const q = parsed.data;
  const template = q.templateKey ? templateByKey(q.templateKey) : undefined;
  if (q.templateKey && !template) return { ok: false, error: "That template isn't there any more." };
  const sourceKey = template?.definition.source ?? q.source;
  const found = await openSource(sourceKey, user.id, isModuleEnabled);
  if (!found.ok) return { ok: false, error: found.error };
  const { source, entry } = found.open;
  const dateField = source.dateFields[0]!.key;
  const definition: ReportDefinition = template
    ? { ...structuredClone(template.definition), ...(q.dateRange ? { dateRange: q.dateRange } : {}) }
    : blankDefinition(sourceKey, dateField, q.dateRange ?? { preset: "thisFy" });
  // A template names fields every workspace has, but a custom field it can't — checked as any save is.
  const problem = definitionProblem(source, definition, { snapshot: !!entry.snapshot });
  if (problem) return { ok: false, error: problem };
  try {
    const created = await db.savedReport.create({
      data: {
        name: q.name,
        description: q.description || template?.description || null,
        sourceKey,
        definition: definition as unknown as Prisma.InputJsonValue,
        templateKey: template?.key ?? null,
        ownerId: user.id,
        ...(q.shareWithDepartment !== "none" && user.departmentId
          ? { shares: { create: { departmentId: user.departmentId, canEdit: q.shareWithDepartment === "edit", sharedById: user.id } } }
          : {}),
      },
      select: { id: true },
    });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "SavedReport", entityId: created.id, entityLabel: `created ${q.name}` });
    revalidatePath("/reports");
    return { ok: true, data: created };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: MIGRATE };
    throw err;
  }
}

const saveSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string(),
  description: z.string().optional(),
  definition: z.unknown(),
  /** When the copy being saved was opened: a save over somebody else's later one is refused, not lost. */
  baseUpdatedAt: z.string().max(40),
});

export async function saveReport(input: unknown): Promise<ActionResult<{ updatedAt: string }>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That save isn't valid." };
  const meta = reportMetaSchema.safeParse({ name: parsed.data.name, description: parsed.data.description ?? "" });
  if (!meta.success) return { ok: false, error: meta.error.issues[0]?.message ?? "Name the report." };
  if (JSON.stringify(parsed.data.definition ?? null).length > MAX_DEFINITION) return { ok: false, error: "That report is too big to save — split it into two." };
  const def = definitionSchema.safeParse(parsed.data.definition);
  if (!def.success) return { ok: false, error: `The report can't be saved: ${def.error.issues[0]?.message ?? "it isn't valid."}` };
  try {
    const found = await loadReport(parsed.data.id, user);
    if (!found) return { ok: false, error: "That report isn't there, or hasn't been shared with you." };
    if (!canEdit(found.access)) return { ok: false, error: "You can view this report but not change it." };
    if (def.data.source !== found.report.sourceKey) return { ok: false, error: "A report keeps the data source it was made with. Duplicate it to start one over another source." };
    if (found.report.updatedAt.toISOString() !== parsed.data.baseUpdatedAt) {
      return { ok: false, error: "Somebody saved this report after you opened it. Reload to see their changes — yours are still here until you do." };
    }
    const opened = await openSource(found.report.sourceKey, user.id, isModuleEnabled);
    if (!opened.ok) return { ok: false, error: opened.error };
    const problem = definitionProblem(opened.open.source, def.data, { snapshot: !!opened.open.entry.snapshot });
    if (problem) return { ok: false, error: problem };
    const saved = await db.savedReport.update({
      where: { id: found.report.id },
      data: { name: meta.data.name, description: meta.data.description || null, definition: def.data as unknown as Prisma.InputJsonValue },
      select: { updatedAt: true },
    });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "SavedReport", entityId: found.report.id, entityLabel: `edited ${meta.data.name}` });
    revalidatePath("/reports");
    return { ok: true, data: { updatedAt: saved.updatedAt.toISOString() } };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: MIGRATE };
    throw err;
  }
}

/** A copy of a report this person can open, theirs — shared with nobody. */
export async function duplicateReport(id: string): Promise<ActionResult<{ id: string }>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  try {
    const found = await loadReport(String(id ?? ""), user);
    if (!found) return { ok: false, error: "That report isn't there, or hasn't been shared with you." };
    const name = `Copy of ${found.report.name}`.slice(0, 120);
    const created = await db.savedReport.create({
      data: { name, description: found.report.description, sourceKey: found.report.sourceKey, definition: found.report.definition as Prisma.InputJsonValue, templateKey: found.report.templateKey, ownerId: user.id },
      select: { id: true },
    });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "SavedReport", entityId: created.id, entityLabel: `duplicated ${found.report.name}` });
    revalidatePath("/reports");
    return { ok: true, data: created };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: MIGRATE };
    throw err;
  }
}

export async function deleteReport(id: string): Promise<ActionResult<null>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  try {
    const found = await loadReport(String(id ?? ""), user);
    if (!found) return { ok: false, error: "That report isn't there, or hasn't been shared with you." };
    if (found.access !== "owner") return { ok: false, error: "Only the person who made a report can delete it." };
    await db.savedReport.delete({ where: { id: found.report.id } });
    await recordAudit({ userId: user.id, action: "DELETE", entityType: "SavedReport", entityId: found.report.id, entityLabel: `deleted ${found.report.name}` });
    revalidatePath("/reports");
    return { ok: true, data: null };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: MIGRATE };
    throw err;
  }
}

export async function setReportFavourite(id: string, favourite: boolean): Promise<ActionResult<null>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  try {
    const found = await loadReport(String(id ?? ""), user);
    if (!found) return { ok: false, error: "That report isn't there, or hasn't been shared with you." };
    const key = { userId_reportId: { userId: user.id, reportId: found.report.id } };
    if (favourite) await db.savedReportFavourite.upsert({ where: key, create: { userId: user.id, reportId: found.report.id }, update: {} });
    else await db.savedReportFavourite.deleteMany({ where: { userId: user.id, reportId: found.report.id } });
    revalidatePath("/reports");
    return { ok: true, data: null };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: MIGRATE };
    throw err;
  }
}

// ─── Sharing ─────────────────────────────────────────────────────────────────

/** Who a report can be shared with: active people and the departments. Names only. */
export async function shareTargets(): Promise<ActionResult<{ people: { id: string; name: string; department: string | null }[]; departments: { id: string; name: string }[] }>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  const [people, departments] = await Promise.all([
    db.user.findMany({ where: { active: true, id: { not: user.id } }, orderBy: { name: "asc" }, take: 1000, select: { id: true, name: true, department: { select: { name: true } } } }),
    db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return { ok: true, data: { people: people.map((p) => ({ id: p.id, name: p.name, department: p.department?.name ?? null })), departments } };
}

const shareSchema = z.object({
  id: z.string().min(1).max(40),
  shares: z
    .array(z.object({ userId: z.string().max(40).optional(), departmentId: z.string().max(40).optional(), canEdit: z.boolean() }).refine((s) => !!s.userId !== !!s.departmentId, "Each share is a person or a department."))
    .max(200),
});

/** Who a report is shared with, replaced. The owner's alone. Whoever newly gets it is told. */
export async function shareReport(input: unknown): Promise<ActionResult<{ sharedWith: string }>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  const parsed = shareSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That share isn't valid." };
  try {
    const found = await loadReport(parsed.data.id, user);
    if (!found) return { ok: false, error: "That report isn't there, or hasn't been shared with you." };
    if (found.access !== "owner") return { ok: false, error: "Only the person who made a report can share it." };
    const report = found.report;
    // Only real, active people and real departments; never the owner.
    const userIds = [...new Set(parsed.data.shares.flatMap((s) => (s.userId && s.userId !== user.id ? [s.userId] : [])))];
    const deptIds = [...new Set(parsed.data.shares.flatMap((s) => (s.departmentId ? [s.departmentId] : [])))];
    const [people, depts] = await Promise.all([
      db.user.findMany({ where: { id: { in: userIds }, active: true }, select: { id: true } }),
      db.department.findMany({ where: { id: { in: deptIds } }, select: { id: true } }),
    ]);
    const okPeople = new Set(people.map((p) => p.id));
    const okDepts = new Set(depts.map((d) => d.id));
    const wanted = parsed.data.shares.filter((s) => (s.userId ? okPeople.has(s.userId) : s.departmentId ? okDepts.has(s.departmentId) : false));
    const before = new Map(report.shares.map((s) => [s.userId ?? `d:${s.departmentId}`, s.canEdit]));
    await db.$transaction(async (tx) => {
      await tx.savedReportShare.deleteMany({ where: { reportId: report.id } });
      await tx.savedReportShare.createMany({ data: wanted.map((s) => ({ reportId: report.id, userId: s.userId ?? null, departmentId: s.departmentId ?? null, canEdit: s.canEdit, sharedById: user.id })) });
    });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "SavedReport", entityId: report.id, entityLabel: `shared ${report.name}` });

    // Told: a person newly given it or now able to edit it; a department's members, the first time it's theirs.
    const toTell = new Set<string>();
    for (const s of wanted) {
      const was = before.get(s.userId ?? `d:${s.departmentId}`);
      if (was !== undefined && (was || !s.canEdit)) continue;
      if (s.userId) toTell.add(s.userId);
      else if (s.departmentId) {
        const members = await db.user.findMany({ where: { departmentId: s.departmentId, active: true, id: { not: user.id } }, select: { id: true }, take: 200 });
        for (const m of members) toTell.add(m.id);
      }
    }
    await Promise.all(
      [...toTell].map((uid) =>
        notifyUser({ userId: uid, type: "REPORT_SHARED", title: `${user.name} shared “${report.name}” with you`, message: "It shows you the rows your own access allows.", link: `/reports/${report.id}` }),
      ),
    );
    revalidatePath("/reports");
    const after = await db.savedReportShare.findMany({ where: { reportId: report.id }, select: { userId: true, department: { select: { name: true } } } });
    return { ok: true, data: { sharedWith: sharedWithWords(after) } };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: MIGRATE };
    throw err;
  }
}

/** Somebody a report was shared with can't open what it reads: they ask its owner, once a day. */
export async function requestReportAccess(id: string): Promise<ActionResult<null>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  try {
    const found = await loadReport(String(id ?? ""), user);
    if (!found) return { ok: false, error: "That report isn't there, or hasn't been shared with you." };
    if (found.access === "owner") return { ok: false, error: "This is your own report." };
    const entry = sourceEntry(found.report.sourceKey);
    const title = `${user.name} asks for access to what “${found.report.name}” reads`;
    const link = `/reports/${found.report.id}`;
    const recent = await db.notification.findFirst({ where: { userId: found.report.ownerId, type: "REPORT_ACCESS_REQUESTED", title, link, createdAt: { gte: new Date(Date.now() - 86_400_000) } }, select: { id: true } });
    if (!recent) {
      await notifyUser({
        userId: found.report.ownerId,
        type: "REPORT_ACCESS_REQUESTED",
        title,
        message: `It reads ${entry?.label ?? "a source"}, which their role can't open. Access is given in their role or permissions, not by the report.`,
        link,
      });
    }
    return { ok: true, data: null };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: MIGRATE };
    throw err;
  }
}

// ─── Running ─────────────────────────────────────────────────────────────────

const runSchema = z.object({
  reportId: z.string().max(40).optional(),
  definition: z.unknown().optional(),
  chartIds: z.array(z.string().max(40)).max(200).optional(),
  crossFilters: z.array(filterSchema).max(10).optional(),
  dateRange: dateRangeSchema.optional(),
});

/**
 * The definition to run: a saved report's, for anybody who can open it — or, from the builder, the unsaved one
 * being edited, for whoever may edit it (or for a report not saved yet). Either way it runs as the person asking.
 */
async function definitionToRun(user: User, q: z.infer<typeof runSchema>): Promise<{ ok: true; def: ReportDefinition; name?: string } | { ok: false; error: string; code: RunCode }> {
  let sent: ReportDefinition | null = null;
  if (q.definition !== undefined) {
    if (JSON.stringify(q.definition).length > MAX_DEFINITION) return { ok: false, error: "That report is too big to run.", code: "field" };
    const parsed = definitionSchema.safeParse(q.definition);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That report isn't valid.", code: "field" };
    sent = parsed.data;
  }
  if (!q.reportId) return sent ? { ok: true, def: sent } : { ok: false, error: "Nothing to run.", code: "field" };
  const found = await loadReport(q.reportId, user);
  if (!found) return { ok: false, error: "That report isn't there, or hasn't been shared with you.", code: "denied" };
  const stored = storedDefinition(found.report);
  // A viewer runs the report as saved; only somebody who may change it previews changes.
  const def = sent && canEdit(found.access) && sent.source === found.report.sourceKey ? sent : stored;
  return { ok: true, def, name: found.report.name };
}

type RunCode = "denied" | "field" | "migrate" | "source";

export async function runReport(input: unknown): Promise<RunOutcome> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF, code: "denied" };
  const q = runSchema.safeParse(input);
  if (!q.success) return { ok: false, error: "That request isn't valid.", code: "field" };
  try {
    const target = await definitionToRun(user, q.data);
    if (!target.ok) return target;
    const found = await openSource(target.def.source, user.id, isModuleEnabled);
    if (!found.ok) return { ok: false, error: found.error, code: found.locked ? "denied" : "source" };
    return await runOpen(user, found.open, { definition: target.def, chartIds: q.data.chartIds, crossFilters: q.data.crossFilters, dateRange: q.data.dateRange, reportName: target.name });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: MIGRATE, code: "migrate" };
    throw err;
  }
}

/**
 * One chart's figures as a CSV — the same numbers it draws — for somebody who may take this source's data out
 * (src/actions/analytics.ts: export never widens visibility, it decides whether what you can see may leave).
 */
export async function exportReportChart(input: unknown): Promise<ActionResult<{ filename: string; csv: string }>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  const q = runSchema.extend({ chartId: z.string().min(1).max(40) }).safeParse(input);
  if (!q.success) return { ok: false, error: "That export isn't valid." };
  try {
    const target = await definitionToRun(user, q.data);
    if (!target.ok) return { ok: false, error: target.error };
    const entry = sourceEntry(target.def.source);
    if (!entry) return { ok: false, error: "That report can't be exported." };
    if (!(await can(user.id, entry.exportPermission))) {
      await logActivity({ kind: "EXPORT", severity: "WARNING", summary: `${user.name} was refused a download of a ${entry.label.toLowerCase()} report`, metadata: { source: entry.key, refused: true } });
      return {
        ok: false,
        error: entry.exportPermission === "data.exportFinance"
          ? "You can read this report but not download it. Downloading financial data needs the export permission."
          : "You can read this report but not download it. Downloading customer data needs the export permission.",
      };
    }
    const found = await openSource(target.def.source, user.id, isModuleEnabled);
    if (!found.ok) return { ok: false, error: found.error };
    const ran = await runOpen(user, found.open, { definition: target.def, chartIds: [q.data.chartId], crossFilters: q.data.crossFilters, dateRange: q.data.dateRange, reportName: target.name });
    if (!ran.ok) return { ok: false, error: ran.error };
    const run = ran.charts[q.data.chartId];
    if (!run) return { ok: false, error: "That chart isn't in the report." };
    if (!run.ok) return { ok: false, error: run.error };
    const chart = target.def.pages.flatMap((p) => p.charts).find((c) => c.id === q.data.chartId)!;
    const title = chart.title || "Chart";
    const filters = [...target.def.filters, ...(q.data.crossFilters ?? []), ...chart.filters];
    const table = resultTable(run.result);
    const lines = [
      csvRow(["Report", target.name ?? "Unsaved report"]),
      csvRow(["Chart", title]),
      csvRow(["Records", entry.label]),
      ...(ran.window ? [csvRow(["Window", `${ran.window.from} to ${ran.window.to}`])] : [csvRow(["As of", "Today"])]),
      csvRow(["Scope", ran.scopeNote]),
      csvRow(["Run by", user.name]),
      ...(filters.length ? [csvRow(["Filters", `${filters.length} applied`])] : []),
      ...(run.truncated ? [csvRow(["Warning", "Hit the row ceiling — these are floors, not totals."])] : []),
      "",
      ...table.map((row) => csvRow(row)),
    ];
    await logActivity({
      kind: "EXPORT",
      severity: "WARNING",
      summary: `${user.name} downloaded “${title}” from ${target.name ? `“${target.name}”` : "an unsaved report"} — ${table.length - 1} row(s) over ${run.rowCount.toLocaleString("en-IN")} records`,
      metadata: { source: entry.key, chart: q.data.chartId, rows: table.length - 1, records: run.rowCount },
    });
    const slug = (target.name ?? "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "report";
    return { ok: true, data: { filename: `${slug}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}.csv`, csv: lines.join("\n") } };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: MIGRATE };
    throw err;
  }
}

const valuesSchema = z.object({
  source: z.string().max(40),
  field: z.string().max(120),
  dateField: z.string().max(120).optional(),
  dateRange: dateRangeSchema.optional(),
  search: z.string().trim().max(100).optional().default(""),
});

/**
 * The values a field takes, with how many rows have each — for a filter's list. Read from the same rows a report
 * would count for this person (their access, the window), so it never offers a value they can't see, nor hints
 * at one on an account they weren't given.
 */
export async function fieldValues(input: unknown): Promise<ActionResult<{ values: { value: string; rows: number }[]; distinct: number; capped: boolean }>> {
  const user = await reportingUser();
  if (!user) return { ok: false, error: OFF };
  const q = valuesSchema.safeParse(input);
  if (!q.success) return { ok: false, error: "That request isn't valid." };
  const found = await openSource(q.data.source, user.id, isModuleEnabled);
  if (!found.ok) return { ok: false, error: found.error };
  const { source } = found.open;
  const dim = source.dimensions.find((d) => d.key === q.data.field);
  if (!dim) return { ok: false, error: `“${q.data.field}” isn't something you can filter ${source.label.toLowerCase()} by — it may have been removed, or not be open to you.` };
  const clock = await workspaceClock();
  const days = rangeDays(q.data.dateRange ?? { preset: "thisFy" }, clock.today());
  const bounds = reportWindow(clock, days.from, days.to);
  if ("error" in bounds) return { ok: false, error: bounds.error };
  try {
    const rows = await source.load({ userId: user.id, from: bounds.from, to: bounds.to, dateColumn: resolveDateColumn(source, q.data.dateField) });
    const counts = new Map<string, number>();
    for (const row of rows) {
      const v = dim.of(row);
      for (const value of Array.isArray(v) ? v : [v]) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const needle = q.data.search.toLocaleLowerCase("en-IN");
    const all = [...counts.entries()].filter(([v]) => !needle || v.toLocaleLowerCase("en-IN").includes(needle)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { ok: true, data: { values: all.slice(0, 300).map(([value, n]) => ({ value, rows: n })), distinct: all.length, capped: all.length > 300 } };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: MIGRATE };
    throw err;
  }
}
