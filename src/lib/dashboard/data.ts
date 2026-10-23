import type { LeadStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { leadAccess, orderAccess, taskAccess } from "@/lib/authz/access";
import { scopeUserIds } from "@/lib/authz/scope";
import { hasEffectivePermission } from "@/actions/permission";
import { isModuleEnabled } from "@/actions/module";
import { listActivity } from "@/actions/activity";
import { getApprovalsInbox } from "@/actions/automate";
import { getDownlineUserIds } from "@/lib/org-chart";
import { salesLeads } from "@/lib/pipeline/server";
import { listLeadMasker, maskLeads } from "@/lib/leads/masking";
import { LEAD_SOURCE_LABELS } from "@/lib/leads/source";
import { companyPath, leadPath } from "@/lib/record-links";
import { formatOrderId } from "@/lib/order-id";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { projectHealthLabels, projectStatusLabels } from "@/lib/projects/status";
import type { ProjectHealth, ProjectStatus } from "@prisma/client";
import { PRIORITY_LABELS, type TaskPriorityKey } from "@/lib/tasks/rules";
import { officeHours } from "@/lib/hr/office-hours";
import { dayTiming } from "@/lib/hr/office-hours-rules";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { fiscalYearOf } from "@/lib/finance/dashboard";
import type { SummaryPart } from "@/actions/dashboard";
import type { Clock } from "@/lib/time/zone";
import {
  DEPARTMENT_FILTER,
  SOURCES,
  SOURCE_ORDER,
  rangeLabel,
  rangeStart,
  shiftDay,
  shortRupees,
  type ActivityIcon,
  type ChartCatalog,
  type ChartData,
  type ChartSpec,
  type FilterDef,
  type KpiCard,
  type RangeKey,
  type SourceKey,
  type Tone,
  type WidgetResult,
} from "@/lib/dashboard/charts";

/**
 * The figures behind the dashboard's charts and headline cards. Server only.
 *
 * Every read goes through the rule its own list follows — `taskAccess` for tasks, `leadAccess` (and the
 * pipeline's `targets.viewAll` line) for leads, HR's own reach for attendance — so a chart can never
 * count a row the page it links to would hide. The "Everyone" filter means everyone *this person* may
 * see, never the company.
 */

export type DashboardContext = {
  userId: string;
  clock: Clock;
  memo: Map<string, Promise<unknown>>;
};

export async function dashboardContext(userId: string): Promise<DashboardContext> {
  return { userId, clock: await workspaceClock(), memo: new Map() };
}

/** One read per request, however many widgets ask for it. */
function once<T>(ctx: DashboardContext, key: string, read: () => Promise<T>): Promise<T> {
  if (!ctx.memo.has(key)) ctx.memo.set(key, read());
  return ctx.memo.get(key) as Promise<T>;
}

// ─── Which sources this person may chart ────────────────────────────────────

const moduleOn = (ctx: DashboardContext, key: string) => once(ctx, `module:${key}`, () => isModuleEnabled(key));

/**
 * The older card each of the newer sources stands in for (src/lib/dashboard/charts.ts CARD_WIDGETS): the
 * source is open exactly where that card was offered — its module open to this person, its permission held
 * (src/actions/dashboard.ts getDashboardWidgetOptions) — and counts what it counted (getDashboardSummary).
 */
const SOURCE_CARD = {
  customers: "companies",
  quotations: "quotations",
  orders: "orders",
  targets: "salesTarget",
  payments: "payments",
  finance: "incomeExpense",
  renewals: "renewals",
  support: "tickets",
  projects: "projectsAtRisk",
  expenses: "expenses",
  vendors: "vendors",
} as const satisfies Partial<Record<SourceKey, string>>;

// Read through the dashboard's actions, which import this module: loaded when asked for, not at start.
const dashboardActions = () => import("@/actions/dashboard");
const offeredCards = (ctx: DashboardContext) =>
  once(ctx, "cards", async () => new Set((await (await dashboardActions()).getDashboardWidgetOptions()).map((w) => w.key)));
/** One part of the older cards' figures, worked out once a request however many widgets show it — and only the parts shown. */
const summaryOf = (ctx: DashboardContext, part: SummaryPart) => once(ctx, `summary:${part}`, async () => (await dashboardActions()).getDashboardSummary([part]));

/** A figure the summary withheld: this person may not see it after all. */
class NotOffered extends Error {}
function offered<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new NotOffered();
  return value;
}

export async function sourceOpen(ctx: DashboardContext, source: SourceKey): Promise<boolean> {
  if (source in SOURCE_CARD) return (await offeredCards(ctx)).has(SOURCE_CARD[source as keyof typeof SOURCE_CARD]);
  switch (source) {
    case "tasks":
    case "team":
      return moduleOn(ctx, "tasks");
    case "leads":
      // Behind "View leads", as the older lead cards are (src/lib/dashboard-widgets.ts).
      return (await moduleOn(ctx, "leads")) && (await once(ctx, "can:leads.view", () => can(ctx.userId, "leads.view")));
    case "attendance":
      return moduleOn(ctx, "hr");
    case "approvals":
      return (await approvalKinds(ctx)).length > 0;
    case "activity":
      return true;
  }
  return false;
}

export async function chartCatalog(ctx: DashboardContext): Promise<ChartCatalog> {
  const open = await Promise.all(SOURCE_ORDER.map((s) => sourceOpen(ctx, s)));
  const sources = SOURCE_ORDER.filter((_, i) => open[i]);
  const departments = await departmentOptions(ctx);
  const filters: ChartCatalog["filters"] = {};
  for (const s of sources) {
    filters[s] = SOURCES[s].filters.map((f): FilterDef => (f.key === DEPARTMENT_FILTER ? { ...f, options: [...f.options, ...departments] } : f));
  }
  return { sources, filters };
}

