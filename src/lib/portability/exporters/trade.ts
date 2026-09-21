import { db } from "@/lib/db";
import { viaCompany, type Exporter } from "./types";

/**
 * The catalog, and the records of what was sold and paid for.
 *
 * Orders, renewals and payments export but never import — each is the output of a process that also
 * wrote ledger entries, stock movements and audit rows. See areas.ts for the reasoning; it is stated
 * to the user on the screen rather than only here.
 */

/** The catalog belongs to the business rather than to an account, so it is not company-scoped. */
export const itemsExporter: Exporter = async () => {
  const rows = await db.item.findMany({
    include: { brand: { select: { name: true } }, productFamily: { select: { name: true } } },
    orderBy: { itemSeq: "asc" },
  });
  return rows.map((i) => ({
    Key: `ITM-${String(i.itemSeq).padStart(6, "0")}`,
    Name: i.name,
    SKU: i.sku ?? "",
    Type: i.type,
    Brand: i.brand?.name ?? "",
    Family: i.productFamily?.name ?? "",
    "Billing cycle": i.billingCycle ?? "",
    Unit: i.unit ?? "",
    Price: i.sellingPrice ? Number(i.sellingPrice) : null,
    "Tax %": i.taxRatePercent ? Number(i.taxRatePercent) : null,
  }));
};

function orderExporter(renewalsOnly: boolean): Exporter {
  return async (scope) => {
    const rows = await db.companyProduct.findMany({
      // A renewal is a subscription with an end date, and only a parent — a mid-term addition
      // co-terminates with its parent and is not separately renewable.
      where: { ...viaCompany(scope), ...(renewalsOnly ? { endDate: { not: null }, parentId: null } : {}) },
      include: {
        company: { select: { name: true } },
        item: { select: { name: true } },
        vendor: { select: { name: true } },
      },
      orderBy: { orderSeq: "asc" },
    });
    return rows.map((o) => ({
      Order: `ORD-${String(o.orderSeq).padStart(6, "0")}`,
      Company: o.company.name,
      Item: o.item.name,
      Quantity: o.quantity,
      "Unit price": o.unitPrice ? Number(o.unitPrice) : null,
      "Full-term price": o.fullTermUnitPrice ? Number(o.fullTermUnitPrice) : null,
      Status: o.orderStatus,
      Type: o.businessType,
      Vendor: o.vendor?.name ?? "",
      Starts: o.startDate,
      Expires: o.endDate,
    }));
  };
}

export const ordersExporter = orderExporter(false);
export const renewalsExporter = orderExporter(true);

export const paymentsExporter: Exporter = async (scope) => {
  const rows = await db.payment.findMany({
    where: viaCompany(scope),
    include: { company: { select: { name: true } } },
    orderBy: { paymentSeq: "asc" },
  });
  return rows.map((p) => ({
    Payment: `PAY-${String(p.paymentSeq).padStart(6, "0")}`,
    Company: p.company?.name ?? "",
    Amount: Number(p.amount),
    "Paid on": p.paidOn,
    Method: p.method,
    Reference: p.reference ?? "",
  }));
};
