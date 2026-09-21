import { db } from "@/lib/db";
import type { SoldOrder } from "@/lib/reconcile/match";

/**
 * Getting our own side of the comparison out of the database.
 *
 * A plain module rather than `"use server"`, like the rest of the engine: every export from one of
 * those is a public endpoint, and this one answers "what did we sell, to whom, at what cost" — a
 * useful thing for somebody outside the company to be able to ask.
 */

/**
 * Every order that could plausibly appear on this statement.
 *
 * ## Which orders count
 *
 * Narrowed by **period overlap**, not by vendor. That looks wrong and is deliberate: `vendorId` is
 * set by the purchase team after approval and is routinely left blank, so filtering on it would
 * silently drop exactly the orders nobody has finished recording — which are the ones most likely
 * to disagree with the distributor. A line matched to an order bought from a different vendor is
 * visible and correctable; an order that never appears at all is not.
 *
 * ## Addons
 *
 * Included as themselves. A co-terminated addon is a separate order sharing an expiry, and the
 * distributor bills its seats as their own line — so collapsing addons into their parent would
 * produce a seat-count mismatch on every subscription that has ever been added to.
 *
 * ## Recently ended orders are included too
 *
 * And this is the one that makes the module worth having. The most expensive thing it finds is a
 * subscription that was cancelled months ago and is still being billed for — and that order, by
 * definition, does not overlap the statement period. Fetch only overlapping orders and the
 * reconciler never sees it, so the line reads as "a SKU we do not stock": a catalogue problem,
 * filed under housekeeping, rather than money leaving the building every month.
 *
 * With a year of lookback the same line reads as "this customer's subscription ended in March and
 * the distributor is still charging us", which is a phone call. The extra rows cost nothing: the
 * period check inside `reconcile` keeps them out of every other verdict, including the
 * `SOLD_NOT_BILLED` pass, which asks whether the order overlaps the period rather than whether it
 * was fetched.
 *
 * ## Aliases
 *
 * Everything that legitimately names the same customer: the company's website domain, and — for a
 * reseller's order — the end customer it was bought for. A distributor names whoever consumes the
 * licence, which for reseller business is never who we invoice.
 */
export async function soldInPeriod(
  period: { start: Date; end: Date },
  options: { lookBackMonths?: number } = {},
): Promise<SoldOrder[]> {
  const lookBack = new Date(period.start);
  lookBack.setMonth(lookBack.getMonth() - (options.lookBackMonths ?? 12));

  const orders = await db.companyProduct.findMany({
    where: {
      // A cancelled order is not something we sold, so being billed for one is a real exception
      // rather than a match — leaving them out is what lets that surface.
      orderStatus: { notIn: ["REJECTED", "CANCELLED"] },
      OR: [
        { startDate: null, endDate: null },
        { startDate: { lte: period.end }, endDate: null },
        { startDate: null, endDate: { gte: period.start } },
        { startDate: { lte: period.end }, endDate: { gte: period.start } },
        // Lapsed within the lookback: not a match, but recognisable as one that ended.
        { endDate: { gte: lookBack, lt: period.start } },
      ],
    },
    select: {
      id: true,
      quantity: true,
      purchasePrice: true,
      startDate: true,
      endDate: true,
      orderSeq: true,
      vendorId: true,
      item: { select: { sku: true, name: true } },
      company: { select: { id: true, name: true, website: true } },
      endCustomer: { select: { name: true, website: true } },
    },
  });

  return orders.map((o) => ({
    orderId: o.id,
    companyId: o.company.id,
    companyName: o.company.name,
    aliases: [o.company.website, o.endCustomer?.name, o.endCustomer?.website].filter(
      (a): a is string => Boolean(a && a.trim()),
    ),
    sku: o.item.sku,
    quantity: o.quantity,
    purchasePrice: o.purchasePrice === null ? null : Number(o.purchasePrice),
    startDate: o.startDate,
    endDate: o.endDate,
    orderLabel: o.orderSeq ? `#${o.orderSeq} · ${o.item.name}` : o.item.name,
    vendorId: o.vendorId,
  }));
}

/**
 * Every SKU we stock.
 *
 * Separate from the orders so the reconciler can tell "a product we do not sell" from "a product we
 * sell and have no live order for" — two different jobs, and the advice for each is the opposite of
 * the other's.
 */
export async function catalogueSkus(): Promise<string[]> {
  const items = await db.item.findMany({ select: { sku: true } });
  return items.map((i) => i.sku);
}