const departmentOptions = (ctx: DashboardContext) =>
  once(ctx, "departments", async () =>
    (await db.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } })).map((d) => ({ value: d.id, label: d.name })),
  );

// ─── Ranges ─────────────────────────────────────────────────────────────────

type Window = {
  range: RangeKey;
  /** Every day in it, `yyyy-mm-dd`, oldest first. */
  days: string[];
  grain: "day" | "month";
  /** The buckets a series is drawn in: the days, or for the year its months. */
  keys: string[];
  gte: Date;
  lt: Date;
  /** The same length again, just before — what a change is measured against. */
  prev: { gte: Date; lt: Date };
};

const DAY = 86_400_000;
const addDays = shiftDay;
const dayOf = (stored: Date) => stored.toISOString().slice(0, 10);

function windowOf(clock: Clock, range: RangeKey): Window {
  const today = clock.today();
  const [year, month] = today.split("-").map(Number) as [number, number];
  const from = rangeStart(today, range);
  const days: string[] = [];
  for (let k = from; k <= today; k = addDays(k, 1)) days.push(k);
  const grain = range === "ytd" ? "month" : "day";
  const keys = grain === "day" ? days : Array.from({ length: month }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  return {
    range,
    days,
    grain,
    keys,
    gte: clock.startOfDay(from)!,
    lt: clock.endOfDay(today)!,
    prev: { gte: clock.startOfDay(addDays(from, -days.length))!, lt: clock.startOfDay(from)! },
  };
}

/** An instant's bucket in a window, or a stored day's. */
const bucketOf = (w: Window, clock: Clock, at: Date) => (w.grain === "day" ? clock.dateKey(at) : clock.monthKey(at));
const bucketOfDay = (w: Window, day: string) => (w.grain === "day" ? day : day.slice(0, 7));

function countInto(w: Window, keys: (string | null)[]): number[] {
  const index = new Map(w.keys.map((k, i) => [k, i]));
  const out = w.keys.map(() => 0);
  for (const k of keys) {
    const i = k === null ? undefined : index.get(k);
    if (i !== undefined) out[i]! += 1;
  }
  return out;
}

/** Twelve points (or one a day, when there are fewer) for a headline card's sparkline. */
function sparkOf(w: Window, clock: Clock, instants: Date[]): number[] {
  const n = Math.min(12, w.days.length);
  const index = new Map(w.days.map((d, i) => [d, Math.floor((i * n) / w.days.length)]));
  const out = Array.from({ length: n }, () => 0);
  for (const at of instants) {
    const i = index.get(clock.dateKey(at));
    if (i !== undefined) out[i]! += 1;
  }
  return out;
}

function changeOf(range: RangeKey, now: number, before: number): { delta: string; tone: Tone } {
  const against = range === "7d" ? "vs prev. 7 days" : range === "30d" ? "vs prev. 30 days" : range === "90d" ? "vs prev. 90 days" : "vs prev. period";
  if (before === 0) return now === 0 ? { delta: `No change ${against}`, tone: "flat" } : { delta: "None in the period before", tone: "up" };
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { delta: `No change ${against}`, tone: "flat" };
  return { delta: `${Math.abs(pct)}% ${against}`, tone: pct > 0 ? "up" : "down" };
}

// ─── Whose rows ─────────────────────────────────────────────────────────────

const downline = (ctx: DashboardContext) => once(ctx, "downline", () => getDownlineUserIds(ctx.userId));

/** The "whose" filter as people: yourself, you and those under you, or null for no narrowing. */
async function whoseIds(ctx: DashboardContext, whose: string | undefined): Promise<string[] | null> {
  if (whose === "me") return [ctx.userId];
  if (whose === "team") return [ctx.userId, ...(await downline(ctx))];
  return null;
}

async function taskWhere(ctx: DashboardContext, filters: Record<string, string>): Promise<Prisma.TaskWhereInput> {
  const [access, ids] = await Promise.all([once(ctx, "taskAccess", () => taskAccess(ctx.userId, "view")), whoseIds(ctx, filters.whose)]);
  return { AND: [access, ids ? { assignedToUserId: { in: ids } } : {}] };
}

/**
 * The leads a chart counts: the ones this person may open, inside the pipeline line the older lead cards
 * keep (src/actions/dashboard.ts — without `targets.viewAll`, your own and your team's).
 */
async function leadWhere(ctx: DashboardContext, filters: Record<string, string>): Promise<Prisma.LeadWhereInput> {
  const [access, line, ids] = await Promise.all([
    once(ctx, "leadAccess", () => leadAccess(ctx.userId, "view")),
    once(ctx, "leadLine", () => scopeUserIds(ctx.userId, "targets.viewAll")),
    whoseIds(ctx, filters.whose),
  ]);
  return { AND: [access, line === null ? {} : { ownerUserId: { in: line } }, ids ? { ownerUserId: { in: ids } } : {}] };
}

/** The people whose attendance this person may see — HR's own rule (src/actions/attendance.ts). */
async function attendancePeople(ctx: DashboardContext, department: string | undefined): Promise<string[]> {
  const everyone = await once(ctx, "hr:all", async () =>
    (await hasEffectivePermission(ctx.userId, "hr.viewAll")) || (await hasEffectivePermission(ctx.userId, "hr.manage")),
  );
  const reach = everyone ? null : [ctx.userId, ...(await downline(ctx))];
  const people = await db.user.findMany({
    where: { active: true, ...(reach ? { id: { in: reach } } : {}), ...(department ? { departmentId: department } : {}) },
    select: { id: true },
  });
  return people.map((p) => p.id);
}

// ─── The widgets ─────────────────────────────────────────────────────────────

export async function widgetData(ctx: DashboardContext, spec: ChartSpec, dashboardRange: RangeKey): Promise<WidgetResult> {
  if (!(await sourceOpen(ctx, spec.source))) return { ok: false, error: "You don't have access to this data any more." };
  const range = spec.range === "inherit" ? dashboardRange : spec.range;
  const w = windowOf(ctx.clock, range);
  try {
    const data = await read(ctx, spec, w);
    return { ok: true, data, subtitle: await subtitleOf(ctx, spec) };
  } catch (err) {
    if (err instanceof NotOffered) return { ok: false, error: "You don't have access to this data any more." };
    if (notMigratedYet(err)) return { ok: false, error: "This chart will work once your workspace has the latest update." };
    throw err;
  }
}

/** The period a figure the range doesn't move is over, where it has one of its own. */
async function periodOf(ctx: DashboardContext, spec: ChartSpec): Promise<string | null> {
  switch (`${spec.source}.${spec.metric}`) {
    case "finance.incomeExpense":
    case "finance.topExpenses":
      return fiscalYearOf(new Date()).label;
    case "finance.cashFlow":
      return "Last 12 months";
    case "renewals.due":
    case "renewals.upcoming":
      return "Next 30 days";
    case "targets.monthly":
      return "This month";
  }
  return null;
}

async function subtitleOf(ctx: DashboardContext, spec: ChartSpec): Promise<string> {
  if (SOURCES[spec.source].metrics[spec.metric]?.fixed) return (await periodOf(ctx, spec)) ?? "";
  const parts: string[] = [];
  if (spec.range !== "inherit") parts.push(rangeLabel(spec.range));
  for (const f of SOURCES[spec.source].filters) {
    const v = spec.filters[f.key];
    if (!v || v === "all") continue;
    const options = f.key === DEPARTMENT_FILTER ? await departmentOptions(ctx) : f.options;
    parts.push(options.find((o) => o.value === v)?.label ?? "A removed department");
  }
  return parts.join(" · ");
}

async function read(ctx: DashboardContext, spec: ChartSpec, w: Window): Promise<ChartData> {
  const { clock } = ctx;
  switch (`${spec.source}.${spec.metric}`) {
    case "tasks.completion": {
      const where = await taskWhere(ctx, spec.filters);
      const [done, due] = await Promise.all([
        db.task.findMany({ where: { AND: [where, { done: true, doneAt: { gte: w.gte, lt: w.lt } }] }, select: { doneAt: true } }),
        // Due in the window and still open: what is pending, on the day it was meant for.
        db.task.findMany({
          where: { AND: [where, { done: false, dueDate: { gte: new Date(`${w.days[0]}T00:00:00Z`), lte: new Date(`${w.days.at(-1)}T00:00:00Z`) } }] },
          select: { dueDate: true },
        }),
      ]);
      return {
        kind: "series",
        grain: w.grain,
        keys: w.keys,
        combine: "sum",
        stacked: true,
        series: [
          { name: "Completed", values: countInto(w, done.map((t) => bucketOf(w, clock, t.doneAt!))) },
          { name: "Pending", values: countInto(w, due.map((t) => bucketOfDay(w, dayOf(t.dueDate!)))) },
        ],
      };
    }
    case "tasks.priority": {
      const groups = await db.task.groupBy({ by: ["priority"], where: { AND: [await taskWhere(ctx, spec.filters), { done: false }] }, _count: true });
      const order: TaskPriorityKey[] = ["URGENT", "HIGH", "MEDIUM", "LOW"];
      return {
        kind: "category",
        items: order
          .map((p) => ({ label: PRIORITY_LABELS[p], value: groups.find((g) => g.priority === p)?._count ?? 0 }))
          // Urgent only when there is any: most workspaces never use it, and an empty first bar reads as a fault.
          .filter((x) => x.value > 0 || x.label !== PRIORITY_LABELS.URGENT),
      };
    }
    case "tasks.upcoming": {
      const where = { AND: [await taskWhere(ctx, spec.filters), { done: false, dueDate: { not: null } }] };
      const today = clock.today();
      const base = { id: true, title: true, dueDate: true, done: true } as const;
      // Priority is one of the newer columns (src/lib/tasks/server.ts ADVANCED): a workspace not migrated
      // yet still gets its list, without the pills.
      const rows: { id: string; title: string; dueDate: Date | null; done: boolean; priority?: string }[] = await db.task
        .findMany({ where, orderBy: { dueDate: "asc" }, take: 5, select: { ...base, priority: true } })
        .catch((err) => {
          if (!notMigratedYet(err)) throw err;
          return db.task.findMany({ where, orderBy: { dueDate: "asc" }, take: 5, select: base });
        });
      return {
        kind: "tasks",
        items: rows.map((t) => {
          const due = dayOf(t.dueDate!);
          return { id: t.id, title: t.title, priority: t.priority ? (PRIORITY_LABELS[t.priority as TaskPriorityKey] ?? null) : null, due: dueLabel(due, today), dueSoon: due <= today, done: t.done };
        }),
      };
    }
    case "tasks.total": {
      const where = await taskWhere(ctx, spec.filters);
      const [now, before] = await Promise.all([
        db.task.count({ where: { AND: [where, { createdAt: { gte: w.gte, lt: w.lt } }] } }),
        db.task.count({ where: { AND: [where, { createdAt: { gte: w.prev.gte, lt: w.prev.lt } }] } }),
      ]);
      return { kind: "number", value: now.toLocaleString("en-IN"), ...changeOf(w.range, now, before) };
    }

    case "leads.status": {
      const where = { AND: [await leadWhere(ctx, spec.filters), await salesLeads(), { status: { notIn: CLOSED_LEAD } }] };
      const groups = await db.lead.groupBy({ by: ["status"], where, _count: true });
      return {
        kind: "category",
        items: OPEN_LEAD.map((s) => ({ label: LEAD_STATUS_LABELS[s], value: groups.find((g) => g.status === s)?._count ?? 0 })).filter((x) => x.value > 0),
      };
    }
    case "leads.source": {
      const where = { AND: [await leadWhere(ctx, spec.filters), { createdAt: { gte: w.gte, lt: w.lt } }] };
      const groups = (await db.lead.groupBy({ by: ["source"], where, _count: true })).sort((a, b) => b._count - a._count);
      // Five and the rest, as a donut with twelve slivers says nothing.
      const top = groups.slice(0, 4).map((g) => ({ label: LEAD_SOURCE_LABELS[g.source], value: g._count }));
      const rest = groups.slice(4).reduce((a, g) => a + g._count, 0);
      return { kind: "category", items: rest > 0 ? [...top, { label: "Other", value: rest }] : top };
    }
    case "leads.recent": {
      const rows = await db.lead.findMany({
        where: await leadWhere(ctx, spec.filters),
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { id: true, leadSeq: true, title: true, status: true, updatedAt: true, ownerUserId: true, owner: { select: { name: true } }, company: { select: { name: true } } },
      });
      // Named as this person's field access names a lead in a list — the same as the older card.
      const masked = await maskLeads(await listLeadMasker(ctx.userId), rows);
      return {
        kind: "leads",
        rows: masked.map((l) => ({
          id: l.id,
          href: leadPath(l.leadSeq),
          name: l.title,
          company: l.company.name,
          status: LEAD_STATUS_LABELS[l.status],
          owner: l.ownerUserId === ctx.userId ? "You" : (l.owner?.name.split(" ")[0] ?? "—"),
          date: shortDate(clock.dateKey(l.updatedAt)),
        })),
      };
    }
    case "leads.open": {
      const where = { AND: [await leadWhere(ctx, spec.filters), await salesLeads()] };
      const [open, now, before] = await Promise.all([
        db.lead.count({ where: { AND: [where, { status: { notIn: CLOSED_LEAD } }] } }),
        db.lead.count({ where: { AND: [where, { createdAt: { gte: w.gte, lt: w.lt } }] } }),
        db.lead.count({ where: { AND: [where, { createdAt: { gte: w.prev.gte, lt: w.prev.lt } }] } }),
      ]);
      return { kind: "number", value: open.toLocaleString("en-IN"), ...newLeadsChange(now, before) };
    }

    case "attendance.overview": {
      const days = await attendanceDays(ctx, spec.filters[DEPARTMENT_FILTER], w);
      const names = ["Present", "Late", "Absent", "On leave"] as const;
      const perKey = new Map(w.keys.map((k) => [k, { counts: [0, 0, 0, 0], days: new Set<string>() }]));
      for (const d of days) {
        const kind = d.kind;
        if (kind === null) continue;
        const slot = perKey.get(bucketOfDay(w, d.day));
        if (!slot) continue;
        slot.counts[kind]! += 1;
        slot.days.add(d.day);
      }
      // A month's figure is the headcount on an average recorded day, not the month's person-days added up.
      const values = (i: number) =>
        w.keys.map((k) => {
          const slot = perKey.get(k)!;
          return w.grain === "day" ? slot.counts[i]! : slot.days.size ? Math.round((slot.counts[i]! / slot.days.size) * 10) / 10 : 0;
        });
      return { kind: "series", grain: w.grain, keys: w.keys, combine: "avg", stacked: true, series: names.map((name, i) => ({ name, values: values(i) })) };
    }
    case "attendance.rate": {
      const [now, before] = await Promise.all([
        attendanceRate(ctx, spec.filters[DEPARTMENT_FILTER], w.gte, w.lt),
        attendanceRate(ctx, spec.filters[DEPARTMENT_FILTER], w.prev.gte, w.prev.lt),
      ]);
      return { kind: "number", value: now === null ? "—" : `${now}%`, ...pointsChange(w.range, now, before) };
    }

    case "team.performance":
      return { kind: "team", rows: await teamRows(ctx, spec.filters[DEPARTMENT_FILTER], w) };

    case "approvals.byType": {
      const kinds = await approvalKinds(ctx);
      return { kind: "category", items: kinds.map((k) => ({ label: k.label, value: k.asked.length })) };
    }
    case "approvals.pending": {
      const kinds = await approvalKinds(ctx);
      const total = kinds.reduce((a, k) => a + k.asked.length, 0);
      const weekAgo = Date.now() - 7 * DAY;
      const fresh = kinds.reduce((a, k) => a + k.asked.filter((at) => at.getTime() >= weekAgo).length, 0);
      return { kind: "number", value: String(total), delta: fresh ? `${fresh} new this week` : "None new this week", tone: fresh ? "warn" : "flat" };
    }

    // ─── What the older cards showed (getDashboardSummary), as widgets ───
    case "customers.funnel": {
      const s = await summaryOf(ctx, "companies");
      const c = offered(s.companies);
      return {
        kind: "category",
        items: [
          { label: "Prospects", value: c.prospects },
          { label: "Leads", value: c.leads },
          { label: "Awaiting order", value: c.awaitingOrder },
          ...(s.customers ? [{ label: "Customers", value: s.customers.total }] : []),
        ],
      };
    }
    case "customers.companies": {
      const c = offered((await summaryOf(ctx, "companies")).companies);
      return { kind: "number", value: c.total.toLocaleString("en-IN"), delta: `${c.prospects} prospects · ${c.leads} leads · ${c.awaitingOrder} awaiting order`, tone: "flat" };
    }
    case "customers.customers": {
      const c = offered((await summaryOf(ctx, "companies")).customers);
      return { kind: "number", value: c.total.toLocaleString("en-IN"), delta: "Have bought at least once", tone: "flat" };
    }
    case "quotations.pending": {
      const q = offered((await summaryOf(ctx, "quotations")).quotations);
      return {
        kind: "number",
        value: q.pending.toLocaleString("en-IN"),
        delta: q.pending === 0 ? "Nothing awaiting an answer" : `${shortRupees(q.value)} quoted${q.lapsed > 0 ? ` · ${q.lapsed} past validity` : ""}`,
        tone: q.lapsed > 0 ? "warn" : "flat",
      };
    }
    case "orders.action": {
      const o = offered((await summaryOf(ctx, "orders")).orders);
      return { kind: "number", value: o.awaitingApproval.toLocaleString("en-IN"), delta: `${o.awaitingSourcing} approved, awaiting sourcing`, tone: o.awaitingApproval > 0 ? "warn" : "flat" };
    }
    case "orders.stages": {
      const o = offered((await summaryOf(ctx, "orders")).orders);
      return { kind: "category", items: [{ label: "Awaiting approval", value: o.awaitingApproval }, { label: "Awaiting sourcing", value: o.awaitingSourcing }] };
    }
    case "targets.monthly": {
      const t = (await summaryOf(ctx, "salesTarget")).salesTarget;
      // No target this month is said, not left blank: a widget that shows nothing reads as broken.
      if (!t) return { kind: "number", value: "—", delta: "No target set for this month", tone: "flat" };
      const tone: Tone = t.tone === "green" ? "up" : t.tone === "amber" ? "warn" : t.tone === "red" ? "down" : "flat";
      return { kind: "number", value: shortRupees(t.achieved), exact: formatCurrency(t.achieved), delta: `${t.percent}% of ${shortRupees(t.target)} · ${t.status}`, tone };
    }
    case "payments.outstanding": {
      const p = offered((await summaryOf(ctx, "payments")).payments);
      return { kind: "number", value: shortRupees(p.outstandingBalance), exact: formatCurrency(p.outstandingBalance), delta: `${p.unpaidCount} unpaid · ${p.partialCount} partially paid`, tone: "flat" };
    }
    case "payments.status": {
      const p = offered((await summaryOf(ctx, "payments")).payments);
      return { kind: "category", items: [{ label: "Unpaid", value: p.unpaidCount }, { label: "Partially paid", value: p.partialCount }] };
    }
    case "finance.incomeExpense": {
      const months = offered((await summaryOf(ctx, "finance")).finance).incomeExpense.months;
      return {
        kind: "series",
        grain: "month",
        keys: months.map((m) => m.key),
        combine: "sum",
        stacked: false,
        money: true,
        series: [
          { name: "Income", values: months.map((m) => m.income) },
          { name: "Expenses", values: months.map((m) => m.expense) },
        ],
      };
    }
    case "finance.cashFlow": {
      const points = offered((await summaryOf(ctx, "finance")).finance).cashFlow.points;
      return { kind: "series", grain: "month", keys: points.map((p) => p.key), combine: "avg", stacked: false, money: true, series: [{ name: "Cash and bank", values: points.map((p) => p.balance) }] };
    }
    case "finance.topExpenses": {
      const top = offered((await summaryOf(ctx, "finance")).finance).topExpenses;
      return { kind: "category", money: true, items: top.map((e) => ({ label: e.name, value: e.amount })) };
    }
    case "finance.receivables":
    case "finance.payables": {
      const f = offered((await summaryOf(ctx, "finance")).finance);
      const o = spec.metric === "receivables" ? f.receivables : f.payables;
      return {
        kind: "category",
        money: true,
        headline: {
          value: shortRupees(o.total),
          exact: formatCurrency(o.total),
          delta: o.overdue > 0 ? `${shortRupees(o.overdue)} overdue · ${o.count} unpaid` : `${o.count} unpaid, none overdue`,
          tone: o.overdue > 0 ? "warn" : "flat",
        },
        items: [
          { label: "Current", value: o.current },
          { label: "Overdue", value: o.overdue },
        ],
      };
    }
    case "renewals.due": {
      const r = offered((await summaryOf(ctx, "renewals")).renewals);
      return {
        kind: "category",
        headline: { value: r.next30.toLocaleString("en-IN"), delta: r.expired > 0 ? `${r.expired} already expired` : "None expired", tone: r.expired > 0 ? "warn" : "flat" },
        items: [
          { label: "Next 30 days", value: r.next30 },
          { label: "Expired", value: r.expired },
        ],
      };
    }
    case "renewals.upcoming": {
      const r = offered((await summaryOf(ctx, "renewals")).renewals);
      return {
        kind: "rows",
        columns: [{ label: "Company" }, { label: "Item" }, { label: "Order" }, { label: "Ends", align: "right" }],
        // A typed day, held at UTC midnight: the day itself.
        rows: r.upcoming.map((u) => ({ id: u.id, href: `${companyPath(u.companySeq)}?tab=renewals`, cells: [u.companyName, u.itemName, formatOrderId(u.orderSeq), formatCalendarDay(u.endDate)] })),
        empty: "Nothing expiring in the next 30 days.",
      };
    }
    case "support.open": {
      const t = offered((await summaryOf(ctx, "tickets")).tickets);
      return {
        kind: "category",
        headline: { value: t.open.toLocaleString("en-IN"), delta: t.overdue > 0 ? `${t.overdue} overdue` : "None overdue", tone: t.overdue > 0 ? "down" : "flat" },
        items: [
          { label: "On time", value: Math.max(0, t.open - t.overdue) },
          { label: "Overdue", value: t.overdue },
        ],
      };
    }
    case "projects.attention": {
      const p = offered((await summaryOf(ctx, "projects")).projects);
      return {
        kind: "category",
        headline: { value: p.needingAttention.toLocaleString("en-IN"), delta: `of ${p.active} live · yours`, tone: p.needingAttention > 0 ? "warn" : "flat" },
        items: [
          { label: "On track", value: Math.max(0, p.active - p.needingAttention) },
          { label: "Needing attention", value: p.needingAttention },
        ],
      };
    }
    case "projects.mine": {
      const p = offered((await summaryOf(ctx, "projects")).projects);
      return {
        kind: "rows",
        columns: [{ label: "Project" }, { label: "Stage" }, { label: "Health" }, { label: "Tasks", align: "right" }],
        pill: 2,
        rows: p.items.map((x) => ({
          id: x.id,
          href: `/projects/${x.id}`,
          cells: [
            x.name,
            `${projectStatusLabels[x.status as ProjectStatus]}${x.lateDays !== null ? ` · ${x.lateDays}d late` : ""}`,
            projectHealthLabels[x.health as ProjectHealth],
            x.total > 0 ? `${x.done}/${x.total}` : "—",
          ],
        })),
        empty: "You're not on any live projects.",
      };
    }
    case "expenses.awaiting": {
      const e = offered((await summaryOf(ctx, "expenses")).expenses);
      return {
        kind: "number",
        value: e.awaitingMe.toLocaleString("en-IN"),
        delta: e.myUnreimbursed > 0 ? `${e.myUnreimbursed} of yours approved, not yet paid` : "Nothing of yours outstanding",
        tone: e.awaitingMe > 0 ? "warn" : "flat",
      };
    }
    case "vendors.status": {
      const v = offered((await summaryOf(ctx, "vendors")).vendors);
      return { kind: "category", items: [{ label: "Onboarding", value: v.onboarding }, { label: "Active", value: v.active }, { label: "Inactive", value: v.inactive }] };
    }
    case "vendors.onboarding": {
      const v = offered((await summaryOf(ctx, "vendors")).vendors);
      return { kind: "number", value: v.onboarding.toLocaleString("en-IN"), delta: `${v.active} active · ${v.inactive} inactive`, tone: "flat" };
    }

    case "activity.recent": {
      // Through listActivity, which decides whose trail this is — the older card's reasoning, kept.
      const recent = await listActivity({ filters: {}, page: 1, pageSize: 6 });
      return {
        kind: "activity",
        ownOnly: recent.scoped,
        items: recent.rows.map((r) => ({
          id: r.id,
          icon: activityIcon(r.kind),
          title: r.summary,
          sub: [r.userName ?? "System", words(r.kind)].join(" · "),
          time: ago(clock, new Date(r.createdAt)),
        })),
      };
    }
  }
  throw new Error(`No figures for ${spec.source}.${spec.metric}.`);
}

// ─── Leads ───────────────────────────────────────────────────────────────────

const CLOSED_LEAD: LeadStatus[] = ["WON", "LOST", "DISQUALIFIED"];
const OPEN_LEAD: LeadStatus[] = ["NEW", "CONTACTED", "QUALIFYING", "QUALIFIED", "PROPOSAL_SENT", "NEGOTIATION"];
const LEAD_STATUS_LABELS: Record<string, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFYING: "Qualifying",
  QUALIFIED: "Qualified",
  PROPOSAL_SENT: "Proposal",
  NEGOTIATION: "Negotiation",
  WON: "Won",
  LOST: "Lost",
  DISQUALIFIED: "Disqualified",
};

