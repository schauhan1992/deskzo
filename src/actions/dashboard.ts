"use server";

import { revalidatePath } from "next/cache";
import { db, getTenantDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { isModuleEnabled } from "@/actions/module";
import { paymentsSnapshot } from "@/actions/payment";
import { addDays } from "@/lib/date-range-presets";
import { SLA_HOURS } from "@/lib/tickets";
import { DASHBOARD_WIDGET_REGISTRY, defaultWidgetsForRole, type DashboardWidgetDefinition, type WidgetScope } from "@/lib/dashboard-widgets";
import { can } from "@/lib/authz/resolve";
import { listNotes } from "@/actions/note";
import { listActivity } from "@/actions/activity";
import { listProjects } from "@/actions/project";
import { daysLate, isActive, milestoneProgress } from "@/lib/projects/status";
import {
  cashFlow,
  fiscalYearOf,
  cashWindowFrom,
  incomeAndExpense,
  payablesOutstanding,
  receivablesOutstanding,
  topExpenses,
  type CashFlow,
  type IncomeExpense,
  type Outstanding,
} from "@/lib/finance/dashboard";
import { accountScopeIds, viaCompanyScope } from "@/lib/authz/company-scope";
import { measure } from "@/lib/targets/measure";
import { progressOf, METRICS } from "@/lib/targets/metrics";
import { releaseDueOrders } from "@/lib/orders/handoff";
import { scopeUserIds } from "@/lib/authz/scope";
import { vendorRelationshipTypeValues } from "@/lib/validation/company";
import type { ActionResult } from "@/actions/company";

export type DashboardSummary = {
  /** The raw sourcing pool — everyone who hasn't bought anything from us yet (see `customers` for who has). */
  companies: { total: number; prospects: number; leads: number; awaitingOrder: number };
  customers: { total: number };
  /** Null without `leads.view` — the widgets are left off rather than shown as zero. */
  leads: {
    open: number;
    pipelineValue: number;
    recent: { id: string; leadSeq: number; title: string; companyName: string; status: string; estimatedValue: number | null }[];
  } | null;
  vendors: { onboarding: number; active: number; inactive: number } | null;
  renewals: {
    expired: number;
    next30: number;
    upcoming: { id: string; orderSeq: number; companyId: string; companySeq: number; companyName: string; itemName: string; endDate: Date }[];
  } | null;
  /**
   * The projects this person is on. Never company-wide, whatever permissions they hold — a
   * dashboard is a personal screen, and the one thing it must not do is put a project somebody
   * isn't a stakeholder of onto their home page.
   */
  projects: {
    active: number;
    needingAttention: number;
    items: {
      id: string; code: string; name: string; companyName: string;
      status: string; health: string; done: number; total: number; lateDays: number | null;
    }[];
  } | null;
  payments: { outstandingBalance: number; unpaidCount: number; partialCount: number } | null;
  tickets: { open: number; overdue: number } | null;
  tasks: { myOpen: number; myOverdue: number } | null;
  notes: {
    items: {
      id: string; title: string | null; body: string; color: string;
      pinned: boolean; remindDue: boolean; mine: boolean; ownerName: string;
    }[];
    total: number;
  } | null;
  /** Claims waiting on this person, and their own money not yet back. */
  expenses: { awaitingMe: number; myUnreimbursed: number } | null;
  /** Punched orders stuck before approval, and approved ones nobody has sourced yet. */
  orders: { awaitingApproval: number; awaitingSourcing: number } | null;
  /** Proposals issued and not yet answered. `lapsed` are past the date they were valid until. */
  quotations: { pending: number; value: number; lapsed: number } | null;
  /** This person's own monthly sales target, or null when they have none set for this month. */
  salesTarget: {
    label: string;
    metricLabel: string;
    target: number;
    achieved: number;
    percent: number;
    /** How far through the month we are, so the bar can be read against something. */
    elapsedPercent: number;
    daysLeft: number;
    /** "Ahead", "On track", "Behind" — judged by pace, not by the raw percentage. */
    status: string;
    tone: string;
  } | null;
  /**
   * The finance headlines, or null when this person may not see the books.
   *
   * One gate for all five: they are company-wide figures off the ledger, and there is no
   * meaningful per-salesperson version of a cash balance to fall back to. So unlike the CRM
   * widgets these do not narrow — they are shown in full or not at all.
   */
  finance: {
    incomeExpense: IncomeExpense;
    topExpenses: { name: string; amount: number }[];
    cashFlow: CashFlow;
    receivables: Outstanding;
    payables: Outstanding;
    fiscalLabel: string;
    fiscalFrom: Date;
    cashFrom: Date;
    cashTo: Date;
  } | null;
  activity: {
    items: { id: string; summary: string; userName: string | null; kind: string; at: Date }[];
    /** True when this is only the viewer's own trail, so the card can say so. */
    ownOnly: boolean;
  };
  /**
   * What each figure actually counted, so the card can say so.
   *
   * Two people comparing dashboards and seeing different pipeline totals will conclude the app is
   * broken unless it tells them one is looking at their team and the other at the company.
   */
  scopes: Record<string, WidgetScope>;
};

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const user = await requireUser();
  const now = new Date();

  /**
   * Whose leads this person may count.
   *
   * Every figure on this screen used to be company-wide, which meant a calling agent's home page
   * opened with the total open pipeline value for the business. That is a disclosure problem
   * wearing a personalization costume — and it is the reason `scopes` is returned alongside the
   * numbers rather than the numbers being returned bare.
   */
  const leadIds = await scopeUserIds(user.id, "targets.viewAll");
  const canSeeLeads = await can(user.id, "leads.view");
  const leadScope = !canSeeLeads ? { id: { in: [] } } : leadIds === null ? {} : { ownerUserId: { in: leadIds } };
  const leadWidgetScope: WidgetScope = leadIds === null ? "company" : leadIds.length > 1 ? "team" : "own";

  const [
    companyGroups,
    customersWithOrders,
    leadGroups,
    pipelineValueAgg,
    recentLeads,
    vendorsEnabled,
    renewalsEnabled,
    projectsEnabled,
    paymentsEnabled,
    helpdeskEnabled,
    tasksEnabled,
    notesEnabled,
    accountingEnabled,
    salesDocumentsEnabled,
    targetsEnabled,
    expensesEnabled,
    ordersEnabled,
  ] = await Promise.all([
    db.company.groupBy({ by: ["stage"], where: { relationshipType: "CLIENT" }, _count: true }),
    db.company.count({ where: { relationshipType: "CLIENT", stage: "CUSTOMER", products: { some: {} } } }),
    db.lead.groupBy({ by: ["status"], where: leadScope, _count: true }),
    db.lead.aggregate({
      where: { ...leadScope, status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } },
      _sum: { estimatedValue: true },
    }),
    db.lead.findMany({
      where: leadScope,
      orderBy: { updatedAt: "desc" },
      take: 5,
      include: { company: { select: { name: true } } },
    }),
    isModuleEnabled("vendors"),
    isModuleEnabled("renewals"),
    isModuleEnabled("projects"),
    isModuleEnabled("payments"),
    isModuleEnabled("helpdesk"),
    isModuleEnabled("tasks"),
    isModuleEnabled("notes"),
    isModuleEnabled("accounting"),
    isModuleEnabled("sales_documents"),
    isModuleEnabled("targets"),
    isModuleEnabled("expenses"),
    isModuleEnabled("orders"),
  ]);

  const wonCount = companyGroups.find((g) => g.stage === "CUSTOMER")?._count ?? 0;
  // A won deal only counts as a real customer once it has an order on file — the rest ("awaiting
  // order") stay in the raw pool below, alongside prospects/leads, until their first order lands.
  const awaitingOrder = wonCount - customersWithOrders;
  const companies = {
    total: companyGroups.reduce((sum, g) => sum + g._count, 0) - customersWithOrders,
    prospects: companyGroups.find((g) => g.stage === "PROSPECT")?._count ?? 0,
    leads: companyGroups.find((g) => g.stage === "LEAD")?._count ?? 0,
    awaitingOrder,
  };
  const customers = { total: customersWithOrders };

  const closedStatuses = new Set(["WON", "LOST", "DISQUALIFIED"]);
  const leads: DashboardSummary["leads"] = !canSeeLeads ? null : {
    open: leadGroups.filter((g) => !closedStatuses.has(g.status)).reduce((sum, g) => sum + g._count, 0),
    pipelineValue: Number(pipelineValueAgg._sum.estimatedValue ?? 0),
    recent: recentLeads.map((lead) => ({
      id: lead.id,
      leadSeq: lead.leadSeq,
      title: lead.title,
      companyName: lead.company.name,
      status: lead.status,
      estimatedValue: lead.estimatedValue ? Number(lead.estimatedValue) : null,
    })),
  };

  let vendors: DashboardSummary["vendors"] = null;
  if (vendorsEnabled) {
    const vendorGroups = await db.company.groupBy({
      by: ["vendorStatus"],
      where: { relationshipType: { in: vendorRelationshipTypeValues } },
      _count: true,
    });
    vendors = {
      onboarding: vendorGroups.find((g) => g.vendorStatus === "ONBOARDING")?._count ?? 0,
      active: vendorGroups.find((g) => g.vendorStatus === "ACTIVE")?._count ?? 0,
      inactive: vendorGroups.find((g) => g.vendorStatus === "INACTIVE")?._count ?? 0,
    };
  }

  let renewals: DashboardSummary["renewals"] = null;
  if (renewalsEnabled) {
    const next30Where = { item: { type: "SUBSCRIPTION" as const }, endDate: { not: null, gte: now, lte: addDays(now, 30) } };
    const [expiredCount, next30Count, upcomingRows] = await Promise.all([
      db.companyProduct.count({ where: { item: { type: "SUBSCRIPTION" }, endDate: { not: null, lt: now } } }),
      db.companyProduct.count({ where: next30Where }),
      db.companyProduct.findMany({
        where: next30Where,
        orderBy: { endDate: "asc" },
        take: 5,
        include: { company: { select: { id: true, companySeq: true, name: true } }, item: { select: { name: true } } },
      }),
    ]);
    renewals = {
      expired: expiredCount,
      next30: next30Count,
      upcoming: upcomingRows.map((r) => ({
        id: r.id,
        orderSeq: r.orderSeq,
        companyId: r.company.id,
        companySeq: r.company.companySeq,
        companyName: r.company.name,
        itemName: r.item.name,
        endDate: r.endDate as Date,
      })),
    };
  }

  let projects: DashboardSummary["projects"] = null;
  if (projectsEnabled) {
    // Through listProjects rather than a query of its own, so the stakeholders-only rule is applied
    // in exactly one place. A dashboard that re-derived it is the classic way a widget ends up
    // counting rows the page it links to will not open.
    // mineOnly on purpose: this widget is declared scope "own" and has to stay that way even for
    // somebody holding projects.viewAll, whose home screen would otherwise fill with every
    // customer's implementation.
    const mine = await listProjects({ mineOnly: true });
    const live = mine.filter((p) => isActive(p.status));
    projects = {
      active: live.length,
      needingAttention: live.filter((p) => p.health !== "ON_TRACK").length,
      items: live
        .slice(0, 5)
        .map((p) => {
          const progress = milestoneProgress(
            p.milestones.map((m) => ({ completedAt: m.completedAt ? new Date(m.completedAt) : null })),
          );
          return {
            id: p.id,
            code: p.code,
            name: p.name,
            companyName: p.company.name,
            status: p.status,
            health: p.health,
            done: progress.done,
            total: progress.total,
            lateDays: daysLate(
              {
                targetEndDate: p.targetEndDate ? new Date(p.targetEndDate) : null,
                actualEndDate: p.actualEndDate ? new Date(p.actualEndDate) : null,
                status: p.status,
              },
              now,
            ),
          };
        })
        // Trouble first: a home screen exists to surface the thing you would otherwise miss, not
        // to list projects alphabetically.
        .sort((a, b) => (b.lateDays ?? 0) - (a.lateDays ?? 0)),
    };
  }

  let payments: DashboardSummary["payments"] = null;
  if (paymentsEnabled) {
    payments = await paymentsSnapshot();
  }

  let tickets: DashboardSummary["tickets"] = null;
  if (helpdeskEnabled) {
    const openTickets = await db.ticket.findMany({
      // The same line the tickets list follows. This card is a count of the same rows, and a
      // summary that disagrees with the list it links to is its own kind of wrong: an executive
      // would read "204 open, 31 overdue", click through, and find twenty-nine.
      where: {
        ...(await viaCompanyScope(user.id)),
        status: { notIn: ["RESOLVED", "CLOSED"] },
      },
      select: { priority: true, createdAt: true },
    });
    const overdue = openTickets.filter((t) => {
      const dueBy = new Date(t.createdAt.getTime() + SLA_HOURS[t.priority] * 60 * 60 * 1000);
      return now.getTime() > dueBy.getTime();
    }).length;
    tickets = { open: openTickets.length, overdue };
  }

  let tasks: DashboardSummary["tasks"] = null;
  if (tasksEnabled) {
    const myOpenTasks = await db.task.findMany({
      where: { assignedToUserId: user.id, done: false },
      select: { dueDate: true },
    });
    const myOverdue = myOpenTasks.filter((t) => t.dueDate && t.dueDate < now).length;
    tasks = { myOpen: myOpenTasks.length, myOverdue };
  }

  /**
   * Read through `listNotes` rather than queried here.
   *
   * A sticky note is private, or shared with a department, or shared with everybody — and
   * hidden regardless if it is stuck to an account this person cannot see. That rule lives in
   * one place on purpose (see readableNotesWhere in src/actions/note.ts). A second copy of it
   * written for a dashboard card is exactly how a private note ends up on somebody else's home
   * screen, and it would be the one place nobody thought to check.
   */
  let notes: DashboardSummary["notes"] = null;
  if (notesEnabled) {
    const readable = await listNotes();
    notes = {
      total: readable.length,
      // Already ordered pinned-first by the action, which is what pinning is for.
      items: readable.slice(0, 4).map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        color: n.color,
        pinned: n.pinned,
        remindDue: n.remindDue,
        mine: n.canEdit,
        ownerName: n.ownerName,
      })),
    };
  }

  // Both of these were in the widget registry and offered in Customize, with nothing behind
  // them — ticking either produced a dashboard that did not change. Adding the data was the
  // smaller fix; the alternative was removing two widgets whose descriptions were already right.
  let expenses: DashboardSummary["expenses"] = null;
  if (expensesEnabled) {
    const [awaitingMe, myUnreimbursed] = await Promise.all([
      db.expense.count({ where: { status: "SUBMITTED", approverUserId: user.id } }),
      // Approved but not yet paid out — the claimant's own money, still out.
      db.expense.count({ where: { userId: user.id, status: "APPROVED" } }),
    ]);
    expenses = { awaitingMe, myUnreimbursed };
  }

  let orders: DashboardSummary["orders"] = null;
  if (ordersEnabled) {
    // A scheduled order whose day has come is purchase's now, whether or not the daily job has run.
    await releaseDueOrders();
    const [awaitingApproval, awaitingSourcing] = await Promise.all([
      db.companyProduct.count({ where: { orderStatus: "PENDING_APPROVAL" } }),
      // Approved, released by sales, and waiting on purchasing to place it with a vendor — an in-hand
      // order sales is still holding isn't purchase's to source yet.
      db.companyProduct.count({ where: { orderStatus: "APPROVED", purchaseRelease: "RELEASED" } }),
    ]);
    orders = { awaitingApproval, awaitingSourcing };
  }

  /**
   * Quotations still waiting on an answer.
   *
   * ISSUED and nothing further: a draft has not been sent, and ACCEPTED, REJECTED, EXPIRED and
   * CANCELLED have all had their answer. `validUntil` is carried separately rather than folded
   * into the count — a quote nobody replied to before it lapsed is still pending, and it is the
   * one most worth a phone call.
   */
  let quotations: DashboardSummary["quotations"] = null;
  if (salesDocumentsEnabled) {
    const scopeIds = await accountScopeIds(user.id);
    const where = {
      direction: "SALES" as const,
      docType: "PROPOSAL" as const,
      status: "ISSUED" as const,
      ...(scopeIds === null ? {} : { company: { ownerUserId: { in: scopeIds } } }),
    };
    const [agg, lapsed] = await Promise.all([
      db.tradeDocument.aggregate({ where, _count: { _all: true }, _sum: { total: true } }),
      db.tradeDocument.count({ where: { ...where, validUntil: { not: null, lt: now } } }),
    ]);
    quotations = { pending: agg._count._all, value: Number(agg._sum.total ?? 0), lapsed };
  }

  /**
   * The monthly target, measured by the same code the Targets screen uses.
   *
   * `measure` and `progressOf` are what /targets/mine reports against, so the dashboard cannot
   * quietly disagree with the page somebody opens to check it. Re-deriving "achieved" here would
   * be a second definition of how much this person has sold, and two of those is one too many.
   *
   * Which target: the sales ones in preference order, because somebody may hold several for the
   * same month. A calls or visits target is not what this card is named after, so it is not
   * shown here — the Targets screen lists them all.
   */
  let salesTarget: DashboardSummary["salesTarget"] = null;
  if (targetsEnabled) {
    const candidates = await db.target.findMany({
      where: {
        active: true,
        userId: user.id,
        metric: { in: ["ORDER_VALUE", "INVOICED_VALUE", "LEAD_VALUE_WON"] },
        period: "MONTH",
        fromDate: { lte: now },
        toDate: { gte: now },
      },
      select: { metric: true, label: true, value: true, fromDate: true, toDate: true },
    });
    const order = ["ORDER_VALUE", "INVOICED_VALUE", "LEAD_VALUE_WON"];
    const chosen = candidates.sort((a, b) => order.indexOf(a.metric) - order.indexOf(b.metric))[0];
    if (chosen) {
      const achieved = await measure(await getTenantDb(), chosen.metric, {
        from: chosen.fromDate,
        to: chosen.toDate,
        userIds: [user.id],
      });
      const p = progressOf({
        target: Number(chosen.value),
        achieved,
        fromDate: chosen.fromDate,
        toDate: chosen.toDate,
        now,
      });
      salesTarget = {
        label: chosen.label,
        metricLabel: METRICS.find((m) => m.key === chosen.metric)?.label ?? chosen.metric,
        target: p.target,
        achieved: p.achieved,
        percent: p.percent,
        elapsedPercent: p.elapsedPercent,
        daysLeft: p.daysLeft,
        status: p.label,
        tone: p.tone,
      };
    }
  }

  let finance: DashboardSummary["finance"] = null;
  if (accountingEnabled && (await can(user.id, "payments.manage"))) {
    const fy = fiscalYearOf(now);
    // Twelve Indian months back from the start of this one (finance/dashboard.ts `cashWindowFrom`).
    const cashFrom = cashWindowFrom(now);
    const [ie, top, flow, ar, ap] = await Promise.all([
      incomeAndExpense(fy.from, fy.to, "accrual"),
      topExpenses(fy.from, fy.to),
      cashFlow(cashFrom, now),
      receivablesOutstanding(),
      payablesOutstanding(),
    ]);
    finance = {
      incomeExpense: ie,
      topExpenses: top,
      cashFlow: flow,
      receivables: ar,
      payables: ap,
      fiscalLabel: fy.label,
      fiscalFrom: fy.from,
      cashFrom,
      cashTo: now,
    };
  }

  /**
   * Read through `listActivity`, which already decides whose trail this is.
   *
   * Same reasoning as the notes card above: the permission that widens the activity log from
   * your own actions to everybody's lives in one place, and a dashboard card that re-derived it
   * would be the copy that drifts. Five rows, because this is a glance and the log itself is a
   * click away.
   */
  const recentActivity = await listActivity({ filters: {}, page: 1, pageSize: 5 });
  const activity: DashboardSummary["activity"] = {
    ownOnly: recentActivity.scoped,
    items: recentActivity.rows.map((r) => ({
      id: r.id,
      summary: r.summary,
      userName: r.userName,
      kind: r.kind,
      at: r.createdAt,
    })),
  };

  const scopes: Record<string, WidgetScope> = {
    companies: "company",
    customers: "company",
    leads: leadWidgetScope,
    recentLeads: leadWidgetScope,
    vendors: "company",
    renewals: "company",
    upcomingRenewals: "company",
    payments: "company",
    tickets: "company",
    tasks: "own",
    notes: "own",
    incomeExpense: "company",
    topExpenses: "company",
    cashFlow: "company",
    receivables: "company",
    payables: "company",
    quotations: "company",
    salesTarget: "own",
    expenses: "own",
    orders: "company",
    activity: recentActivity.scoped ? "own" : "company",
  };

  return {
    companies, customers, leads, vendors, renewals, projects, payments, tickets, tasks,
    notes, quotations, salesTarget, expenses, orders, finance, activity, scopes,
  };
}

