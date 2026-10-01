"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser, moduleAvailableForTenant } from "@/lib/modules-access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { formatMoney } from "@/lib/currency";
import { formatOrderId } from "@/lib/order-id";
import { settleInvoice } from "@/lib/receivables";
import { computeOrderFinancials } from "@/lib/orders/financials";
import { logFollowUpSchema } from "@/lib/validation/collections";
import {
  STALE_DAYS,
  checkFutureDay,
  followUpChannelLabels,
  istToday,
  shortDay,
  weekWindow,
  dayKey,
} from "@/lib/collections/rules";
import {
  inCollectionsScope,
  loadDues,
  loadFollowUps,
  mayLogFollowUps,
  type DueRow,
  type FollowUpView,
} from "@/lib/collections/load";
import type { ActionResult } from "@/actions/company";

/**
 * Collections: what a salesperson's clients owe, and what they said about paying it.
 *
 * Who: `collections.followUp` (the admin grants it; off by default) or `payments.record` (accounts),
 * with the Receivables module's view permission (`payments.view`) — see `mayLogFollowUps`. What: the
 * dues in the collections scope (src/lib/collections/load.ts, owner decision C-D1). Reading a follow-up
 * history on an invoice, an order or a statement needs only what reading that account's money needs:
 * `payments.view` and the account scope.
 */

export type CollectionsFilter = "all" | "overdue" | "broken" | "week" | "stale";
export type CollectionsSort = "overdue" | "amount";

const FILTERS: CollectionsFilter[] = ["all", "overdue", "broken", "week", "stale"];

/** What a promise is worth in rupees: its amount, or — promised with no amount — what is owed. */
const promisedInr = (row: DueRow) =>
  Math.round((row.promise?.promisedAmount ?? row.balance) * row.rate * 100) / 100;

/**
 * The Collections page: every due in the viewer's scope, grouped by client, with its last follow-up,
 * its promise and the next planned follow-up. Null for somebody who may not open it.
 */
export async function listCollections(params: { filter?: string; q?: string; sort?: string } = {}) {
  const user = await requireModuleUser("receivables");
  if (!(await mayLogFollowUps(user.id))) return null;
  const now = new Date();
  const filter: CollectionsFilter = FILTERS.includes(params.filter as CollectionsFilter) ? (params.filter as CollectionsFilter) : "all";
  const sort: CollectionsSort = params.sort === "amount" ? "amount" : "overdue";

  const { restricted, rows } = await loadDues(user.id, { search: params.q, now });

  // The tiles summarise everything in scope (after the search), whichever chip is picked.
  const sum = (list: DueRow[], of: (r: DueRow) => number) => Math.round(list.reduce((t, r) => t + of(r), 0) * 100) / 100;
  const overdue = rows.filter((r) => r.daysOverdue > 0);
  const week = rows.filter((r) => r.promisedThisWeek);
  const broken = rows.filter((r) => r.broken);
  const tiles = {
    pending: sum(rows, (r) => r.balanceInr),
    pendingCount: rows.length,
    overdue: sum(overdue, (r) => r.balanceInr),
    overdueCount: overdue.length,
    promisedWeek: sum(week, promisedInr),
    promisedWeekCount: week.length,
    broken: sum(broken, promisedInr),
    brokenCount: broken.length,
  };

  const shown = rows.filter((r) =>
    filter === "overdue" ? r.daysOverdue > 0 : filter === "broken" ? r.broken : filter === "week" ? r.promisedThisWeek : filter === "stale" ? r.stale : true,
  );
  shown.sort((a, b) =>
    sort === "amount" ? b.balanceInr - a.balanceInr || b.daysOverdue - a.daysOverdue : b.daysOverdue - a.daysOverdue || b.balanceInr - a.balanceInr,
  );

  // Grouped by client, in the order their first (most pressing) due came in the sort.
  const groups = new Map<string, { companyId: string; companyName: string; ownerName: string | null; onTheirAccount: boolean; total: number; rows: DueRow[] }>();
  for (const row of shown) {
    const group =
      groups.get(row.companyId) ??
      { companyId: row.companyId, companyName: row.companyName, ownerName: row.ownerName, onTheirAccount: row.onTheirAccount, total: 0, rows: [] };
    group.rows.push(row);
    group.total = Math.round((group.total + row.balanceInr) * 100) / 100;
    groups.set(row.companyId, group);
  }

  const { from, to } = weekWindow(now);
  return {
    restricted,
    filter,
    sort,
    staleDays: STALE_DAYS,
    week: { from: dayKey(from), to: dayKey(to) },
    tiles,
    groups: [...groups.values()],
    shownCount: shown.length,
  };
}

/**
 * Logs a follow-up on an invoice, or on an order nobody has invoiced: what the client said, and any
 * promise to pay by a date. A new promise on the same invoice or order replaces the one still open
 * (SUPERSEDED). A next follow-up date becomes a task for whoever logged it, due that day, as a promised
 * callback does — or, with the tasks module off, a reminder that morning from the daily job.
 */