/** The open count is a standing figure; what moves it is how many new leads came in, against the period before. */
function newLeadsChange(now: number, before: number): { delta: string; tone: Tone } {
  if (before === 0) return now === 0 ? { delta: "No new leads", tone: "flat" } : { delta: `${now} new leads`, tone: "up" };
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { delta: "New leads steady", tone: "flat" };
  return { delta: `New leads ${pct > 0 ? "up" : "down"} ${Math.abs(pct)}%`, tone: pct > 0 ? "up" : "down" };
}

// ─── Attendance ──────────────────────────────────────────────────────────────

/** 0 present, 1 late, 2 absent, 3 on leave; null for a day that is none of those (a week off, a holiday). */
type AttendanceKind = 0 | 1 | 2 | 3 | null;

async function attendanceDays(ctx: DashboardContext, department: string | undefined, w: Window) {
  const people = await attendancePeople(ctx, department);
  const [rows, hours] = await Promise.all([
    db.attendanceDay.findMany({
      where: { userId: { in: people }, date: { gte: new Date(`${w.days[0]}T00:00:00Z`), lte: new Date(`${w.days.at(-1)}T00:00:00Z`) } },
      select: { date: true, status: true, checkInAt: true, checkOutAt: true, workedMinutes: true },
    }),
    once(ctx, "officeHours", () => officeHours()),
  ]);
  const minuteOf = (at: Date) => {
    const p = ctx.clock.parts(at);
    return p.hour * 60 + p.minute;
  };
  return rows.map((r) => {
    let kind: AttendanceKind = null;
    if (r.status === "PRESENT" || r.status === "WORK_FROM_HOME" || r.status === "HALF_DAY") kind = dayTiming(r, hours, minuteOf).late ? 1 : 0;
    else if (r.status === "ABSENT") kind = 2;
    else if (r.status === "ON_LEAVE") kind = 3;
    return { day: dayOf(r.date), kind };
  });
}

