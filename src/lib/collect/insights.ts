import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { settleInvoice } from "@/lib/receivables";
import { RECEIVABLE_DOC_TYPE } from "@/lib/trade-documents";

/**
 * How fast customers pay, and what should come in (owner, 23 Oct 2026):
 *
 *   · DSO — days sales outstanding — at each month's end for a year: what was owed on invoices then, over what
 *     was invoiced in the three months to it, times those days. The lower, the faster money comes in.
 *   · The next eight weeks: promises to pay falling in each week, and invoices falling due in it with no
 *     promise against them — plus what's already overdue with no promise, which nobody can date.
 *
 * In rupees, each invoice at its own rate; only the invoices the person reaches.
 */

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const utcDay = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

export type DsoMonth = { label: string; monthKey: string; dso: number | null; owed: number; invoiced: number };
export type ForecastWeek = { start: Date; promised: number; due: number; invoices: number };
export type CollectionInsights = {
  dso: DsoMonth[];
  current: number | null;
  weeks: ForecastWeek[];
  overdueUnpromised: { amount: number; invoices: number };
};

const MONTH_LABEL = new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });

export async function collectionInsights(scope: Prisma.TradeDocumentWhereInput, today: Date): Promise<CollectionInsights> {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const earliest = utcDay(y, m - 15, 1);
  const invoices = await db.tradeDocument.findMany({
    where: {
      AND: [
        scope,
        { docType: RECEIVABLE_DOC_TYPE, status: { notIn: ["DRAFT", "CANCELLED"] } },
        // Everything raised in the last fifteen months, and anything older still open.
        { OR: [{ issueDate: { gte: earliest } }, { status: { in: ["ISSUED", "PARTIALLY_PAID"] } }] },
      ],
    },
    select: {
      id: true,
      issueDate: true,
      dueDate: true,
      total: true,
      exchangeRate: true,
      paidBefore: true,
      payments: { select: { amount: true, payment: { select: { paidOn: true } } } },
      creditsReceived: { select: { amount: true, creditNote: { select: { issueDate: true } } } },
    },
    take: 20_000,
  });

  const rows = invoices.map((i) => ({
    id: i.id,
    issued: i.issueDate.getTime(),
    due: (i.dueDate ?? i.issueDate).getTime(),
    rate: Number(i.exchangeRate) || 1,
    total: Number(i.total),
    before: Number(i.paidBefore),
    settled: [
      ...i.payments.map((p) => ({ at: p.payment.paidOn.getTime(), amount: Number(p.amount) })),
      ...i.creditsReceived.map((c) => ({ at: c.creditNote.issueDate.getTime(), amount: Number(c.amount) })),
    ],
  }));

  /** What was owed, and what was invoiced in the three months, before `end` (a month's first day, exclusive). */
  const at = (end: number) => {
    const from = utcDay(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth() - 3, new Date(end).getUTCDate()).getTime();
    let owed = 0;
    let invoiced = 0;
    for (const r of rows) {
      if (r.issued >= end) continue;
      if (r.issued >= from) invoiced += r.total * r.rate;
      const paid = r.settled.filter((s) => s.at < end).reduce((t, s) => t + s.amount, 0);
      owed += Math.max(r.total - r.before - paid, 0) * r.rate;
    }
    const days = Math.round((end - from) / DAY);
    return { owed: round2(owed), invoiced: round2(invoiced), dso: invoiced > 0 ? Math.round((owed / invoiced) * days) : null };
  };

  const dso: DsoMonth[] = [];
  for (let back = 12; back >= 1; back -= 1) {
    const end = utcDay(y, m - back + 1, 1).getTime();
    const monthStart = utcDay(y, m - back, 1);
    const figures = at(end);
    dso.push({ label: MONTH_LABEL.format(monthStart), monthKey: monthStart.toISOString().slice(0, 7), ...figures });
  }
  const current = at(today.getTime() + DAY).dso;

  // The next eight weeks, Monday to Sunday, from this week's Monday.
  const monday = today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY;
  const weeks: ForecastWeek[] = Array.from({ length: 8 }, (_, n) => ({ start: new Date(monday + n * 7 * DAY), promised: 0, due: 0, invoices: 0 }));
  const weekOf = (time: number) => {
    const n = Math.floor((time - monday) / (7 * DAY));
    return n >= 0 && n < weeks.length ? weeks[n]! : null;
  };
  const open = rows
    .map((r) => ({ ...r, balance: settleInvoice(r.total, r.settled.reduce((t, s) => t + s.amount, 0), 0, r.before).balance }))
    .filter((r) => r.balance >= 1);
  const promises = await db.paymentFollowUp.findMany({
    where: { documentId: { in: open.map((r) => r.id) }, promiseStatus: "OPEN", promisedOn: { not: null } },
    select: { documentId: true, promisedOn: true, promisedAmount: true },
  });
  const promisedIds = new Set(promises.map((p) => p.documentId));
  const byId = new Map(open.map((r) => [r.id, r]));
  for (const p of promises) {
    const invoice = byId.get(p.documentId!);
    const week = weekOf(p.promisedOn!.getTime());
    if (!invoice || !week) continue;
    week.promised += Math.min(Number(p.promisedAmount ?? invoice.balance), invoice.balance) * invoice.rate;
    week.invoices += 1;
  }
  const overdueUnpromised = { amount: 0, invoices: 0 };
  for (const r of open) {
    if (promisedIds.has(r.id)) continue;
    if (r.due < monday) {
      overdueUnpromised.amount += r.balance * r.rate;
      overdueUnpromised.invoices += 1;
      continue;
    }
    const week = weekOf(r.due);
    if (!week) continue;
    week.due += r.balance * r.rate;
    week.invoices += 1;
  }
  return {
    dso,
    current,
    weeks: weeks.map((w) => ({ ...w, promised: round2(w.promised), due: round2(w.due) })),
    overdueUnpromised: { amount: round2(overdueUnpromised.amount), invoices: overdueUnpromised.invoices },
  };
}
