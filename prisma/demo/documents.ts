import { PrismaClient, Prisma } from "@prisma/client";
import { computeDocument, resolveSupplyType, type LineInput } from "../../src/lib/gst-engine";
import type { SeededCompany } from "./companies";
import type { SeededItem } from "./catalogue";
import type { SeededPerson } from "./people";
import { chance, daysAgo, int, log, pick, rnd, some } from "./shared";

/**
 * Quotations, invoices and the money against them.
 *
 * ## The GST is computed, not invented
 *
 * Every document goes through `computeDocument` — the same engine the application uses when
 * somebody raises one by hand. That matters more than it sounds: a demo invoice with plausible-
 * looking tax that does not actually reconcile is worse than no invoice, because the first thing
 * anybody does with a finance screen is add up a column.
 *
 * It also means the intra-state / inter-state split is real. A Mumbai customer gets CGST + SGST; a
 * Bengaluru one gets IGST; and the place of supply that decides it is the customer's own state.
 *
 * ## The chain
 *
 * A won lead has a quotation. Most accepted quotations became invoices. Most invoices were paid,
 * some partly, a few not at all — and the ones that were paid have their receipts allocated
 * against them, which is what makes the outstanding figure on the dashboard mean something.
 */

/** Where we invoice from. Maharashtra, so Mumbai and Pune customers are intra-state. */
const SELLER_STATE = "27";

