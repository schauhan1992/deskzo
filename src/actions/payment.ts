"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { syncInvoiceStatus } from "@/lib/receivables/sync";
import { reverseAllocationExchange, reversePaymentPosting } from "@/lib/ledger/journal";
import { bookingRate, takenFromPayment } from "@/lib/ledger/posting";
import { isBaseCurrency } from "@/lib/currency";
import { requireModuleUser } from "@/lib/modules-access";
import { bookOnFirstPayment } from "@/lib/orders/handoff";
import {
  canSeeCompany,
  paymentScope,
  viaCompanyScope,
} from "@/lib/authz/company-scope";
import { toPlain } from "@/lib/serialize";
import { pageOf } from "@/lib/pagination";
import { hasEffectivePermission, viewerHas } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { postPaymentToLedger } from "@/lib/ledger/journal";
import { calculateOrderAmount } from "@/lib/gst";
import { defaultBranchIdFor } from "@/lib/branches/identity";
import {
  recordPaymentSchema,
  allocatePaymentSchema,
} from "@/lib/validation/payment";
import type { ActionResult } from "@/actions/company";

const orderItemSelect = {
  id: true,
  name: true,
  sku: true,
  unit: true,
  sellingPrice: true,
  taxRatePercent: true,
} as const;

function computeOrderFinancials(order: {
  quantity: number;
  unitPrice?: unknown;
  item: { sellingPrice: unknown; taxRatePercent: unknown };
  allocations: { amount: unknown }[];
}) {
  const { subtotal, gstAmount, total } = calculateOrderAmount({
    quantity: order.quantity,
    // A punched order's own negotiated price wins over the item's catalog default, if one was set.
    unitPrice: Number(order.unitPrice ?? order.item.sellingPrice),
    taxRatePercent: order.item.taxRatePercent
      ? Number(order.item.taxRatePercent)
      : null,
  });
  const paid = order.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
  const balance = Math.round((total - paid) * 100) / 100;
  const status: PaymentStatusFilter =
    paid <= 0 ? "unpaid" : paid < total ? "partial" : "paid";
  return { subtotal, gstAmount, total, paid, balance, status };
}

/**
 * Whether the caller may see one company's money at all.
 *
 * The per-company reads below are handed a company id, so an account-scope *filter* would be very
 * nearly a no-op — the caller has already named the company, and the only question left is yes or
 * no. They ask it here and refuse with an empty result, because these are server actions a browser
 * can call directly and a company id is not a secret.
 */
async function canSeeCompanyMoney(userId: string, companyId: string) {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { ownerUserId: true },
  });
  if (!company) return false;
  return canSeeCompany(userId, company.ownerUserId);
}

export async function recordPayment(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("payments");
  if (!(await hasEffectivePermission(user.id, "payments.record"))) {
    return {
      ok: false,
      error: "You don't have permission to record payments.",
    };
  }
  const parsed = recordPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const {
    companyId,
    amount,
    paidOn,
    method,
    reference,
    notes,
    allocateToOrderId,
  } = parsed.data;

  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) {
    return { ok: false, error: "Company not found." };
  }

  let order = null;
  if (allocateToOrderId) {
    order = await db.companyProduct.findUnique({
      where: { id: allocateToOrderId },
    });
    if (!order || order.companyId !== companyId) {
      return {
        ok: false,
        error: "That order does not belong to the selected company.",
      };
    }
    // Its payments were moved on account when it was cancelled; new money doesn't land on it either.
    if (order.orderStatus === "CANCELLED") {
      return { ok: false, error: "That order is cancelled — record the payment on account instead." };
    }
  }

  // An order payment names no document, so it is the recorder's branch (spec §5.7) — resolved before
  // the transaction, since the head office fallback uses its own connection.
  const branchId = await defaultBranchIdFor(user.id);

  const payment = await db.$transaction(async (tx) => {
    const created = await tx.payment.create({
      data: {
        companyId,
        branchId,
        amount,
        paidOn: new Date(paidOn),
        method,
        reference: reference || null,
        notes: notes || null,
        recordedByUserId: user.id,
        ...(order
          ? {
              allocations: {
                create: [
                  {
                    companyProductId: order.id,
                    amount,
                    allocatedByUserId: user.id,
                  },
                ],
              },
            }
          : {}),
      },
    });
    await postPaymentToLedger(tx, created.id, user.id);
    // An in-hand order counts as booked from its first payment (O-D2).
    if (order) await bookOnFirstPayment(tx, { id: order.id }, new Date());
    return created;
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Payment",
    entityId: payment.id,
    entityLabel: `Payment of ₹${amount} — ${company.name}`,
  });

  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/payments");
  return { ok: true, data: { id: payment.id } };
}