/**
 * Every widget this person is allowed to see.
 *
 * Two gates, not one. The module gate answers "does this company use the feature"; the permission
 * gate answers "is it any of this person's business". Only the first existed, which is how the
 * outstanding-balance card ended up on the dashboard of people with no access to the payments
 * screen it linked to — an invitation to a locked door, on the home page.
 */
export async function getDashboardWidgetOptions(): Promise<DashboardWidgetDefinition[]> {
  const user = await requireUser();
  // A widget is offered for a module this person may open — on, its section not unticked for their role,
  // its view permission held (owner, 8 Oct 2026) — not merely one switched on for the company.
  const moduleKeys = [...new Set(DASHBOARD_WIDGET_REGISTRY.map((w) => w.moduleKey).filter((k): k is string => !!k))];
  const open = new Set((await Promise.all(moduleKeys.map(async (k) => ((await isModuleEnabled(k)) ? k : null)))).filter(Boolean));

  const withModule = DASHBOARD_WIDGET_REGISTRY.filter((w) => w.moduleKey === null || open.has(w.moduleKey));
  const allowed = await Promise.all(withModule.map(async (w) => (w.permission ? can(user.id, w.permission) : true)));
  return withModule.filter((_, i) => allowed[i]);
}

/**
 * What this person sees, and what they would see if they reset.
 *
 * `defaults` is the work-area half of the ask: somebody who has never customised gets the set that
 * belongs to their role rather than every widget they are permitted to open. An accountant's home
 * screen should lead with outstanding balance and orders awaiting approval; a support lead's with
 * open tickets. Both were previously identical, and identical to everyone else's.
 */
