"use server";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { viaCompanyScope } from "@/lib/authz/company-scope";
import { requireModuleUser } from "@/lib/modules-access";
import { logActivity } from "@/lib/activity";
import { csvRow } from "@/lib/csv";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { authorLabel } from "@/lib/people";
import { addMonths, isMonthOpen, lastCompletedMonth, monthKeyAt, monthKeyOfDate, monthLabel, type MonthKey } from "@/lib/revenue/periods";
import { waterfall as waterfallOf } from "@/lib/revenue/reports";
import type { ActionResult } from "@/actions/company";

/**
 * What the Revenue & Close revenue screens read besides src/actions/revenue.ts: who is looking and
 * what they may do, the filter choices, a list row's next month, the people behind a schedule, and
 * the waterfall as a spreadsheet.
 *
 * The same door as the revenue actions: the `revenue_close` plan check, then `revenue.viewReports`
 * or `revenue.manage`; anything that lists customers is narrowed to the ones the caller may see.
 */

/** Somebody who may read revenue — or an error that says they may not. */
async function reader() {
  const user = await requireModuleUser("revenue_close");
  if (!(await can(user.id, "revenue.viewReports")) && !(await can(user.id, "revenue.manage"))) {
    throw new Error("You don't have permission to see revenue recognition.");
  }
  return user;
}

async function scheduleScope(userId: string): Promise<Prisma.RevenueScheduleWhereInput> {
  return (await viaCompanyScope(userId)) as Prisma.RevenueScheduleWhereInput;
}

/** How far back the month pickers reach: two years of completed months. */
const MONTHS_BACK = 24;

export type RevenueScreenContext = {
  mayManage: boolean;
  isSuperAdmin: boolean;
  /** `data.exportFinance`: may download the waterfall. */
  mayExport: boolean;
  /** The month now, in India. */
  currentMonth: MonthKey;
  /** The latest month "Recognise through" and the opening wizard accept. */
  lastCompletedMonth: MonthKey;
  /** `yyyy-mm-dd`, or null when nothing is locked. */
  lockedUntil: string | null;
  /** Completed months, newest first, whose month end is still open — where deferred revenue can be opened. */
  openMonths: MonthKey[];
  /** The ledger account the roll-forward ties to, for its link. */
  deferredAccountId: string | null;
};

/** Who is looking at the revenue screens, what they may do there, and the calendar those screens need. */
export async function revenueScreenContext(): Promise<RevenueScreenContext> {
  const user = await reader();
  const now = new Date();
  const [mayManage, mayExport, me, lock, account] = await Promise.all([
    can(user.id, "revenue.manage"),
    can(user.id, "data.exportFinance"),
    db.user.findUnique({ where: { id: user.id }, select: { isSuperAdmin: true } }),
    db.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } }),
    db.ledgerAccount.findFirst({ where: { systemKey: SYSTEM_ACCOUNTS.DEFERRED_REVENUE }, select: { id: true } }),
  ]);
  const last = lastCompletedMonth(now);
  const openMonths: MonthKey[] = [];
  for (let i = 0; i < MONTHS_BACK; i += 1) {
    const month = addMonths(last, -i);
    if (isMonthOpen(month, lock?.lockedUntil)) openMonths.push(month);
  }
  return {
    mayManage,
    isSuperAdmin: !!me?.isSuperAdmin,
    mayExport,
    currentMonth: monthKeyAt(now),
    lastCompletedMonth: last,
    lockedUntil: lock?.lockedUntil ? lock.lockedUntil.toISOString().slice(0, 10) : null,
    openMonths,
    deferredAccountId: account?.id ?? null,
  };
}

/** The customers and items that have schedules the caller may see: the list's filter choices. */
export async function scheduleFilterOptions(): Promise<{ customers: { id: string; name: string }[]; items: { id: string; name: string }[] }> {
  const user = await reader();
  const scope = await scheduleScope(user.id);
  const [byCompany, byItem] = await Promise.all([
    db.revenueSchedule.findMany({ where: scope, distinct: ["companyId"], select: { company: { select: { id: true, name: true } } } }),
    db.revenueSchedule.findMany({ where: { AND: [scope, { itemId: { not: null } }] }, distinct: ["itemId"], select: { item: { select: { id: true, name: true } } } }),
  ]);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    customers: byCompany.map((r) => r.company).sort(byName),
    items: byItem.flatMap((r) => (r.item ? [r.item] : [])).sort(byName),
  };
}

/**
 * Each schedule's first unposted month and its amount — the list's "next" column. Only schedules the
 * caller may see, and only live ones; the rest are simply left out of the answer.
 */