/** Days attended out of days that should have been — leave, week offs and holidays left out. Null for none recorded. */
async function attendanceRate(ctx: DashboardContext, department: string | undefined, gte: Date, lt: Date): Promise<number | null> {
  const people = await attendancePeople(ctx, department);
  const from = ctx.clock.calendarDate(gte);
  const to = ctx.clock.calendarDate(new Date(lt.getTime() - 1));
  const groups = await db.attendanceDay.groupBy({ by: ["status"], where: { userId: { in: people }, date: { gte: from, lte: to } }, _count: true });
  const n = (s: string) => groups.find((g) => g.status === s)?._count ?? 0;
  const attended = n("PRESENT") + n("WORK_FROM_HOME") + n("HALF_DAY") / 2;
  const expected = n("PRESENT") + n("WORK_FROM_HOME") + n("HALF_DAY") + n("ABSENT");
  return expected ? Math.round((attended / expected) * 100) : null;
}

function pointsChange(range: RangeKey, now: number | null, before: number | null): { delta: string | null; tone: Tone } {
  if (now === null) return { delta: "Nothing recorded yet", tone: "flat" };
  if (before === null) return { delta: null, tone: "flat" };
  const diff = now - before;
  const against = range === "7d" ? "vs prev. 7 days" : range === "30d" ? "vs prev. 30 days" : range === "90d" ? "vs prev. 90 days" : "vs prev. period";
  return diff === 0 ? { delta: `No change ${against}`, tone: "flat" } : { delta: `${Math.abs(diff)} pts ${against}`, tone: diff > 0 ? "up" : "down" };
}