export async function getDashboardPreferences(): Promise<{ customized: boolean; widgets: string[]; defaults: string[] }> {
  const user = await requireUser();
  const row = await db.user.findUnique({
    where: { id: user.id },
    select: { dashboardCustomized: true, dashboardWidgets: true, role: true },
  });
  return {
    customized: row?.dashboardCustomized ?? false,
    widgets: row?.dashboardWidgets ?? [],
    defaults: defaultWidgetsForRole(row?.role ?? user.role),
  };
}

export async function setDashboardPreferences(widgetKeys: string[]): Promise<ActionResult<null>> {
  const user = await requireUser();
  const available = await getDashboardWidgetOptions();
  const availableKeys = new Set(available.map((w) => w.key));
  const filtered = widgetKeys.filter((k) => availableKeys.has(k));

  await db.user.update({
    where: { id: user.id },
    data: { dashboardWidgets: filtered, dashboardCustomized: true },
  });

  revalidatePath("/dashboard");
  return { ok: true, data: null };
}

export type DashboardPresetOption = { id: string; label: string; widgets: string[] };

/** Admin-configured per-department "predefined layouts" (Settings → Users & Access → Departments), each already narrowed to widgets this user currently has module access to — a department preset that has nothing left after that narrowing is dropped rather than offered as an empty no-op. */
export async function getDashboardPresetOptions(): Promise<DashboardPresetOption[]> {
  await requireUser();
  const [available, departments] = await Promise.all([
    getDashboardWidgetOptions(),
    db.department.findMany({ where: { defaultDashboardWidgets: { isEmpty: false } }, orderBy: { name: "asc" } }),
  ]);
  const availableKeys = new Set(available.map((w) => w.key));
  return departments
    .map((d) => ({ id: d.id, label: d.name, widgets: d.defaultDashboardWidgets.filter((k) => availableKeys.has(k)) }))
    .filter((p) => p.widgets.length > 0);
}

export async function resetDashboardPreferences(): Promise<ActionResult<null>> {
  const user = await requireUser();
  await db.user.update({
    where: { id: user.id },
    data: { dashboardWidgets: [], dashboardCustomized: false },
  });
  revalidatePath("/dashboard");
  return { ok: true, data: null };
}
