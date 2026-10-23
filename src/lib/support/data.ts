import { cache } from "react";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { calculateOrderAmount } from "@/lib/gst";
import { customerSide } from "@/lib/companies/roles";
import type { Clock } from "@/lib/time/zone";
import { loadCreditSubjects } from "@/lib/credit/load";
import { SUPPORT_VISIT_PURPOSES, type SupportFacts } from "@/lib/support/load";

/**
 * The database side of the support measure: every customer's tickets, support calls, support visits
 * and billing over a window, batched so a list of a few hundred customers is a handful of queries.
 *
 * Not a "use server" module — it answers for any company it is handed; the actions in
 * src/actions/support-load.ts decide who may ask.
 */

/** The last `months` whole months on the workspace's clock, the current one included: [from, to). */
export function supportWindow(clock: Clock, months: number, asOf = new Date()): { from: Date; to: Date } {
  // Both count months from 0, and `midnight` rolls a negative month back into last year.
  const { year, month } = clock.parts(asOf);
  return { from: clock.midnight(year, month - (months - 1), 1), to: asOf };
}

const LIVE_EXPENSE = ["SUBMITTED", "APPROVED", "REIMBURSED"] as const;

export async function loadSupportFacts(companyIds: string[], window: { from: Date; to: Date }): Promise<Map<string, SupportFacts>> {
  const ids = [...new Set(companyIds)];
  const facts = new Map<string, SupportFacts>(ids.map((id) => [id, { tickets: [], calls: [], visits: [], billed: 0 }]));
  if (ids.length === 0) return facts;
  const inWindow = { gte: window.from, lt: window.to };

  const [tickets, calls, visits, subjects] = await Promise.all([
    db.ticket.findMany({
      // A demo is selling, not supporting.
      where: { companyId: { in: ids }, createdAt: inWindow, ticketType: { not: "DEMO" } },
      select: {
        companyId: true,
        priority: true,
        ticketType: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
        _count: { select: { comments: true } },
        companyProduct: { select: { item: { select: { name: true } } } },
        assignedTo: { select: { name: true } },
      },
    }),
    db.callLog.findMany({
      // About a ticket, or the customer ringing us about something that isn't a sale.
      where: { companyId: { in: ids }, startedAt: inWindow, OR: [{ ticketId: { not: null } }, { direction: "INBOUND", leadId: null }] },
      select: { companyId: true, startedAt: true, durationSeconds: true },
    }),
    db.visit.findMany({
      where: {
        companyId: { in: ids },
        scheduledFor: inWindow,
        purpose: { in: [...SUPPORT_VISIT_PURPOSES] },
        status: { notIn: ["CANCELLED", "NO_SHOW"] },
      },
      select: {
        companyId: true,
        scheduledFor: true,
        checkInAt: true,
        checkOutAt: true,
        distanceKm: true,
        expenses: { where: { status: { in: [...LIVE_EXPENSE] } }, select: { amount: true } },
      },
    }),
    loadCreditSubjects(ids),
  ]);

  for (const t of tickets) {
    facts.get(t.companyId)!.tickets.push({
      priority: t.priority,
      type: t.ticketType,
      status: t.status,
      createdAt: t.createdAt,
      resolvedAt: t.resolvedAt,
      replies: t._count.comments,
      product: t.companyProduct?.item.name ?? null,
      handler: t.assignedTo?.name ?? null,
    });
  }
  for (const c of calls) facts.get(c.companyId)!.calls.push({ startedAt: c.startedAt, durationSeconds: c.durationSeconds });
  for (const v of visits) {
    facts.get(v.companyId)!.visits.push({
      scheduledFor: v.scheduledFor,
      checkInAt: v.checkInAt,
      checkOutAt: v.checkOutAt,
      distanceKm: v.distanceKm === null ? null : Number(v.distanceKm),
      expenses: v.expenses.reduce((t, e) => t + Number(e.amount), 0),
    });
  }
  // Billed over the same months — the invoices and billed orders the credit engine already reads.
  for (const [id, subject] of subjects) {
    const f = facts.get(id);
    if (!f) continue;
    f.billed = subject.bills
      .filter((b) => b.issuedOn.getTime() >= window.from.getTime() && b.issuedOn.getTime() < window.to.getTime())
      .reduce((t, b) => t + b.amount, 0);
  }
  return facts;
}

/**
 * Every customer's tickets per ₹1 lakh, and ticket counts — the company-wide "typical" a customer is
 * compared with. Across the whole company, not the viewer's own accounts: a salesperson's three
 * customers are not a population. Only numbers leave here, never whose they are.
 *
 * Memoised per request, since a list and a customer page can both ask within one render.
 */
