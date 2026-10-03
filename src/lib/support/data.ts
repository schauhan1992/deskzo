import { cache } from "react";
import { db } from "@/lib/db";
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
  const subjects = await loadCreditSubjects(counts.map((c) => c.companyId));
  const peerRatios: number[] = [];
  for (const c of counts) {
    const billed = (subjects.get(c.companyId)?.bills ?? [])
      .filter((b) => b.issuedOn.getTime() >= window.from.getTime() && b.issuedOn.getTime() < window.to.getTime())
      .reduce((t, b) => t + b.amount, 0);
    if (billed > 0) peerRatios.push(c._count._all / (billed / 100_000));
  }
  return { peerRatios, peerTicketCounts: counts.map((c) => c._count._all) };
});

/** Customers with any support in the window, among those given — for the Support load list. */
export async function companiesWithSupport(scope: object, window: { from: Date; to: Date }): Promise<string[]> {
  const inWindow = { gte: window.from, lt: window.to };
  const base = { AND: [scope, { relationshipType: { in: ["CLIENT", "RESELLER"] as ("CLIENT" | "RESELLER")[] } }] };
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