export async function allocatePayment(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("payments");
  if (!(await hasEffectivePermission(user.id, "payments.record"))) {
    return {
      ok: false,
      error: "You don't have permission to allocate payments.",
    };
  }
  const parsed = allocatePaymentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { paymentId, companyProductId, amount } = parsed.data;

  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: { allocations: true },
  });
  if (!payment) {
    return { ok: false, error: "Payment not found." };
  }
  // An order is priced in rupees. A receipt taken in a foreign invoice's currency (and freed again
  // when its allocation was removed) would be set against it dollar for rupee.
  if (!isBaseCurrency(payment.currency)) {
    return {
      ok: false,
      error: `This payment is in ${payment.currency}; an order is in rupees. Apply it to a ${payment.currency} invoice instead.`,
    };
  }

  const order = await db.companyProduct.findUnique({
    where: { id: companyProductId },
    include: {
      item: { select: orderItemSelect },
      allocations: { select: { amount: true } },
    },
  });
  if (!order || order.companyId !== payment.companyId) {
    return {
      ok: false,
      error: "That order does not belong to this payment's company.",
    };
  }
  if (order.orderStatus === "CANCELLED") {
    return { ok: false, error: "That order is cancelled — apply the money to another order, or refund it." };
  }

  // What each earlier allocation took out of this payment — an allocation across currencies records
  // the rupees separately from the figure it settled (`takenFromPayment`).
  const alreadyAllocated = payment.allocations.reduce(
    (sum, a) => sum + takenFromPayment(a),
    0,
  );
  const remaining =
    Math.round((Number(payment.amount) - alreadyAllocated) * 100) / 100;
  if (amount > remaining) {
    return {
      ok: false,
      error: `Only ${remaining.toFixed(2)} is unallocated on this payment.`,
    };
  }

  // The order has a ceiling of its own. Without this an allocation is only checked against the
  // payment, so a large payment can be dumped onto a small order — which reads back as an order
  // that's been paid many times over and a customer whose outstanding balance has gone negative.
  const orderBalance = computeOrderFinancials(order).balance;
  if (amount > orderBalance) {
    return {
      ok: false,
      error:
        orderBalance <= 0
          ? "That order is already fully paid."
          : `Only ${orderBalance.toFixed(2)} is still outstanding on that order.`,
    };
  }

  const allocation = await db.$transaction(async (tx) => {
    const row = await tx.paymentAllocation.create({
      data: { paymentId, companyProductId, amount, allocatedByUserId: user.id },
    });
    // An in-hand order counts as booked from its first payment (O-D2).
    await bookOnFirstPayment(tx, { id: companyProductId }, new Date());
    return row;
  });

  revalidatePath(`/companies/${payment.companyId}`);
  revalidatePath("/payments");
  return { ok: true, data: { id: allocation.id } };
}

export async function deleteAllocation(
  id: string,
): Promise<ActionResult<null>> {
  const user = await requireModuleUser("payments");
  if (!(await hasEffectivePermission(user.id, "payments.delete"))) {
    return {
      ok: false,
      error: "You don't have permission to delete allocations.",
    };
  }
  const allocation = await db.paymentAllocation.findUnique({
    where: { id },
    include: { payment: { select: { companyId: true } } },
  });
  if (!allocation) {
    return { ok: false, error: "Allocation not found." };
  }

  /**
   * An allocation to an invoice or a bill is more than a row. Setting a foreign receipt against a
   * document raised at another rate booked an exchange difference, and the document's status is a
   * cache of its allocations — so removing one used to leave the gain in the P&L and the invoice
   * reading PAID. The difference is reversed in the same transaction as the row goes; the payment's
   * own entry stays, because the money was still received — it is simply on account again.
   */
  await db.$transaction(async (tx) => {
    await reverseAllocationExchange(tx, id, user.id);
    await tx.paymentAllocation.delete({ where: { id } });
  });
  if (allocation.documentId) await syncInvoiceStatus(allocation.documentId);

  revalidatePath(`/companies/${allocation.payment.companyId}`);
  revalidatePath("/payments");
  if (allocation.documentId) {
    revalidatePath(`/documents/${allocation.documentId}`);
    revalidatePath("/receivables");
    revalidatePath("/payables");
  }
  return { ok: true, data: null };
}

