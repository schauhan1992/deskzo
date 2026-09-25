"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { syncInvoiceStatus } from "@/lib/receivables/sync";
import { reversePaymentPosting } from "@/lib/ledger/journal";
import { requireUser } from "@/lib/session";
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
  const user = await requireUser();
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
  }

  const payment = await db.$transaction(async (tx) => {
    const created = await tx.payment.create({
      data: {
        companyId,
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
  const user = await requireUser();
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

  const alreadyAllocated = payment.allocations.reduce(
    (sum, a) => sum + Number(a.amount),
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

  const allocation = await db.paymentAllocation.create({
    data: { paymentId, companyProductId, amount, allocatedByUserId: user.id },
  });

  revalidatePath(`/companies/${payment.companyId}`);
  revalidatePath("/payments");
  return { ok: true, data: { id: allocation.id } };
}

export async function deleteAllocation(
  id: string,
): Promise<ActionResult<null>> {
  const user = await requireUser();
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

  await db.paymentAllocation.delete({ where: { id } });

  revalidatePath(`/companies/${allocation.payment.companyId}`);
  revalidatePath("/payments");
  return { ok: true, data: null };
}

export async function deletePayment(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
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

  /**
   * Three things, and previously only the first.
   *
   * The row went, and its ledger entry stayed posted with a dangling `paymentId` — bank overstated,
   * receivables understated, for good — while the invoice it had settled kept its PAID status and
   * quietly stopped being chased. A deletion that leaves the books wrong and the customer unchased
   * is worse than a refusal.
   */
  await db.$transaction(async (tx) => {
    await reversePaymentPosting(tx, id, user.id);
    await tx.payment.delete({ where: { id } });
  });

  const invoiceIds = [...new Set(payment.allocations.map((a) => a.documentId).filter((x): x is string => !!x))];
  for (const invoiceId of invoiceIds) {
    await syncInvoiceStatus(invoiceId);
  }

  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "Payment",
    entityId: id,
    entityLabel: `Deleted payment #${payment.paymentSeq} of ${payment.amount}`,
  });

  revalidatePath(`/companies/${payment.companyId}`);
  revalidatePath("/payments");
  revalidatePath("/receivables");
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
  const user = await requireUser();
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
  const user = await requireUser();
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
  const user = await requireUser();
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
  const user = await requireUser();
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
          document: { select: { id: true, docNumber: true } },
        },
      },
    },
    orderBy: { paidOn: "desc" },
  });

  const withRemaining = toPlain(payments).map((payment) => {
    const allocated = payment.allocations.reduce(
      (sum, a) => sum + Number(a.amount),
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
  const user = await requireUser();
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
          document: { select: { id: true, docNumber: true } },
        },
      },
    },
  });

  return toPlain(payments).map((payment) => {
    const allocated = payment.allocations.reduce(
      (sum, a) => sum + Number(a.amount),
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
  const user = await requireUser();
  if (!(await viewerHas("payments.view"))) return { billed: 0, received: 0, outstanding: 0, credit: 0, unallocated: 0 };
  // Zeros rather than `null`: this is the stat row at the top of the 360 view, so the shape has to
  // survive — and for an account somebody does not manage, "nothing billed, nothing received" is
  // the same refusal the empty list beside it gives.
  if (!(await canSeeCompanyMoney(user.id, companyId))) {
    return { billed: 0, received: 0, outstanding: 0, credit: 0, unallocated: 0 };
  }

  const [orders, received] = await Promise.all([
    db.companyProduct.findMany({
      where: { companyId },
      select: {
        quantity: true,
        unitPrice: true,
        item: { select: { sellingPrice: true, taxRatePercent: true } },
        allocations: { select: { amount: true } },
      },
    }),
    db.payment.aggregate({ where: { companyId, direction: "RECEIVED" }, _sum: { amount: true } }),
  ]);

  const billed = orders.reduce(
    (sum, order) => sum + computeOrderFinancials(order).total,
    0,
  );
  const allocated = orders.reduce(
    (sum, order) => sum + computeOrderFinancials(order).paid,
    0,
  );
  const receivedTotal = Number(received._sum.amount ?? 0);

  const round = (n: number) => Math.round(n * 100) / 100;
  const net = round(billed - allocated);

  return {
    billed: round(billed),
    received: round(receivedTotal),
    // Split rather than letting one figure go negative: money we're still owed and money sitting on
    // the account in the customer's favour are different things, and a "-₹31,710 outstanding" reads
    // as a bug even when the arithmetic is right.
    outstanding: Math.max(net, 0),
    credit: Math.max(-net, 0),
    unallocated: Math.max(round(receivedTotal - allocated), 0),
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
  const unallocated = all.reduce(
    (sum, p) => sum + Math.max(p.unallocated, 0),
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
  const user = await requireUser();
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
    select: { id: true, companyId: true },
  });
  const result = await db.payment.deleteMany({
    where: { id: { in: payments.map((p) => p.id) } },
  });

  for (const companyId of new Set(payments.map((p) => p.companyId))) {
    revalidatePath(`/companies/${companyId}`);
  }
  revalidatePath("/payments");
  return { ok: true, data: { count: result.count } };
}
