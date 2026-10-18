import { getOrder, listOrdersPaged } from "@/actions/order";
import { getTradeDocument, listTradeDocuments } from "@/actions/trade-document";
import { ApiError, notFound, pageOf, paging, type ApiAnswer, type ApiCall } from "@/lib/api/handler";
import { needModule } from "@/lib/api/v1/shared";
import { amount, companyRef, day, idOf, iso, orderRef, plainId } from "@/lib/api/refs";
import { API_DEFAULT_PAGE_SIZE, API_MAX_PAGE_SIZE } from "@/lib/api/scopes";

/**
 * Orders and invoices in the public API (src/lib/api) — read only, through the app's own reads as the
 * key's person: "View orders" and "View documents", and the accounts they reach. What we pay a vendor
 * for an order — its purchase price, its vendor, the quotes — is never in it.
 */

type Row = Record<string, unknown> & { id: string };
const str = (v: unknown) => (typeof v === "string" ? v : null);
const rec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);

const ORDER_STATUSES = ["PENDING_APPROVAL", "APPROVED", "REJECTED", "PROCESSING", "FULFILLED", "CANCELLED", "NOT_STARTED", "TASK_RAISED", "CONTACTED"] as const;

function orderOut(row: Row) {
  const company = rec(row.company);
  const item = rec(row.item);
  const endCustomer = rec(row.endCustomer);
  return {
    id: row.id,
    ref: orderRef(row.orderSeq as number),
    status: row.orderStatus ?? null,
    business_type: row.businessType ?? null,
    company: company ? { id: company.id, ref: companyRef(company.companySeq as number), name: company.name } : null,
    end_customer: endCustomer ? { id: endCustomer.id, name: endCustomer.name } : null,
    item: item ? { id: item.id, name: item.name, sku: item.sku ?? null } : null,
    quantity: typeof row.quantity === "number" ? row.quantity : null,
    unit_price: amount(row.unitPrice),
    po_number: str(row.poNumber),
    start_date: day(row.startDate as Date | null),
    end_date: day(row.endDate as Date | null),
    booked_at: iso(row.bookedAt as Date | null),
    fulfilled_at: iso(row.fulfilledAt as Date | null),
    created_at: iso(row.createdAt as Date | string),
  };
}

export async function listOrdersApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("orders", call.actor.userId, "Orders");
  const q = call.url.searchParams;
  const { page, pageSize } = paging(call.url, API_MAX_PAGE_SIZE, API_DEFAULT_PAGE_SIZE);
  const status = q.get("status")?.toUpperCase();
  if (status && !(ORDER_STATUSES as readonly string[]).includes(status)) throw new ApiError(400, "invalid_request", `status is one of ${ORDER_STATUSES.join(", ")}.`);
  const company = q.get("company");
  const { rows, total } = await listOrdersPaged({
    page,
    pageSize,
    status: status as Parameters<typeof listOrdersPaged>[0]["status"],
    search: q.get("search")?.slice(0, 100) || undefined,
    companyId: company ? ((await idOf("company", company)) ?? "zz-nothing") : undefined,
  });
  return { data: (rows as unknown as Row[]).map(orderOut), page: pageOf(page, pageSize, total) };
}

export async function getOrderApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("orders", call.actor.userId, "Orders");
  const id = await idOf("order", call.params.ref);
  if (!id) throw notFound("order");
  const order = (await getOrder(id)) as Row | null;
  if (!order) throw notFound("order");
  return { data: orderOut(order) };
}

function invoiceOut(row: Row) {
  const company = rec(row.company);
  const salesperson = rec(row.salesperson);
  return {
    id: row.id,
    number: row.docNumber,
    status: row.status,
    issue_date: day(row.issueDate as Date | null),
    due_date: day(row.dueDate as Date | null),
    currency: row.currency ?? "INR",
    company: company ? { id: company.id, ref: companyRef(company.companySeq as number), name: company.name } : null,
    salesperson: salesperson ? { id: salesperson.id, name: salesperson.name } : null,
    reference: str(row.reference),
    irn: str(row.irn),
    einvoice_status: row.einvoiceStatus ?? null,
    ...("subtotal" in row ? { subtotal: amount(row.subtotal), taxable_value: amount(row.taxableValue), cgst: amount(row.cgstAmount), sgst: amount(row.sgstAmount), igst: amount(row.igstAmount), round_off: amount(row.roundOff) } : {}),
    total: amount(row.total),
    ...(Array.isArray(row.lines)
      ? {
          lines: (row.lines as Row[]).map((l) => ({
            name: l.name,
            description: str(l.description),
            hsn_sac: str(l.hsnCode),
            quantity: amount(l.quantity),
            unit: str(l.unit),
            unit_price: amount(l.unitPrice),
            discount: amount(l.discountAmount),
            tax_rate_percent: amount(l.taxRatePercent),
            taxable_value: amount(l.taxableValue),
            service_period: l.servicePeriodFrom || l.servicePeriodTo ? { from: day(l.servicePeriodFrom as Date | null), to: day(l.servicePeriodTo as Date | null) } : null,
          })),
        }
      : {}),
    created_at: iso(row.createdAt as Date | string | null),
  };
}

export async function listInvoicesApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("sales_documents", call.actor.userId, "Sales documents");
  const q = call.url.searchParams;
  const { page, pageSize } = paging(call.url, API_MAX_PAGE_SIZE, API_DEFAULT_PAGE_SIZE);
  const status = q.get("status")?.toUpperCase();
  const statuses = ["DRAFT", "ISSUED", "ACCEPTED", "REJECTED", "PARTIALLY_PAID", "PAID", "CANCELLED", "EXPIRED"] as const;
  if (status && !(statuses as readonly string[]).includes(status)) throw new ApiError(400, "invalid_request", `status is one of ${statuses.join(", ")}.`);
  const from = q.get("from");
  const to = q.get("to");
  for (const [name, value] of [["from", from], ["to", to]] as const) if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError(400, "invalid_request", `${name} is a date, yyyy-mm-dd.`);
  const { rows, total } = await listTradeDocuments({
    docType: "INVOICE",
    status: status as (typeof statuses)[number] | undefined,
    search: q.get("search")?.slice(0, 100) || undefined,
    from: from || undefined,
    to: to || undefined,
    page,
    pageSize,
  });
  return { data: (rows as unknown as Row[]).map(invoiceOut), page: pageOf(page, pageSize, total) };
}

export async function getInvoiceApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("sales_documents", call.actor.userId, "Sales documents");
  const id = plainId(call.params.id);
  if (!id) throw notFound("invoice");
  const doc = (await getTradeDocument(id)) as Row | null;
  if (!doc || doc.docType !== "INVOICE") throw notFound("invoice");
  return { data: invoiceOut(doc) };
}