/**
 * Deletes one payment the way the books need it deleted. Three things, and once only the first.
 *
 * The row went, and its ledger entries stayed posted with a dangling `paymentId` — bank overstated,
 * receivables understated, for good — while the invoice it had settled kept its PAID status and
 * quietly stopped being chased. A deletion that leaves the books wrong and the customer unchased is
 * worse than a refusal. So: every live entry of the payment's is reversed (the receipt, its cheque
 * clearing, the exchange difference on each allocation — `reversePaymentPosting`), in the same
 * transaction as the row goes; then each document it settled has its status derived again.
 *
 * Module-private: a "use server" file publishes only what it exports.
 */
async function removePayment(id: string, userId: string, allocations: { documentId: string | null }[]) {
  await db.$transaction(async (tx) => {
    await reversePaymentPosting(tx, id, userId);
    await tx.payment.delete({ where: { id } });
  });

  const documentIds = [...new Set(allocations.map((a) => a.documentId).filter((x): x is string => !!x))];
  for (const documentId of documentIds) {
    await syncInvoiceStatus(documentId);
  }
  return documentIds;
}

export async function deletePayment(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("payments");
  if (!(await hasEffectivePermission(user.id, "payments.delete"))) {
    return {
      ok: false,
      error: "You don't have permission to delete payments.",
    };
  }
  const payment = await db.payment.findUnique({
    where: { id },
    select: {
      companyId: true,
      amount: true,
      currency: true,
      paymentSeq: true,
      // The invoices this payment was settling. Their status is a cache of their allocations, so
      // removing the allocations without re-deriving it leaves an unpaid invoice reading PAID —
      // which drops it out of the ageing report and off every chase list in the app.
      allocations: { select: { documentId: true } },
    },
  });
  if (!payment) {
    return { ok: false, error: "Payment not found." };
  }

  await removePayment(id, user.id, payment.allocations);

  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "Payment",
    entityId: id,
    entityLabel: `Deleted payment #${payment.paymentSeq} of ${isBaseCurrency(payment.currency) ? "" : `${payment.currency} `}${payment.amount}`,
  });

  revalidatePath(`/companies/${payment.companyId}`);
  revalidatePath("/payments");
  revalidatePath("/receivables");
  revalidatePath("/payables");
  return { ok: true, data: null };
}

export type PaymentStatusFilter = "unpaid" | "partial" | "paid";

/**
 * The three numbers the home screen shows, without hydrating the order book to get them.
 *
 * `listOrdersWithPayments` returns every order with every allocation, each allocation's payment and
 * the user who made it — and the dashboard used it to compute an outstanding total and two counts,
 * then threw all of it away. On a reseller with 400 customers that is ~5,000 orders and ~8,000
 * allocations hydrated per page view, by every member of staff, every time they open the app; at
 * three or four years of trading it stops rendering inside a request.
 *
 * This selects the four fields the arithmetic actually needs and nothing else. It deliberately
 * still runs the totals through `computeOrderFinancials` rather than reproducing the GST rounding
 * in SQL: two implementations of the same money calculation is how they come to disagree, and a
 * dashboard that disagrees with the payments screen is worse than a slow one.
 *
 * Still linear in the number of orders. If that becomes the problem, the next step is a stored
 * total on CompanyProduct maintained by the same helper — not a second copy of the arithmetic.
 */