export async function logFollowUp(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("receivables");
  if (!(await mayLogFollowUps(user.id))) {
    return { ok: false, error: "You don't have permission to log payment follow-ups." };
  }
  const parsed = logFollowUpSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;
  const documentId = data.documentId || null;
  const companyProductId = data.companyProductId || null;

  // In scope before anything about it is said: an invoice outside it reads the same as one that isn't there.
  if (!(await inCollectionsScope(user.id, { documentId, companyProductId }))) {
    return { ok: false, error: documentId ? "That invoice isn't in your collections." : "That order isn't in your collections." };
  }

  const now = new Date();
  let promisedOn: Date | null = null;
  if (data.promisedOn) {
    const day = checkFutureDay(data.promisedOn, now, "promised date");
    if (!day.ok) return { ok: false, error: day.error };
    promisedOn = day.day;
  }
  let nextFollowUpOn: Date | null = null;
  if (data.nextFollowUpOn) {
    const day = checkFutureDay(data.nextFollowUpOn, now, "next follow-up date");
    if (!day.ok) return { ok: false, error: day.error };
    nextFollowUpOn = day.day;
  }

  // What is chased, and what is still owed on it — in the invoice's own currency, or rupees for an order.
  let target: { companyId: string; companyName: string; label: string; balance: number; currency: string };
  if (documentId) {
    const invoice = await db.tradeDocument.findUnique({
      where: { id: documentId },
      select: {
        docType: true,
        status: true,
        docNumber: true,
        companyId: true,
        currency: true,
        total: true,
        company: { select: { name: true } },
        payments: { select: { amount: true } },
        creditsReceived: { select: { amount: true } },
      },
    });
    if (!invoice || invoice.docType !== "INVOICE") return { ok: false, error: "Follow-ups are logged against a tax invoice." };
    if (invoice.status === "DRAFT") return { ok: false, error: "This invoice hasn't been issued yet — there is nothing to chase." };
    if (invoice.status === "CANCELLED") return { ok: false, error: "This invoice has been cancelled — there is nothing to chase." };
    const settlement = settleInvoice(
      Number(invoice.total),
      invoice.payments.reduce((t, p) => t + Number(p.amount), 0),
      invoice.creditsReceived.reduce((t, c) => t + Number(c.amount), 0),
    );
    target = { companyId: invoice.companyId, companyName: invoice.company.name, label: invoice.docNumber, balance: settlement.balance, currency: invoice.currency };
  } else {
    const order = await db.companyProduct.findUnique({
      where: { id: companyProductId! },
      select: {
        orderSeq: true,
        orderStatus: true,
        companyId: true,
        quantity: true,
        unitPrice: true,
        company: { select: { name: true } },
        item: { select: { sellingPrice: true, taxRatePercent: true } },
        allocations: { select: { amount: true } },
      },
    });
    if (!order) return { ok: false, error: "That order isn't in your collections." };
    // A cancelled order's money moved on account when it was cancelled; nothing is owed on it.
    if (order.orderStatus === "CANCELLED" || order.orderStatus === "REJECTED") {
      return { ok: false, error: `This order is ${order.orderStatus === "CANCELLED" ? "cancelled" : "rejected"} — there is nothing to chase.` };
    }
    target = {
      companyId: order.companyId,
      companyName: order.company.name,
      label: formatOrderId(order.orderSeq),
      balance: Math.max(computeOrderFinancials(order).balance, 0),
      currency: "INR",
    };
  }

  const amount = data.promisedAmount ?? null;
  if (promisedOn && target.balance < 0.01) {
    return { ok: false, error: `Nothing is outstanding on ${target.label}, so there is no payment to promise.` };
  }
  if (amount !== null && amount > target.balance + 0.005) {
    return { ok: false, error: `Only ${formatMoney(target.balance, target.currency)} is outstanding on ${target.label}.` };
  }

  // The task stands in for the reminder when there is a tasks module to put it in.
  const withTask = nextFollowUpOn !== null && (await moduleAvailableForTenant("tasks"));
  const promiseLine = promisedOn
    ? `Promised ${amount !== null ? formatMoney(amount, target.currency) : "to pay"} by ${shortDay(promisedOn)}.`
    : "";

  const created = await db.$transaction(async (tx) => {
    // One promise in play per invoice or order: the new one replaces whatever was still open.
    if (promisedOn) {
      await tx.paymentFollowUp.updateMany({
        where: { promiseStatus: "OPEN", ...(documentId ? { documentId } : { companyProductId }) },
        data: { promiseStatus: "SUPERSEDED", promiseResolvedAt: now },
      });
    }
    let taskId: string | null = null;
    if (withTask && nextFollowUpOn) {
      // Assigned to whoever made the plan, as a promised callback is (src/actions/call.ts). Due that day,
      // held as the task form holds a day.
      const task = await tx.task.create({
        data: {
          title: `Follow up ${target.companyName} on ${target.label}`,
          description: `Payment follow-up. Last time (${followUpChannelLabels[data.channel].toLowerCase()}): ${data.remarks}${promiseLine ? `\n${promiseLine}` : ""}`,
          dueDate: nextFollowUpOn,
          assignedToUserId: user.id,
          createdByUserId: user.id,
          companyId: target.companyId,
        },
        select: { id: true },
      });
      taskId = task.id;
    }
    return tx.paymentFollowUp.create({
      data: {
        companyId: target.companyId,
        documentId,
        companyProductId,
        byUserId: user.id,
        channel: data.channel,
        remarks: data.remarks,
        promisedOn,
        promisedAmount: amount !== null ? new Prisma.Decimal(amount) : null,
        promiseStatus: promisedOn ? "OPEN" : null,
        nextFollowUpOn,
        taskId,
      },
      select: { id: true },
    });
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "PaymentFollowUp",
    entityId: created.id,
    entityLabel: `${followUpChannelLabels[data.channel]} follow-up on ${target.label} — ${target.companyName}${promiseLine ? ` · ${promiseLine}` : ""}`,
  });

  revalidatePath("/collections");
  revalidatePath("/receivables");
  revalidatePath(`/companies/${target.companyId}`);
  if (documentId) revalidatePath(`/documents/${documentId}`);
  if (companyProductId) revalidatePath(`/orders/${companyProductId}`);
  if (withTask) revalidatePath("/tasks");
  return { ok: true, data: created };
}

