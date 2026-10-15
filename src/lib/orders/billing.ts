import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  BILLED_STATUSES,
  INVOICEABLE_ORDER_STATUSES,
  billingStatusOf,
  type BilledDocument,
  type OrderBilling,
} from "@/lib/orders/billing-rules";

/**
 * What each order has been invoiced, from the tax invoice lines that bill it (src/lib/orders/billing-rules.ts
 * says what counts). Server only.
 *
 * `excludeDocumentId` leaves one document out — the draft being edited, so its own lines don't read as
 * a second invoice of the order they bill.
 */
export async function orderBilling(orderIds: string[], opts: { excludeDocumentId?: string } = {}): Promise<Map<string, OrderBilling>> {
  const ids = [...new Set(orderIds.filter(Boolean))];
  const out = new Map<string, OrderBilling>();
  if (ids.length === 0) return out;
  const [orders, lines] = await Promise.all([
    db.companyProduct.findMany({ where: { id: { in: ids } }, select: { id: true, quantity: true, recurringBilling: { select: { mode: true } } } }),
    db.tradeDocumentLine.findMany({
      where: {
        companyProductId: { in: ids },
        document: {
          docType: { in: ["INVOICE", "CREDIT_NOTE"] },
          status: { notIn: ["CANCELLED", "REJECTED", "EXPIRED"] },
          ...(opts.excludeDocumentId ? { id: { not: opts.excludeDocumentId } } : {}),
        },
      },
      select: { id: true, companyProductId: true, quantity: true, document: { select: { id: true, docNumber: true, docType: true, status: true, issueDate: true } } },
      orderBy: { document: { issueDate: "asc" } },
    }),
  ]);
  for (const o of orders) {
    const mine = lines.filter((l) => l.companyProductId === o.id);
    const view = (l: (typeof mine)[number]): BilledDocument => ({
      documentId: l.document.id,
      docNumber: l.document.docNumber,
      docType: l.document.docType as BilledDocument["docType"],
      status: l.document.status,
      quantity: Number(l.quantity),
      lineId: l.id,
    });
    const invoices = mine.filter((l) => l.document.docType === "INVOICE" && (BILLED_STATUSES as readonly string[]).includes(l.document.status)).map(view);
    const drafts = mine.filter((l) => l.document.docType === "INVOICE" && l.document.status === "DRAFT").map(view);
    const creditNotes = mine.filter((l) => l.document.docType === "CREDIT_NOTE" && l.document.status !== "DRAFT").map(view);
    const invoiced = Math.round(invoices.reduce((t, i) => t + i.quantity, 0) * 1000) / 1000;
    const instalments = o.recurringBilling?.mode === "INSTALMENTS";
    out.set(o.id, {
      orderId: o.id,
      ordered: o.quantity,
      invoiced,
      remaining: Math.max(0, Math.round((o.quantity - invoiced) * 1000) / 1000),
      status: billingStatusOf(o.quantity, invoiced, instalments),
      invoices,
      drafts,
      creditNotes,
    });
  }
  return out;
}

/**
 * The orders still to invoice, as a filter: sold (approved onwards), not billed in instalments, and
 * with less invoiced than ordered. One query for the ids — the sum over invoice lines is a join
 * Prisma's filters can't express — then a plain `id in` the list's own scope narrows further.
 */
export async function toInvoiceWhere(): Promise<Prisma.CompanyProductWhereInput> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    select cp.id
    from company_products cp
    left join recurring_billings rb on rb."companyProductId" = cp.id and rb.mode::text = 'INSTALMENTS'
    left join (
      select l."companyProductId" as id, sum(l.quantity) as billed
      from trade_document_lines l
      join trade_documents d on d.id = l."documentId"
      where d."docType"::text = 'INVOICE'
        and d.status::text in (${Prisma.join([...BILLED_STATUSES])})
        and l."companyProductId" is not null
      group by l."companyProductId"
    ) b on b.id = cp.id
    where rb."companyProductId" is null
      and cp."orderStatus"::text in (${Prisma.join([...INVOICEABLE_ORDER_STATUSES])})
      and cp.quantity > coalesce(b.billed, 0)`;
  return { id: { in: rows.map((r) => r.id) } };
}

/** The customer's other orders on the same PO — the ones that go on one invoice with it. Blank POs group nothing. */
export async function ordersOnSamePo(order: { id: string; companyId: string; poNumber: string | null }): Promise<string[]> {
  const po = order.poNumber?.trim();
  if (!po) return [];
  const rows = await db.companyProduct.findMany({
    where: {
      companyId: order.companyId,
      id: { not: order.id },
      poNumber: { equals: po, mode: "insensitive" },
      orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
    },
    select: { id: true },
    orderBy: { orderSeq: "asc" },
  });
  return rows.map((r) => r.id);
}