export async function paymentsSnapshot() {
  const user = await requireModuleUser("payments");
  if (!(await viewerHas("payments.view"))) return { outstandingBalance: 0, unpaidCount: 0, partialCount: 0 };

  const orders = await db.companyProduct.findMany({
    /**
     * Scoped, like the quotation and receivable tiles beside it on the same screen.
     *
     * A tile is a summary rather than a list, which is exactly why it was missed: nothing here
     * renders a customer's name, so the leak reads as "one big number" — and that one number is
     * the whole business's outstanding receivable shown to an executive who manages a dozen
     * accounts. An order reaches its account through its own company, one hop.
     */
    where: { ...(await viaCompanyScope(user.id)) },
    select: {
      quantity: true,
      unitPrice: true,
      item: { select: { sellingPrice: true, taxRatePercent: true } },
      allocations: { select: { amount: true } },
    },
  });

  let outstandingBalance = 0;
  let unpaidCount = 0;
  let partialCount = 0;

  for (const order of orders) {
    const financials = computeOrderFinancials(order);
    if (financials.status === "unpaid") unpaidCount += 1;
    else if (financials.status === "partial") partialCount += 1;
    if (financials.balance > 0) outstandingBalance += financials.balance;
  }

  return { outstandingBalance, unpaidCount, partialCount };
}