export async function nextMonthAmounts(ids: string[]): Promise<Record<string, { month: MonthKey; amount: number }>> {
  const user = await reader();
  const wanted = Array.isArray(ids) ? ids.filter((id) => typeof id === "string").slice(0, 500) : [];
  if (wanted.length === 0) return {};
  const lines = await db.revenueScheduleLine.findMany({
    where: {
      entryId: null,
      schedule: { AND: [await scheduleScope(user.id), { id: { in: wanted } }, { status: { in: ["ACTIVE", "PENDING_APPROVAL"] } }] },
    },
    orderBy: [{ month: "asc" }],
    select: { scheduleId: true, month: true, amount: true },
  });
  const out: Record<string, { month: MonthKey; amount: number }> = {};
  for (const l of lines) {
    if (!out[l.scheduleId]) out[l.scheduleId] = { month: monthKeyOfDate(l.month), amount: Number(l.amount) };
  }
  return out;
}

export type SchedulePeople = {
  /** "by Asha Rao", or "Posted automatically" for the Automation account. */
  madeBy: string | null;
  approvedBy: string | null;
  /** Approved by the person who made it — only the super admin may, and it is said so. */
  approvedOwn: boolean;
  /** Who posted each month's entry, by entry id. */
  postedBy: Record<string, string>;
};

/** The people behind one schedule, labelled as `authorLabel` does it. Null outside the caller's scope. */
export async function schedulePeople(id: string): Promise<SchedulePeople | null> {
  const user = await reader();
  if (typeof id !== "string" || !id) return null;
  const row = await db.revenueSchedule.findFirst({
    where: { AND: [{ id }, await scheduleScope(user.id)] },
    select: {
      createdById: true,
      approvedById: true,
      createdBy: { select: { name: true, kind: true } },
      approvedBy: { select: { name: true, kind: true } },
      lines: { where: { entryId: { not: null } }, select: { entry: { select: { id: true, createdBy: { select: { name: true, kind: true } } } } } },
    },
  });
  if (!row) return null;
  const postedBy: Record<string, string> = {};
  for (const l of row.lines) {
    const label = l.entry ? authorLabel(l.entry.createdBy) : null;
    if (l.entry && label) postedBy[l.entry.id] = label;
  }
  return {
    madeBy: authorLabel(row.createdBy),
    approvedBy: authorLabel(row.approvedBy),
    approvedOwn: !!row.approvedById && row.approvedById === row.createdById,
    postedBy,
  };
}

/**
 * The waterfall as a CSV file, the way the finance exports are made (src/actions/analytics.ts): it
 * needs `data.exportFinance` as well as the read, every text cell is guarded against spreadsheet
 * formulas (`csvRow`), a few lines above the data say what it is, and the download is logged.
 */
export async function exportWaterfallCsv(params: { by: "customer" | "item"; months: 12 | 24 }): Promise<ActionResult<{ filename: string; csv: string; rows: number }>> {
  const user = await reader();
  if (!(await can(user.id, "data.exportFinance"))) {
    return { ok: false, error: "You can read the waterfall but not download it. Downloading financial data needs the export permission." };
  }
  const by = params?.by === "item" ? "item" : "customer";
  const months = params?.months === 24 ? 24 : 12;
  const wf = await waterfallOf(db, { by, months, scope: await scheduleScope(user.id) });
  const header = [by === "customer" ? "Customer" : "Item", "Past due", ...wf.months.map(monthLabel), "Later", "On delivery (no month yet)", "Total deferred", "Schedules", "Pending approval"];
  const cells = (r: (typeof wf)["totals"]) => [r.label, r.pastDue, ...r.byMonth, r.later, r.unscheduled, r.total, r.schedules, r.pending];
  const context = [
    csvRow(["Report", `Revenue waterfall by ${by}`]),
    csvRow(["Months", `${monthLabel(wf.months[0]!)} to ${monthLabel(wf.months[wf.months.length - 1]!)}`]),
    csvRow(["Remaining performance obligation (INR)", wf.totals.total]),
    csvRow(["Includes", "Active schedules and those waiting for approval; amounts in rupees"]),
    csvRow(["Run by", user.name ?? ""]),
    "",
  ];
  const csv = [...context, csvRow(header), ...wf.rows.map((r) => csvRow(cells(r))), csvRow(cells({ ...wf.totals, label: "Total" }))].join("\n");
  await logActivity({
    kind: "EXPORT",
    severity: "WARNING",
    summary: `${user.name} downloaded the revenue waterfall by ${by} — ${wf.rows.length} row(s), ${months} months`,
    metadata: { report: "revenue-waterfall", by, months, rows: wf.rows.length },
  });
  return { ok: true, data: { filename: `revenue-waterfall-${by}-${wf.months[0]}.csv`, csv, rows: wf.rows.length } };
}