// ─── Team ────────────────────────────────────────────────────────────────────

/** Tasks finished in the window, per person, and how many of those with a due day were done by it. */
async function teamRows(ctx: DashboardContext, department: string | undefined, w: Window) {
  const done = await db.task.findMany({
    where: {
      AND: [
        await taskWhere(ctx, {}),
        { done: true, doneAt: { gte: w.gte, lt: w.lt }, assignedToUserId: { not: null } },
        department ? { assignedTo: { departmentId: department } } : {},
      ],
    },
    select: { assignedToUserId: true, dueDate: true, doneAt: true },
  });
  const per = new Map<string, { done: number; dated: number; onTime: number }>();
  for (const t of done) {
    const row = per.get(t.assignedToUserId!) ?? { done: 0, dated: 0, onTime: 0 };
    row.done += 1;
    if (t.dueDate) {
      row.dated += 1;
      if (ctx.clock.dateKey(t.doneAt!) <= dayOf(t.dueDate)) row.onTime += 1;
    }
    per.set(t.assignedToUserId!, row);
  }
  const top = [...per.entries()].sort((a, b) => b[1].done - a[1].done).slice(0, 6);
  const names = new Map(
    (await db.user.findMany({ where: { id: { in: top.map(([id]) => id) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
  );
  return top.map(([id, r]) => {
    const name = names.get(id) ?? "Someone who has left";
    return { name, initials: initialsOf(name), done: r.done, onTime: r.dated ? Math.round((r.onTime / r.dated) * 100) : 100 };
  });
}

// ─── Approvals ───────────────────────────────────────────────────────────────

/**
 * What is waiting on this person to decide, by kind — each the queue its own page shows them: leave
 * they may approve, expense claims sent to them, orders awaiting approval (with "Approve orders"), and
 * Automate's approvals inbox. A kind whose module is off is not listed at all, rather than shown as 0.
 */
function approvalKinds(ctx: DashboardContext) {
  return once(ctx, "approvals", async () => {
    const uid = ctx.userId;
    const [hr, expenses, orders, automate] = await Promise.all([moduleOn(ctx, "hr"), moduleOn(ctx, "expenses"), moduleOn(ctx, "orders"), moduleOn(ctx, "automate")]);
    const kinds: { label: string; asked: Date[] }[] = [];
    const reads: Promise<void>[] = [];
    if (hr) {
      reads.push(
        (async () => {
          const anyone = await hasEffectivePermission(uid, "hr.approveLeave");
          // Never your own, whatever else is true (src/actions/leave.ts leaveApprovalQueue).
          const scope = anyone ? { userId: { not: uid } } : { userId: { in: await downline(ctx) } };
          const rows = await db.leaveRequest.findMany({ where: { ...scope, status: "PENDING" }, select: { createdAt: true } });
          kinds.push({ label: "Leave", asked: rows.map((r) => r.createdAt) });
        })(),
      );
    }
    if (expenses) {
      reads.push(
        db.expense
          .findMany({ where: { status: "SUBMITTED", approverUserId: uid }, select: { submittedAt: true, createdAt: true } })
          .then((rows) => void kinds.push({ label: "Expense claims", asked: rows.map((r) => r.submittedAt ?? r.createdAt) })),
      );
    }
    if (orders && (await can(uid, "orders.approve"))) {
      reads.push(
        (async () => {
          const rows = await db.companyProduct.findMany({
            where: { AND: [{ orderStatus: "PENDING_APPROVAL" }, await orderAccess(uid, "view")] },
            select: { createdAt: true },
          });
          kinds.push({ label: "Orders", asked: rows.map((r) => r.createdAt) });
        })(),
      );
    }
    if (automate) {
      reads.push(
        getApprovalsInbox()
          .then((inbox) => void kinds.push({ label: "Workflows", asked: inbox.waiting.map((i) => new Date(i.askedAt)) }))
          // Automate refuses outright where the plan doesn't include it; that is "no workflow approvals".
          .catch(() => undefined),
      );
    }
    await Promise.all(reads);
    const order = ["Leave", "Expense claims", "Orders", "Workflows"];
    return kinds.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  });
}

// ─── Headline cards ──────────────────────────────────────────────────────────

/**
 * The four figures across the top, each only where its source is open to this person — the design's
 * Total tasks, Open leads, Team attendance and Pending approvals, over the dashboard's range.
 */
export async function kpiCards(ctx: DashboardContext, range: RangeKey): Promise<KpiCard[]> {
  const w = windowOf(ctx.clock, range);
  const { clock } = ctx;
  const [tasksOpen, leadsOpen, hrOpen, approvalsOpen] = await Promise.all([
    sourceOpen(ctx, "tasks"),
    sourceOpen(ctx, "leads"),
    sourceOpen(ctx, "attendance"),
    sourceOpen(ctx, "approvals"),
  ]);
  const cards = await Promise.all([
    tasksOpen &&
      (async (): Promise<KpiCard> => {
        const where = await taskWhere(ctx, {});
        const [rows, before] = await Promise.all([
          db.task.findMany({ where: { AND: [where, { createdAt: { gte: w.gte, lt: w.lt } }] }, select: { createdAt: true } }),
          db.task.count({ where: { AND: [where, { createdAt: { gte: w.prev.gte, lt: w.prev.lt } }] } }),
        ]);
        return { key: "tasks", label: "Total Tasks", icon: "tasks", value: rows.length.toLocaleString("en-IN"), ...changeOf(range, rows.length, before), href: "/tasks", spark: sparkOf(w, clock, rows.map((r) => r.createdAt)) };
      })(),
    leadsOpen &&
      (async (): Promise<KpiCard> => {
        const where = { AND: [await leadWhere(ctx, {}), await salesLeads()] };
        const [open, created, before] = await Promise.all([
          db.lead.count({ where: { AND: [where, { status: { notIn: CLOSED_LEAD } }] } }),
          db.lead.findMany({ where: { AND: [where, { createdAt: { gte: w.gte, lt: w.lt } }] }, select: { createdAt: true } }),
          db.lead.count({ where: { AND: [where, { createdAt: { gte: w.prev.gte, lt: w.prev.lt } }] } }),
        ]);
        return { key: "leads", label: "Open Leads", icon: "leads", value: open.toLocaleString("en-IN"), ...newLeadsChange(created.length, before), href: "/leads", spark: sparkOf(w, clock, created.map((r) => r.createdAt)) };
      })(),
    hrOpen &&
      (async (): Promise<KpiCard> => {
        const [now, before, days] = await Promise.all([attendanceRate(ctx, undefined, w.gte, w.lt), attendanceRate(ctx, undefined, w.prev.gte, w.prev.lt), attendanceDays(ctx, undefined, w)]);
        const change = pointsChange(range, now, before);
        // The rate on each stretch of the range, for the sparkline.
        const n = Math.min(12, w.days.length);
        const at = new Map(w.days.map((d, i) => [d, Math.floor((i * n) / w.days.length)]));
        const tally = Array.from({ length: n }, () => ({ came: 0, due: 0 }));
        for (const d of days) {
          const i = at.get(d.day);
          if (i === undefined || d.kind === null || d.kind === 3) continue;
          tally[i]!.due += 1;
          if (d.kind !== 2) tally[i]!.came += 1;
        }
        return {
          key: "attendance",
          label: "Team Attendance",
          icon: "attendance",
          value: now === null ? "—" : `${now}%`,
          delta: change.delta ?? "First period recorded",
          tone: change.tone,
          href: "/people/attendance",
          spark: tally.map((t) => (t.due ? t.came / t.due : 0)),
        };
      })(),
    approvalsOpen &&
      (async (): Promise<KpiCard> => {
        const kinds = await approvalKinds(ctx);
        const asked = kinds.flatMap((k) => k.asked);
        const weekAgo = Date.now() - 7 * DAY;
        const fresh = asked.filter((at) => at.getTime() >= weekAgo).length;
        return {
          key: "approvals",
          label: "Pending Approvals",
          icon: "approvals",
          value: String(asked.length),
          delta: fresh ? `${fresh} new this week` : "None new this week",
          tone: fresh ? "warn" : "flat",
          href: "/approvals",
          spark: sparkOf(w, clock, asked),
        };
      })(),
  ]);
  return cards.filter((c): c is KpiCard => !!c);
}

// ─── Words ───────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}`;

function dueLabel(due: string, today: string): string {
  if (due === today) return "Today";
  if (due === addDays(today, 1)) return "Tomorrow";
  if (due === addDays(today, -1)) return "Yesterday";
  return shortDate(due);
}

function ago(clock: Clock, at: Date): string {
  const minutes = Math.round((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return shortDate(clock.dateKey(at));
}

const words = (code: string) => {
  const text = code.replaceAll("_", " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

function activityIcon(kind: string): ActivityIcon {
  if (/^(LOGIN|LOGOUT|SESSION|PASSWORD|TWO_FACTOR|IMPERSONATION)/.test(kind)) return "sign-in";
  if (/^(VIEW|SEARCH|EXPORT|PRINT|BULK_READ)$/.test(kind)) return "read";
  if (/DEVICE|NETWORK/.test(kind)) return "device";
  if (/BLOCKED|DENIED|LIMITED|HELD|FAILED|TRAVEL|DEVTOOLS|SCREENSHOT|SECURITY/.test(kind)) return "security";
  return "other";
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}