export async function listOrdersWithPayments(params?: {
  search?: string;
  status?: PaymentStatusFilter;
}) {
  const user = await requireModuleUser("payments");
  if (!(await viewerHas("payments.view"))) return [];

  const orders = await db.companyProduct.findMany({
    where: {
      /**
       * The scope and the search both narrow through `company`, so they go in as two `AND` terms
       * rather than two spreads into the same object — spreading would keep whichever `company`
       * key was written last and silently drop the other, and the one dropped would be the scope.
       */
      AND: [
        await viaCompanyScope(user.id),
        ...(params?.search
          ? [
              {
                company: {
                  name: { contains: params.search, mode: "insensitive" as const },
                },
              },
            ]
          : []),
      ],
    },
    include: {
      company: { select: { id: true, name: true } },
      item: { select: orderItemSelect },
      allocations: {
        orderBy: { createdAt: "desc" },
        include: {
          allocatedBy: { select: { id: true, name: true } },
          payment: {
            select: { id: true, paidOn: true, method: true, reference: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const withTotals = toPlain(
    orders.map((order) => ({ ...order, ...computeOrderFinancials(order) })),
  );

  if (!params?.status) return withTotals;
  return withTotals.filter((o) => o.status === params.status);
}

/** A company's orders with their financials, for the "select an order to allocate against" step. */
export async function listCompanyOrdersForPayment(companyId: string) {
  const user = await requireModuleUser("payments");
  if (!(await viewerHas("payments.view"))) return [];
  // What each order is worth and how much of it is still owed — the account's commercials, for a
  // company this person may not manage. No orders rather than a refusal, so the dialog that calls
  // this just has nothing to allocate against.
  if (!(await canSeeCompanyMoney(user.id, companyId))) return [];

  const orders = await db.companyProduct.findMany({
    where: { companyId },
    include: {
      item: { select: orderItemSelect },
      allocations: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return toPlain(
    orders.map((order) => ({ ...order, ...computeOrderFinancials(order) })),
  );
}

/** Every payment received, with how much of it is still unallocated — for the "Payments received" list. */
export async function listPayments(params?: {
  search?: string;
  unallocatedOnly?: boolean;
}) {
  const user = await requireModuleUser("payments");
  if (!(await viewerHas("payments.view"))) return [];

  const payments = await db.payment.findMany({
    /**
     * Received only.
     *
     * A vendor payment is money going the other way, and this listed and summed the two together —
     * so what the company had *spent* was reported as part of what it had collected, on the screen
     * whose whole job is to say how much has come in.
     */
    where: {
      direction: "RECEIVED",
      /**
       * `paymentScope` rather than a hand-written clause: a receipt reaches its account through
       * its own `companyId` — which is set even on a lump sum that has not been allocated to any
       * order yet, and those are precisely the rows an account manager is chasing.
       *
       * As an `AND` term because the search narrows through `company` too; two spreads into one
       * object would leave only the last `company` key standing.
       */
      AND: [
        await paymentScope(user.id),
        ...(params?.search ? [{ company: { name: { contains: params.search, mode: "insensitive" as const } } }] : []),
      ],
    },
    include: {
      company: { select: { id: true, name: true } },
      recordedBy: { select: { id: true, name: true } },
      allocations: {
        include: {
          companyProduct: {
            select: {
              id: true,
              orderSeq: true,
              item: { select: { name: true } },
            },
          },
          document: { select: { id: true, docNumber: true, currency: true } },
        },
      },
    },
    orderBy: { paidOn: "desc" },
  });

  const withRemaining = toPlain(payments).map((payment) => {
    // In the payment's own currency: an allocation across currencies (rupees on account set against a
    // USD invoice) settles dollars but takes rupees, and it is the rupees that leave this payment.
    const allocated = payment.allocations.reduce(
      (sum, a) => sum + takenFromPayment(a),
      0,
    );
    const unallocated =
      Math.round((Number(payment.amount) - allocated) * 100) / 100;
    return { ...payment, allocated, unallocated };
  });

  if (!params?.unallocatedOnly) return withRemaining;
  return withRemaining.filter((p) => p.unallocated > 0);
}

/**
 * The money side of one company's 360 view: every payment they've sent us, what each one was
 * allocated against, and what's still sitting unallocated. Until now a payment was only reachable
 * through the order it paid for, so a payment covering several orders — or none yet — was
 * effectively invisible from the customer's own page.
 */
export async function listCompanyPayments(companyId: string) {
  const user = await requireModuleUser("payments");
  if (!(await viewerHas("payments.view"))) return [];
  if (!(await canSeeCompanyMoney(user.id, companyId))) return [];

  const payments = await db.payment.findMany({
    // Received only: a vendor payment is money going the other way.
    where: { companyId, direction: "RECEIVED" },
    orderBy: { paidOn: "desc" },
    include: {
      recordedBy: { select: { id: true, name: true } },
      allocations: {
        include: {
          companyProduct: {
            select: {
              id: true,
              orderSeq: true,
              item: { select: { name: true } },
            },
          },
          document: { select: { id: true, docNumber: true, currency: true } },
        },
      },
    },
  });

  return toPlain(payments).map((payment) => {
    // In the payment's own currency, as `listPayments` counts it.
    const allocated = payment.allocations.reduce(
      (sum, a) => sum + takenFromPayment(a),
      0,
    );
    return {
      ...payment,
      allocated,
      unallocated: Math.round((Number(payment.amount) - allocated) * 100) / 100,
    };
  });
}

/** Billed / received / outstanding for one company, across every order on its account. */
export async function companyPaymentSummary(companyId: string) {
  const user = await requireModuleUser("payments");
  if (!(await viewerHas("payments.view"))) return { billed: 0, received: 0, outstanding: 0, credit: 0, unallocated: 0 };
  // Zeros rather than `null`: this is the stat row at the top of the 360 view, so the shape has to
  // survive — and for an account somebody does not manage, "nothing billed, nothing received" is
  // the same refusal the empty list beside it gives.
  if (!(await canSeeCompanyMoney(user.id, companyId))) {
    return { billed: 0, received: 0, outstanding: 0, credit: 0, unallocated: 0 };
  }

  const [orders, receipts] = await Promise.all([
    db.companyProduct.findMany({
      where: { companyId },
      select: {
        quantity: true,
        unitPrice: true,
        item: { select: { sellingPrice: true, taxRatePercent: true } },
        allocations: { select: { amount: true } },
      },
    }),
    db.payment.findMany({
      where: { companyId, direction: "RECEIVED" },
      select: { amount: true, currency: true, exchangeRate: true, allocations: { select: { amount: true, paymentAmount: true } } },
    }),
  ]);

  const billed = orders.reduce(
    (sum, order) => sum + computeOrderFinancials(order).total,
    0,
  );
  const allocated = orders.reduce(
    (sum, order) => sum + computeOrderFinancials(order).paid,
    0,
  );

  const round = (n: number) => Math.round(n * 100) / 100;
  /**
   * Received and unallocated are in rupees, like the order figures beside them: a receipt in dollars
   * at its own rate. Unallocated is what each receipt has not been set against — orders *or* invoices.
   * It was "received less what the orders took", so money applied to an invoice read as unallocated.
   */
  const receivedTotal = receipts.reduce((sum, p) => sum + round(Number(p.amount) * bookingRate(p)), 0);
  const unallocatedTotal = receipts.reduce((sum, p) => {
    const left = round(Number(p.amount) - p.allocations.reduce((t, a) => t + takenFromPayment(a), 0));
    return sum + (left > 0 ? round(left * bookingRate(p)) : 0);
  }, 0);
  const net = round(billed - allocated);

  return {
    billed: round(billed),
    received: round(receivedTotal),
    // Split rather than letting one figure go negative: money we're still owed and money sitting on
    // the account in the customer's favour are different things, and a "-₹31,710 outstanding" reads
    // as a bug even when the arithmetic is right.
    outstanding: Math.max(net, 0),
    credit: Math.max(-net, 0),
    unallocated: round(unallocatedTotal),
  };
}

/**
 * The Payments page's two lists, paginated. Orders are sliced in memory rather than in SQL because
 * their payment status is derived from the allocations after the query — the database can't filter
 * on "partially paid" without recomputing what `computeOrderFinancials` already knows.
 */
export async function listOrdersWithPaymentsPaged(params: {
  search?: string;
  status?: PaymentStatusFilter;
  page: number;
  pageSize: number;
}) {
  const all = await listOrdersWithPayments({
    search: params.search,
    status: params.status,
  });
  const outstanding = all.reduce((sum, o) => sum + Math.max(o.balance, 0), 0);
  return { ...pageOf(all, params.page, params.pageSize), outstanding };
}

export async function listPaymentsPaged(params: {
  search?: string;
  unallocatedOnly?: boolean;
  page: number;
  pageSize: number;
}) {
  const all = await listPayments({
    search: params.search,
    unallocatedOnly: params.unallocatedOnly,
  });
  // In rupees, the one currency a total can be in: a receipt in dollars counts at its own rate.
  const unallocated = all.reduce(
    (sum, p) => sum + Math.round(Math.max(p.unallocated, 0) * bookingRate(p) * 100) / 100,
    0,
  );
  return { ...pageOf(all, params.page, params.pageSize), unallocated };
}

/**
 * Bulk delete from the Payments received list. Deleting a payment cascades its allocations, which
 * moves the orders it was paying for back to outstanding — so it's gated on the same permission as
 * deleting one at a time rather than being a lighter-weight bulk path.
 */
export async function bulkDeletePayments(
  paymentIds: string[],
): Promise<ActionResult<{ count: number }>> {
  const user = await requireModuleUser("payments");
  if (!(await hasEffectivePermission(user.id, "payments.delete"))) {
    return {
      ok: false,
      error: "You don't have permission to delete payments.",
    };
  }
  if (paymentIds.length === 0)
    return { ok: false, error: "Select at least one payment." };

  /**
   * Which of the posted ids this person may actually act on, rather than all of them.
   *
   * The list they were selected from is account-scoped now, so a genuine selection is unchanged —
   * but the ids come back from the browser, and deleting a receipt off an account you are not
   * allowed to see is the same rule broken in the other direction.
   */
  const payments = await db.payment.findMany({
    where: { id: { in: paymentIds }, ...(await paymentScope(user.id)) },
    select: { id: true, companyId: true, amount: true, currency: true, paymentSeq: true, allocations: { select: { documentId: true } } },
  });

  /**
   * One at a time, each exactly as `deletePayment` does it. This was a single `deleteMany`, which
   * removed the rows and nothing else: every entry of every payment selected stayed in the ledger
   * with its `paymentId` let go, and every invoice they had settled kept reading PAID — the bulk
   * path was the single delete's old bug, at the size of a page.
   *
   * A transaction per payment, so one that can't be reversed (the books closed to today, say) is
   * reported and leaves the others deleted, rather than failing the lot after some had gone.
   */
  let count = 0;
  const failures: string[] = [];
  for (const payment of payments) {
    try {
      await removePayment(payment.id, user.id, payment.allocations);
      count += 1;
      await recordAudit({
        userId: user.id,
        action: "DELETE",
        entityType: "Payment",
        entityId: payment.id,
        entityLabel: `Deleted payment #${payment.paymentSeq} of ${isBaseCurrency(payment.currency) ? "" : `${payment.currency} `}${payment.amount}`,
      });
    } catch (error) {
      failures.push(`#${payment.paymentSeq}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const companyId of new Set(payments.map((p) => p.companyId))) {
    revalidatePath(`/companies/${companyId}`);
  }
  revalidatePath("/payments");
  revalidatePath("/receivables");
  revalidatePath("/payables");
  if (failures.length > 0 && count === 0) {
    return { ok: false, error: `No payment was deleted. ${failures.join(" ")}` };
  }
  if (failures.length > 0) {
    return { ok: false, error: `${count} deleted; ${failures.length} could not be. ${failures.join(" ")}` };
  }
  return { ok: true, data: { count } };
}