export async function seedDocuments(
  db: PrismaClient,
  companies: SeededCompany[],
  items: SeededItem[],
  people: SeededPerson[],
) {
  const sales = people.filter((p) => p.dept === "Sales");
  const accounts = people.filter((p) => p.dept === "Accounts");
  // Whoever raises a purchase order. Falls back to Accounts on a roster too small to have a
  // purchase desk of its own, so this never picks from an empty list.
  const purchasers = people.filter((p) => p.dept === "Purchase").length > 0
    ? people.filter((p) => p.dept === "Purchase")
    : accounts;

  const orders = await db.companyProduct.findMany({
    select: {
      id: true, companyId: true, locationId: true, itemId: true, quantity: true,
      unitPrice: true, createdAt: true, addedByUserId: true,
      item: { select: { name: true, hsnCode: true, taxRatePercent: true, unit: true, type: true } },
    },
  });
  /**
   * Orders grouped into the documents they were raised on.
   *
   * By company *and* by month, not by company alone. A customer who bought in March and again in
   * September did not get one invoice covering both — they got two, and collapsing them produced
   * 74 invoices for a year of trading, which is about a third of what a business doing this volume
   * actually raises.
   */
  const byBatch = new Map<string, typeof orders>();
  for (const o of orders) {
    const key = `${o.companyId}:${o.createdAt.getUTCFullYear()}-${o.createdAt.getUTCMonth()}`;
    const list = byBatch.get(key) ?? [];
    list.push(o);
    byBatch.set(key, list);
  }

  const companyById = new Map(companies.map((c) => [c.id, c]));

  let quotes = 0;
  let invoices = 0;
  let allocations = 0;
  let outstanding = 0;
  const seq = { PROPOSAL: 0, PROFORMA: 0, INVOICE: 0, PURCHASE_ORDER: 0, BILL: 0, DELIVERY_CHALLAN: 0 };
  let proformas = 0;
  let purchases = 0;
  let challans = 0;

  /**
   * Who we buy from.
   *
   * A purchase order and the bill against it point at a vendor, not at the customer the goods are
   * for — so without this the purchase side of the app has nothing in it at all, and the two
   * document types that live there cannot be opened, filtered or approved.
   */
  const vendors = companies.filter((c) => c.relationship === "VENDOR");

  for (const [key, group] of byBatch) {
    const companyId = key.split(":")[0]!;
    const company = companyById.get(companyId);
    if (!company) continue;

    const supplyType = resolveSupplyType(SELLER_STATE, company.stateCode);
    const lines: LineInput[] = group.map((o) => ({
      quantity: o.quantity,
      unitPrice: Number(o.unitPrice ?? 0),
      // Discounts are normal in this trade and are what makes the margin report interesting.
      discountMode: "PERCENT" as const,
      discountValue: chance(0.45) ? int(2, 12) : 0,
      taxRatePercent: Number(o.item.taxRatePercent ?? 18),
    }));
    if (lines.length === 0) continue;

    const computed = computeDocument(lines, supplyType);
    const raisedOn = new Date(Math.max(...group.map((o) => o.createdAt.getTime())));
    const owner = company.ownerId ?? pick(sales).id;
    const fy = raisedOn.getMonth() >= 3 ? raisedOn.getFullYear() : raisedOn.getFullYear() - 1;
    const fyLabel = `${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;

    const lineData = group.map((o, i) => ({
      itemId: o.itemId,
      companyProductId: o.id,
      name: o.item.name,
      hsnCode: o.item.hsnCode,
      unit: o.item.unit,
      quantity: new Prisma.Decimal(o.quantity),
      unitPrice: new Prisma.Decimal(Number(o.unitPrice ?? 0)),
      discountMode: "PERCENT" as const,
      discountValue: new Prisma.Decimal(lines[i]!.discountValue ?? 0),
      discountAmount: new Prisma.Decimal(computed.lines[i]!.discountAmount),
      taxRatePercent: new Prisma.Decimal(lines[i]!.taxRatePercent ?? 18),
      taxableValue: new Prisma.Decimal(computed.lines[i]!.taxableValue),
      cgstAmount: new Prisma.Decimal(computed.lines[i]!.cgstAmount),
      sgstAmount: new Prisma.Decimal(computed.lines[i]!.sgstAmount),
      igstAmount: new Prisma.Decimal(computed.lines[i]!.igstAmount),
      lineTotal: new Prisma.Decimal(computed.lines[i]!.lineTotal),
      sortOrder: i,
    }));

    const totals = {
      subtotal: new Prisma.Decimal(computed.subtotal),
      discountTotal: new Prisma.Decimal(computed.discountTotal),
      taxableValue: new Prisma.Decimal(computed.taxableValue),
      cgstAmount: new Prisma.Decimal(computed.cgstAmount),
      sgstAmount: new Prisma.Decimal(computed.sgstAmount),
      igstAmount: new Prisma.Decimal(computed.igstAmount),
      roundOff: new Prisma.Decimal(computed.roundOff),
      total: new Prisma.Decimal(computed.total),
      placeOfSupplyCode: company.stateCode,
      gstTreatment: "REGISTERED_REGULAR" as const,
    };

    // ── The quotation ─────────────────────────────────────────────────────────────────────────
    seq.PROPOSAL += 1;
    const quotedOn = daysAgo(Math.floor((Date.now() - raisedOn.getTime()) / 86400000) + int(7, 30));
    await db.tradeDocument.create({
      data: {
        docNumber: `QT/${fyLabel}/${String(seq.PROPOSAL).padStart(4, "0")}`,
        docType: "PROPOSAL",
          // Typed into the document form, which is what a seeded document stands in for.
          origin: "MANUAL",
        direction: "SALES",
        status: pick(["ACCEPTED", "ACCEPTED", "ACCEPTED", "ISSUED", "EXPIRED"] as const),
        companyId,
        locationId: group[0]!.locationId,
        salespersonId: owner,
        createdById: owner,
        issueDate: quotedOn,
        validUntil: new Date(quotedOn.getTime() + 30 * 86400000),
        createdAt: quotedOn,
        ...totals,
        lines: { create: lineData },
      },
    });
    quotes += 1;

    // ── The invoice ───────────────────────────────────────────────────────────────────────────
    // Not every quotation becomes one — that is the conversion rate the pipeline report measures.
    if (!chance(0.78)) continue;
    seq.INVOICE += 1;
    const status = pick(["PAID", "PAID", "PAID", "PARTIALLY_PAID", "ISSUED", "ISSUED"] as const);
    const invoice = await db.tradeDocument.create({
      data: {
        docNumber: `INV/${fyLabel}/${String(seq.INVOICE).padStart(4, "0")}`,
        docType: "INVOICE",
          // Typed into the document form, which is what a seeded document stands in for.
          origin: "MANUAL",
        direction: "SALES",
        status,
        companyId,
        locationId: group[0]!.locationId,
        salespersonId: owner,
        createdById: pick(accounts).id,
        issueDate: raisedOn,
        dueDate: new Date(raisedOn.getTime() + int(15, 45) * 86400000),
        createdAt: raisedOn,
        ...totals,
        lines: { create: lineData },
      },
      select: { id: true, total: true },
    });
    invoices += 1;

    // ── Allocating the money ──────────────────────────────────────────────────────────────────
    // The receipts already exist against the company; this is what ties them to the invoice, and
    // it is the difference between "₹6 crore received" and "this invoice is settled".
    if (status === "PAID" || status === "PARTIALLY_PAID") {
      const receipts = await db.payment.findMany({
        where: { companyId, direction: "RECEIVED", allocations: { none: {} } },
        select: { id: true, amount: true },
        take: 3,
      });
      let left = Number(invoice.total) * (status === "PAID" ? 1 : 0.4 + rnd() * 0.3);
      for (const receipt of receipts) {
        if (left <= 1) break;
        const amount = Math.min(left, Number(receipt.amount));
        await db.paymentAllocation.create({
          data: {
            paymentId: receipt.id,
            documentId: invoice.id,
            amount: new Prisma.Decimal(Math.round(amount * 100) / 100),
            allocatedByUserId: pick(accounts).id,
          },
        });
        left -= amount;
        allocations += 1;
      }
      if (left > 1) outstanding += left;
    } else {
      outstanding += Number(invoice.total);
    }

    /**
     * ── The other four kinds of document ──────────────────────────────────────────────────────
     *
     * A proforma where the customer paid in advance, the purchase order and vendor bill behind
     * what was sold, and a delivery challan for goods that physically moved. All four are built
     * from the same computed totals as the invoice above, so the tax on them reconciles the same
     * way — and all four exist so the screens that show them have something to show.
     */

    // A minority of customers pay up front, and those get a proforma before the invoice.
    if (chance(0.22)) {
      seq.PROFORMA += 1;
      const proformaOn = daysAgo(Math.floor((Date.now() - raisedOn.getTime()) / 86400000) + int(2, 10));
      await db.tradeDocument.create({
        data: {
          docNumber: `PI/${fyLabel}/${String(seq.PROFORMA).padStart(4, "0")}`,
          docType: "PROFORMA",
          // Typed into the document form, which is what a seeded document stands in for.
          origin: "MANUAL",
          direction: "SALES",
          status: pick(["ISSUED", "ISSUED", "ACCEPTED"] as const),
          companyId,
          locationId: group[0]!.locationId,
          salespersonId: owner,
          createdById: pick(accounts).id,
          issueDate: proformaOn,
          createdAt: proformaOn,
          ...totals,
          lines: { create: lineData },
        },
      });
      proformas += 1;
    }

    // What we bought to fulfil it, and the vendor's invoice for it.
    if (vendors.length > 0 && chance(0.55)) {
      const vendor = pick(vendors);
      const orderedOn = daysAgo(Math.floor((Date.now() - raisedOn.getTime()) / 86400000) + int(3, 14));
      seq.PURCHASE_ORDER += 1;
      const po = await db.tradeDocument.create({
        data: {
          docNumber: `PO/${fyLabel}/${String(seq.PURCHASE_ORDER).padStart(4, "0")}`,
          docType: "PURCHASE_ORDER",
          // Typed into the document form, which is what a seeded document stands in for.
          origin: "MANUAL",
          direction: "PURCHASE",
          status: pick(["ACCEPTED", "ACCEPTED", "ISSUED"] as const),
          companyId: vendor.id,
          locationId: vendor.locationId,
          createdById: pick(purchasers).id,
          issueDate: orderedOn,
          createdAt: orderedOn,
          ...totals,
          placeOfSupplyCode: vendor.stateCode,
          lines: { create: lineData },
        },
        select: { id: true },
      });
      purchases += 1;

      // Most purchase orders come back as a bill. The ones that have not yet are what the
      // purchase team is chasing, which is the whole point of that screen.
      if (chance(0.72)) {
        seq.BILL += 1;
        const billedOn = daysAgo(Math.floor((Date.now() - orderedOn.getTime()) / 86400000) - int(1, 8));
        await db.tradeDocument.create({
          data: {
            docNumber: `BILL/${fyLabel}/${String(seq.BILL).padStart(4, "0")}`,
            docType: "BILL",
            origin: "CONVERSION",
            direction: "PURCHASE",
            status: pick(["PAID", "PAID", "ISSUED"] as const),
            companyId: vendor.id,
            locationId: vendor.locationId,
            createdById: pick(accounts).id,
            issueDate: billedOn,
            dueDate: new Date(billedOn.getTime() + int(15, 45) * 86400000),
            createdAt: billedOn,
            sourceDocumentId: po.id,
            ...totals,
            placeOfSupplyCode: vendor.stateCode,
            lines: { create: lineData },
          },
        });
      }
    }

    // Goods that physically moved get a challan. Services do not — nothing travels.
    const hasGoods = group.some((o) => o.item.type === "GOOD");
    if (hasGoods && chance(0.4)) {
      seq.DELIVERY_CHALLAN += 1;
      await db.tradeDocument.create({
        data: {
          docNumber: `DC/${fyLabel}/${String(seq.DELIVERY_CHALLAN).padStart(4, "0")}`,
          docType: "DELIVERY_CHALLAN",
          // Typed into the document form, which is what a seeded document stands in for.
          origin: "MANUAL",
          direction: "SALES",
          status: "ISSUED",
          companyId,
          locationId: group[0]!.locationId,
          createdById: pick(accounts).id,
          issueDate: raisedOn,
          createdAt: raisedOn,
          ...totals,
          lines: { create: lineData },
        },
      });
      challans += 1;
    }
  }

  log("Quotations", `${quotes}`);
  log("Proformas", `${proformas} — customers who paid in advance`);
  log("Purchase side", `${purchases} orders to vendors, and the bills against them`);
  log("Delivery challans", `${challans} — goods that physically moved`);
  log("Invoices", `${invoices} with ${allocations} receipts allocated`);
  log("Outstanding", `₹${(outstanding / 10000000).toFixed(2)} crore unsettled`);

  // ── Stock movements ─────────────────────────────────────────────────────────────────────────
  // Goods that were sold have to have left the shelf, or the stock figure is fiction.
  const goods = items.filter((i) => i.type === "GOOD");
  let movements = 0;
  for (const item of goods) {
    const admin = pick(people).id;
    // An opening receipt, then the issues that correspond to what was sold.
    await db.stockMovement.create({
      data: { itemId: item.id, type: "RECEIVED", quantityChange: int(20, 80), reason: "Opening stock", createdByUserId: admin, createdAt: daysAgo(400) },
    });
    movements += 1;
    for (const _ of some([1, 2, 3, 4, 5], int(1, 4))) {
      await db.stockMovement.create({
        data: {
          itemId: item.id,
          type: pick(["SOLD", "SOLD", "SOLD", "DAMAGED", "RETURNED"] as const),
          quantityChange: -int(1, 6),
          reason: pick(["Dispatched to customer", "Delivery challan", "Replacement under warranty"]),
          createdByUserId: admin,
          createdAt: daysAgo(int(1, 360)),
        },
      });
      movements += 1;
      void _;
    }
  }
  log("Stock movements", `${movements} across ${goods.length} tracked items`);
}
