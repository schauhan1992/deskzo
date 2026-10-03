import type { PromiseStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { computeOrderFinancials } from "@/lib/orders/financials";
import { promiseOutcome, type SettlementEvent } from "@/lib/collections/rules";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";

/**
 * Whether the promises to pay were kept — the server half of Collections' promise rules (the pure
 * rules are in ./rules.ts).
 *
 * A plain module, not `"use server"`: nothing here checks who is asking, so none of it may be a
 * client-callable endpoint. The payment and receivable actions call `settlePromisesFor` after their own
 * checks, whenever money or a credit note is set against an invoice or an order; the daily job
 * (./daily.ts) calls `resolvePromises` once a day for everything else — a promise whose day has passed
 * unkept is broken there, and one whose invoice or order has gone is set aside.
 */

/** The invoice states that mean "billed and owed" — as the credit engine reads an order as invoiced. */
const BILLED_INVOICE = ["ISSUED", "PARTIALLY_PAID", "PAID"] as const;

type Target = { gone: true } | { gone: false; total: number; events: SettlementEvent[] };

const invoiceSelect = {
  docType: true,
  status: true,
  total: true,
  payments: { select: { amount: true, createdAt: true, payment: { select: { paidOn: true } } } },
  creditsReceived: { select: { amount: true, createdAt: true } },
} as const;

type InvoiceRow = {
  total: unknown;
  payments: { amount: unknown; createdAt: Date; payment: { paidOn: Date } }[];
  creditsReceived: { amount: unknown; createdAt: Date }[];
};

/** Money in (dated the day it arrived) and credit notes applied (dated when applied), in the invoice's currency. */
function invoiceEvents(invoice: InvoiceRow): SettlementEvent[] {
  return [
    ...invoice.payments.map((p) => ({ amount: Number(p.amount), recordedAt: p.createdAt, effectiveAt: p.payment.paidOn })),
    ...invoice.creditsReceived.map((c) => ({ amount: Number(c.amount), recordedAt: c.createdAt, effectiveAt: c.createdAt })),
  ];
}

/**
 * What a promise is measured against, read once per invoice or order in a run.
 *
 * An order that has since been invoiced is settled through the invoice — its money is allocated there —
 * so the invoices billing it count toward a promise made on the order before it was billed.
 */
async function loadTarget(kind: "doc" | "order", id: string, cache: Map<string, Target>): Promise<Target> {
  const key = `${kind}:${id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let target: Target;
  if (kind === "doc") {
    const invoice = await db.tradeDocument.findUnique({ where: { id }, select: invoiceSelect });
    target =
      !invoice || invoice.docType !== "INVOICE" || invoice.status === "CANCELLED" || invoice.status === "DRAFT"
        ? { gone: true }
        : { gone: false, total: Number(invoice.total), events: invoiceEvents(invoice) };
  } else {
    const order = await db.companyProduct.findUnique({
      where: { id },
      select: {
        orderStatus: true,
        quantity: true,
        unitPrice: true,
        item: { select: { sellingPrice: true, taxRatePercent: true } },
        allocations: { select: { amount: true, createdAt: true, payment: { select: { paidOn: true } } } },
        documentLines: {
          where: { document: { docType: "INVOICE", status: { in: [...BILLED_INVOICE] } } },
          select: { document: { select: { id: true, ...invoiceSelect } } },
        },
      },
    });
    if (!order || order.orderStatus === "CANCELLED" || order.orderStatus === "REJECTED") {
      target = { gone: true };
    } else {
      const invoices = new Map(order.documentLines.map((l) => [l.document.id, l.document]));
      target = {
        gone: false,
        total: computeOrderFinancials(order).total,
        events: [
          ...order.allocations.map((a) => ({ amount: Number(a.amount), recordedAt: a.createdAt, effectiveAt: a.payment.paidOn })),
          ...[...invoices.values()].flatMap(invoiceEvents),
        ],
      };
    }
  }
  cache.set(key, target);
  return target;
}

type PromiseRow = {
  id: string;
  documentId: string | null;
  companyProductId: string | null;
  promisedOn: Date | null;
  promisedAmount: unknown;
  promiseStatus: PromiseStatus | null;
  createdAt: Date;
};

const promiseSelect = {
  id: true,
  documentId: true,
  companyProductId: true,
  promisedOn: true,
  promisedAmount: true,
  promiseStatus: true,
  createdAt: true,
} as const;

/** "kept", "gone" (the invoice or order is cancelled or deleted), or "open" (not kept yet). */
async function outcomeOf(p: PromiseRow, cache: Map<string, Target>, clock: Clock): Promise<"kept" | "gone" | "open"> {
  if (!p.promisedOn) return "open";
  const target = p.documentId
    ? await loadTarget("doc", p.documentId, cache)
    : p.companyProductId
      ? await loadTarget("order", p.companyProductId, cache)
      : ({ gone: true } as const);
  if (target.gone) return "gone";
  const { kept } = promiseOutcome({
    loggedAt: p.createdAt,
    promisedOn: p.promisedOn,
    promisedAmount: p.promisedAmount === null || p.promisedAmount === undefined ? null : Number(p.promisedAmount),
    total: target.total,
    events: target.events,
  }, clock);
  return kept ? "kept" : "open";
}

/** Marks a promise kept — from OPEN, or from BROKEN when money received in time was recorded late. */
async function markKept(id: string, now: Date): Promise<boolean> {
  const { count } = await db.paymentFollowUp.updateMany({
    where: { id, promiseStatus: { in: ["OPEN", "BROKEN"] } },
    data: { promiseStatus: "KEPT", promiseResolvedAt: now },
  });
  return count === 1;
}

/**
 * After money or a credit note is set against these invoices or orders: every promise on them that the
 * settlement now keeps is marked KEPT. Broken ones are looked at too — a receipt dated on or before the
 * promised day and entered afterwards means the client kept their word.
 *
 * Never throws: it runs after the payment is safely recorded, and a promise is bookkeeping about the
 * payment, not part of it. The daily job looks again tomorrow if this fails.
 */
export async function settlePromisesFor(
  targets: { documentIds?: string[]; orderIds?: string[] },
  now: Date = new Date(),
): Promise<{ kept: string[] }> {
  try {
    const documentIds = [...new Set(targets.documentIds ?? [])];
    const orderIds = new Set(targets.orderIds ?? []);
    // Orders billed on these invoices: a promise made on the order is kept by money on its invoice.
    if (documentIds.length) {
      const lines = await db.tradeDocumentLine.findMany({
        where: { documentId: { in: documentIds }, companyProductId: { not: null } },
        select: { companyProductId: true },
      });
      for (const l of lines) if (l.companyProductId) orderIds.add(l.companyProductId);
    }
    if (!documentIds.length && !orderIds.size) return { kept: [] };
    const promises = await db.paymentFollowUp.findMany({
      where: {
        promiseStatus: { in: ["OPEN", "BROKEN"] },
        OR: [
          ...(documentIds.length ? [{ documentId: { in: documentIds } }] : []),
          ...(orderIds.size ? [{ companyProductId: { in: [...orderIds] } }] : []),
        ],
      },
      select: promiseSelect,
    });
    const cache = new Map<string, Target>();
    const clock = await workspaceClock();
    const kept: string[] = [];
    for (const p of promises) {
      if ((await outcomeOf(p, cache, clock)) === "kept" && (await markKept(p.id, now))) kept.push(p.id);
    }
    return { kept };
  } catch (err) {
    console.error("collections: settling promises failed", err);
    return { kept: [] };
  }
}

/** How long after its day a broken promise is still looked at, in case money received in time is entered late. */
const LATE_ENTRY_DAYS = 30;

/**
 * The daily job's pass over every promise still in play:
 *
 *   · OPEN, and the money has come in → KEPT;
 *   · OPEN, and its invoice or order was cancelled or deleted → SUPERSEDED: there is nothing left to
 *     pay, so it is neither kept nor broken;
 *   · OPEN, and its day (the workspace's) has passed unkept → BROKEN;
 *   · BROKEN in the last 30 days, and a receipt dated in time has since been entered → KEPT.
 *
 * Each change is a conditional update from the status read, so a payment recorded while this runs can't
 * be overwritten by it.
 */
export async function resolvePromises(now: Date = new Date()): Promise<{ kept: string[]; broken: string[]; superseded: string[] }> {
  const clock = await workspaceClock();
  const today = clock.calendarDate(now);
  const lateSince = new Date(today.getTime() - LATE_ENTRY_DAYS * 86_400_000);
  const promises = await db.paymentFollowUp.findMany({
    where: {
      OR: [{ promiseStatus: "OPEN" }, { promiseStatus: "BROKEN", promisedOn: { gte: lateSince } }],
    },
    orderBy: { createdAt: "asc" },
    select: promiseSelect,
  });
  const cache = new Map<string, Target>();
  const out = { kept: [] as string[], broken: [] as string[], superseded: [] as string[] };
  for (const p of promises) {
    const outcome = await outcomeOf(p, cache, clock);
    if (outcome === "kept") {
      if (await markKept(p.id, now)) out.kept.push(p.id);
      continue;
    }
    if (p.promiseStatus !== "OPEN") continue;
    if (outcome === "gone") {
      const { count } = await db.paymentFollowUp.updateMany({
        where: { id: p.id, promiseStatus: "OPEN" },
        data: { promiseStatus: "SUPERSEDED", promiseResolvedAt: now },
      });
      if (count === 1) out.superseded.push(p.id);
      continue;
    }
    // The column holds the day; `today` is the workspace's, held the same way — compared by calendar day.
    if (p.promisedOn && p.promisedOn.getTime() < today.getTime()) {
      const { count } = await db.paymentFollowUp.updateMany({
        where: { id: p.id, promiseStatus: "OPEN" },
        data: { promiseStatus: "BROKEN", promiseResolvedAt: now },
      });
      if (count === 1) out.broken.push(p.id);
    }
  }
  return out;
}