export const supportPeers = cache(async (fromIso: string, toIso: string) => {
  const window = { from: new Date(fromIso), to: new Date(toIso) };
  const counts = await db.ticket.groupBy({
    by: ["companyId"],
    where: { createdAt: { gte: window.from, lt: window.to }, ticketType: { not: "DEMO" } },
    _count: { _all: true },
  });
  const billed = await billedInWindow(window);
  const peerRatios: number[] = [];
  for (const c of counts) {
    const amount = billed.get(c.companyId) ?? 0;
    if (amount > 0) peerRatios.push(c._count._all / (amount / 100_000));
  }
  return { peerRatios, peerTicketCounts: counts.map((c) => c._count._all) };
});

const BILLED_INVOICE = ["ISSUED", "PARTIALLY_PAID", "PAID"] as const;

/**
 * What each customer with a ticket in the window was billed in it — the bills `loadCreditSubjects` counts
 * (src/lib/credit/load.ts), issued in the window: invoices and debit notes in rupees at their rate, by
 * what is new in these books, and approved orders not invoiced, from their approval. Added up by the
 * database for the invoices, and read for those customers only through the tickets — never as a list of
 * ids. Every customer's whole credit history was read for this on every customer page (the large-
 * workspace load test, 23 Oct 2026).
 */
async function billedInWindow(window: { from: Date; to: Date }): Promise<Map<string, number>> {
  const withTickets = { tickets: { some: { createdAt: { gte: window.from, lt: window.to }, ticketType: { not: "DEMO" as const } } } };
  const [invoices, orders] = await Promise.all([
    db.$queryRaw<{ companyId: string; amount: Prisma.Decimal | null }[]>`
      SELECT d."companyId", SUM((d."total" - d."paidBefore") * COALESCE(NULLIF(d."exchangeRate", 0), 1)) AS amount
      FROM "trade_documents" d
      WHERE d."docType"::text IN ('INVOICE', 'DEBIT_NOTE') AND d."direction"::text = 'SALES'
        AND d."status"::text IN (${Prisma.join([...BILLED_INVOICE])})
        AND d."total" - d."paidBefore" > 0
        AND d."issueDate" >= ${window.from} AND d."issueDate" < ${window.to}
        AND EXISTS (SELECT 1 FROM "tickets" t WHERE t."companyId" = d."companyId" AND t."createdAt" >= ${window.from} AND t."createdAt" < ${window.to} AND t."ticketType"::text <> 'DEMO')
      GROUP BY d."companyId"`,
    db.companyProduct.findMany({
      where: {
        company: withTickets,
        orderStatus: { in: ["APPROVED", "PROCESSING", "FULFILLED"] },
        documentLines: { none: { document: { docType: "INVOICE", status: { in: [...BILLED_INVOICE] } } } },
        OR: [{ accountsApprovedAt: { gte: window.from, lt: window.to } }, { accountsApprovedAt: null, createdAt: { gte: window.from, lt: window.to } }],
      },
      select: { companyId: true, quantity: true, unitPrice: true, item: { select: { sellingPrice: true, taxRatePercent: true } } },
    }),
  ]);
  const billed = new Map(invoices.map((r) => [r.companyId, Number(r.amount ?? 0)]));
  for (const o of orders) {
    const { total } = calculateOrderAmount({
      quantity: o.quantity,
      unitPrice: Number(o.unitPrice ?? o.item.sellingPrice),
      taxRatePercent: o.item.taxRatePercent ? Number(o.item.taxRatePercent) : null,
    });
    if (total > 0) billed.set(o.companyId, (billed.get(o.companyId) ?? 0) + total);
  }
  return billed;
}

/** Customers with any support in the window, among those given — for the Support load list. */
export async function companiesWithSupport(scope: object, window: { from: Date; to: Date }): Promise<string[]> {
  const inWindow = { gte: window.from, lt: window.to };
  const base = { AND: [scope, await customerSide()] };
  const rows = await db.company.findMany({
    where: {
      ...base,
      OR: [
        { tickets: { some: { createdAt: inWindow, ticketType: { not: "DEMO" } } } },
        { calls: { some: { startedAt: inWindow, OR: [{ ticketId: { not: null } }, { direction: "INBOUND", leadId: null }] } } },
        { visits: { some: { scheduledFor: inWindow, purpose: { in: [...SUPPORT_VISIT_PURPOSES] }, status: { notIn: ["CANCELLED", "NO_SHOW"] } } } },
      ],
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