export type FollowUpTarget = {
  documentId?: string;
  companyProductId?: string;
  label: string;
  companyName: string;
  balance: number;
  currency: string;
};

/**
 * The follow-up history of one invoice or order, for its own page — to anybody who can see that
 * account's money (`payments.view` and the account scope) — and whether they may log another.
 *
 * An invoice's history includes what was said about the orders it bills before it was raised.
 */
export async function followUpPanel(
  of: { documentId?: string; companyProductId?: string },
): Promise<{ history: FollowUpView[]; canLog: boolean; target: FollowUpTarget; today: string } | null> {
  const user = await requireModuleUser("receivables");
  if (!(await can(user.id, "payments.view"))) return null;
  const now = new Date();

  if (of.documentId) {
    const invoice = await db.tradeDocument.findUnique({
      where: { id: of.documentId },
      select: {
        id: true,
        docType: true,
        status: true,
        docNumber: true,
        currency: true,
        total: true,
        company: { select: { name: true, ownerUserId: true } },
        payments: { select: { amount: true } },
        creditsReceived: { select: { amount: true } },
        lines: { where: { companyProductId: { not: null } }, select: { companyProductId: true } },
      },
    });
    if (!invoice || invoice.docType !== "INVOICE" || !(await canSeeCompany(user.id, invoice.company.ownerUserId))) return null;
    const orderIds = invoice.lines.map((l) => l.companyProductId!);
    const history = await loadFollowUps({ OR: [{ documentId: invoice.id }, ...(orderIds.length ? [{ companyProductId: { in: orderIds } }] : [])] }, now);
    const balance = settleInvoice(
      Number(invoice.total),
      invoice.payments.reduce((t, p) => t + Number(p.amount), 0),
      invoice.creditsReceived.reduce((t, c) => t + Number(c.amount), 0),
    ).balance;
    const chaseable = invoice.status !== "DRAFT" && invoice.status !== "CANCELLED" && balance >= 0.01;
    return {
      history,
      canLog: chaseable && (await mayLogFollowUps(user.id)),
      target: { documentId: invoice.id, label: invoice.docNumber, companyName: invoice.company.name, balance, currency: invoice.currency },
      today: dayKey(istToday(now)),
    };
  }

  if (of.companyProductId) {
    const order = await db.companyProduct.findUnique({
      where: { id: of.companyProductId },
      select: {
        id: true,
        orderSeq: true,
        orderStatus: true,
        quantity: true,
        unitPrice: true,
        company: { select: { name: true, ownerUserId: true } },
        item: { select: { sellingPrice: true, taxRatePercent: true } },
        allocations: { select: { amount: true } },
      },
    });
    if (!order || !(await canSeeCompany(user.id, order.company.ownerUserId))) return null;
    const history = await loadFollowUps({ companyProductId: order.id }, now);
    const balance = Math.max(computeOrderFinancials(order).balance, 0);
    const chaseable = order.orderStatus !== "CANCELLED" && order.orderStatus !== "REJECTED" && balance >= 0.01;
    return {
      history,
      canLog: chaseable && (await mayLogFollowUps(user.id)),
      target: { companyProductId: order.id, label: formatOrderId(order.orderSeq), companyName: order.company.name, balance, currency: "INR" },
      today: dayKey(istToday(now)),
    };
  }
  return null;
}
