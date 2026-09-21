"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type OrderStatus, type OrderBusinessType } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { assertNotOwnRecord, AuthzError } from "@/lib/authz/guards";
import { viaCompanyScope } from "@/lib/authz/company-scope";
import { hasEffectivePermission } from "@/actions/permission";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { formatOrderId } from "@/lib/order-id";
import { createOrderSchema, approveOrderSchema, processOrderSchema } from "@/lib/validation/order";
import { isVendorRelationshipType } from "@/lib/validation/company";
import { canResellerTrade, resellerStatusLabels } from "@/lib/reseller-onboarding";
import { toPlain } from "@/lib/serialize";
import { pageSlice } from "@/lib/pagination";
import type { ActionResult } from "@/actions/company";

/**
 * A commission's payee must be a real commission party, and the account it's paid into must belong
 * to that same party — the punch form leaves a stale account id in state when the payee is changed,
 * so without this a payout can be recorded against another party's bank account.
 */
async function validateExpensePayees(
  expenses: { payeeCompanyId?: string; payeeAccountId?: string }[],
): Promise<string | null> {
  const payeeIds = Array.from(new Set(expenses.map((e) => e.payeeCompanyId).filter((id): id is string => !!id)));
  const accountIds = Array.from(new Set(expenses.map((e) => e.payeeAccountId).filter((id): id is string => !!id)));
  if (payeeIds.length === 0 && accountIds.length === 0) return null;

  const [parties, accounts] = await Promise.all([
    db.company.findMany({ where: { id: { in: payeeIds } }, select: { id: true, relationshipType: true } }),
    accountIds.length > 0
      ? db.commissionPartyAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true, commissionPartyId: true } })
      : Promise.resolve([]),
  ]);
  const partyById = new Map(parties.map((p) => [p.id, p]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  for (const e of expenses) {
    if (e.payeeCompanyId && partyById.get(e.payeeCompanyId)?.relationshipType !== "COMMISSION_PARTY") {
      return "That commission payee isn't a commission party.";
    }
    if (e.payeeAccountId && accountById.get(e.payeeAccountId)?.commissionPartyId !== e.payeeCompanyId) {
      return "That payee account doesn't belong to the selected commission party.";
    }
  }
  return null;
}

/** The order-punching form (sales). Vendor/purchase price aren't collected here — that's the purchase team's job once accounts approves. */
export async function createOrder(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = createOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const company = await db.company.findUnique({ where: { id: data.companyId } });
  if (!company) {
    return { ok: false, error: "Company not found." };
  }
  const location = await db.companyLocation.findUnique({ where: { id: data.locationId } });
  if (!location || location.companyId !== data.companyId) {
    return { ok: false, error: "That location does not belong to this company." };
  }
  if (data.proposalId) {
    const proposal = await db.proposal.findUnique({ where: { id: data.proposalId }, include: { lead: true } });
    if (!proposal || proposal.lead.companyId !== data.companyId) {
      return { ok: false, error: "That proposal does not belong to this company." };
    }
  }
  // A reseller can only trade once onboarding is signed off — that gate is the whole point of it.
  if (company.relationshipType === "RESELLER") {
    const profile = await db.resellerProfile.findUnique({ where: { companyId: company.id } });
    if (!profile || !canResellerTrade(profile.status)) {
      const status = profile ? resellerStatusLabels[profile.status] : "not onboarded";
      return {
        ok: false,
        error: `${company.name} can't be ordered for yet — their reseller onboarding is ${status.toLowerCase()}. Finish it on their company page first.`,
      };
    }
  }
  const payeeError = await validateExpensePayees(data.expenses);
  if (payeeError) {
    return { ok: false, error: payeeError };
  }
  // An end customer only makes sense under the reseller who owns them — the order itself stays with
  // the reseller, since they're who we invoice.
  if (data.endCustomerId) {
    if (company.relationshipType !== "RESELLER") {
      return { ok: false, error: "Only a reseller's order can name an end customer." };
    }
    const endCustomer = await db.company.findUnique({ where: { id: data.endCustomerId } });
    if (!endCustomer || endCustomer.managedByResellerId !== data.companyId) {
      return { ok: false, error: "That end customer doesn't belong to this reseller." };
    }
  }

  const order = await db.companyProduct.create({
    data: {
      companyId: data.companyId,
      locationId: data.locationId,
      itemId: data.itemId,
      quantity: data.quantity,
      unitPrice: data.unitPrice ?? null,
      businessType: data.businessType,
      endCustomerId: data.endCustomerId || null,
      poNumber: data.poNumber || null,
      proposalId: data.proposalId || null,
      paymentTerms: data.paymentTerms || null,
      startDate: data.startDate ? new Date(data.startDate) : null,
      endDate: data.endDate ? new Date(data.endDate) : null,
      notes: data.notes || null,
      addedByUserId: user.id,
      orderStatus: "PENDING_APPROVAL",
      watchers: data.watcherUserIds.length > 0 ? { connect: data.watcherUserIds.map((id) => ({ id })) } : undefined,
      expenses:
        data.expenses.length > 0
          ? {
              create: data.expenses.map((e) => ({
                type: e.type,
                amount: e.amount,
                notes: e.notes || null,
                payeeCompanyId: e.payeeCompanyId || null,
                payeeAccountId: e.payeeAccountId || null,
              })),
            }
          : undefined,
    },
  });

  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Order", entityId: order.id, entityLabel: `Order for ${company.name}` });

  await Promise.all(
    data.watcherUserIds
      .filter((id) => id !== user.id)
      .map((watcherId) =>
        notifyUser({
          userId: watcherId,
          type: "ORDER_WATCHER_ADDED",
          title: "You were added as a watcher on an order",
          message: `${formatOrderId(order.orderSeq)} — ${company.name}`,
          link: `/orders/${order.id}`,
        }),
      ),
  );

  revalidatePath("/orders");
  revalidatePath(`/companies/${data.companyId}`);
  return { ok: true, data: { id: order.id } };
}

/** Accounts reviews payment terms and gives (or refuses) the go-ahead. */
export async function approveOrder(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "orders.approve"))) {
    return { ok: false, error: "You don't have permission to approve orders." };
  }
  const parsed = approveOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orderId, approved, notes } = parsed.data;

  const order = await db.companyProduct.findUnique({ where: { id: orderId }, include: { company: true } });
  if (!order) {
    return { ok: false, error: "Order not found." };
  }
  if (order.orderStatus !== "PENDING_APPROVAL") {
    return { ok: false, error: "This order has already been reviewed." };
  }

  /**
   * You may not approve the order you punched.
   *
   * `selfExcluded` and `assertNotOwnRecord` were written for exactly this, badged in the permission
   * matrix as "Not on own records", and then set on no key and called from nowhere — so the badge
   * described a rule the system did not have. ACCOUNTS and MANAGEMENT both hold `orders.approve` by
   * default, and a manager could punch an order and wave it through in the same minute.
   */
  try {
    assertNotOwnRecord("orders.approve", user.id, order.addedByUserId);
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.message };
    throw err;
  }

  const nextStatus: OrderStatus = approved ? "APPROVED" : "REJECTED";
  await db.companyProduct.update({
    where: { id: orderId },
    data: {
      orderStatus: nextStatus,
      accountsApprovedByUserId: user.id,
      accountsApprovedAt: new Date(),
      accountsNotes: notes || null,
    },
  });

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Order", entityId: orderId, entityLabel: formatOrderId(order.orderSeq) });

  if (order.addedByUserId !== user.id) {
    await notifyUser({
      userId: order.addedByUserId,
      type: "ORDER_STATUS_CHANGED",
      title: approved ? "Your order was approved" : "Your order was rejected",
      message: `${formatOrderId(order.orderSeq)} — ${order.company.name}`,
      link: `/orders/${orderId}`,
    });
  }

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/companies/${order.companyId}`);
  return { ok: true, data: { id: orderId } };
}

/** Purchase team sets the vendor, cost price, and our PO once an order is approved. */
export async function processOrder(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "orders.process"))) {
    return { ok: false, error: "You don't have permission to process orders." };
  }
  const parsed = processOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orderId, vendorId, purchasePrice, ourPoNumber } = parsed.data;

  const order = await db.companyProduct.findUnique({ where: { id: orderId } });
  if (!order) {
    return { ok: false, error: "Order not found." };
  }
  if (order.orderStatus !== "APPROVED" && order.orderStatus !== "PROCESSING") {
    return { ok: false, error: "This order isn't ready for purchasing yet — it needs accounts approval first." };
  }
  const vendor = await db.company.findUnique({ where: { id: vendorId } });
  if (!vendor || !isVendorRelationshipType(vendor.relationshipType)) {
    return { ok: false, error: "That's not a valid vendor." };
  }

  await db.companyProduct.update({
    where: { id: orderId },
    data: {
      vendorId,
      purchasePrice,
      ourPoNumber: ourPoNumber || null,
      purchasedByUserId: user.id,
      orderStatus: "PROCESSING",
    },
  });

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Order", entityId: orderId, entityLabel: formatOrderId(order.orderSeq) });

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/companies/${order.companyId}`);
  return { ok: true, data: { id: orderId } };
}

/** Purchase team marks the order complete — this is what makes it a normal, fully-live line in the customer's Products & Subscriptions. */
export async function fulfillOrder(orderId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "orders.process"))) {
    return { ok: false, error: "You don't have permission to process orders." };
  }
  const order = await db.companyProduct.findUnique({
    where: { id: orderId },
    include: { company: true, watchers: { select: { id: true } } },
  });
  if (!order) {
    return { ok: false, error: "Order not found." };
  }
  if (!order.vendorId || order.purchasePrice === null) {
    return { ok: false, error: "Set the vendor and purchase price before marking this order fulfilled." };
  }
  if (order.orderStatus !== "PROCESSING" && order.orderStatus !== "APPROVED") {
    return { ok: false, error: "Only an approved or in-progress order can be marked fulfilled." };
  }

  await db.companyProduct.update({
    where: { id: orderId },
    data: { orderStatus: "FULFILLED", fulfilledAt: new Date() },
  });

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Order", entityId: orderId, entityLabel: formatOrderId(order.orderSeq) });

  const notifyIds = new Set(order.watchers.map((w) => w.id));
  notifyIds.add(order.addedByUserId);
  notifyIds.delete(user.id);
  await Promise.all(
    Array.from(notifyIds).map((userId) =>
      notifyUser({
        userId,
        type: "ORDER_STATUS_CHANGED",
        title: "Order fulfilled",
        message: `${formatOrderId(order.orderSeq)} — ${order.company.name}`,
        link: `/orders/${orderId}`,
      }),
    ),
  );

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/companies/${order.companyId}`);
  revalidatePath("/renewals");
  return { ok: true, data: null };
}

export async function cancelOrder(orderId: string, reason?: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const order = await db.companyProduct.findUnique({ where: { id: orderId } });
  if (!order) {
    return { ok: false, error: "Order not found." };
  }
  if (order.orderStatus === "FULFILLED" || order.orderStatus === "CANCELLED") {
    return { ok: false, error: "This order can no longer be cancelled." };
  }
  const [canApprove, canProcess] = await Promise.all([
    hasEffectivePermission(user.id, "orders.approve"),
    hasEffectivePermission(user.id, "orders.process"),
  ]);
  if (order.addedByUserId !== user.id && !canApprove && !canProcess) {
    return { ok: false, error: "You don't have permission to cancel this order." };
  }

  await db.companyProduct.update({
    where: { id: orderId },
    data: {
      orderStatus: "CANCELLED",
      accountsNotes: reason ? `Cancelled: ${reason}` : order.accountsNotes,
    },
  });

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/companies/${order.companyId}`);
  return { ok: true, data: null };
}

type OrderListParams = {
  status?: OrderStatus;
  businessType?: OrderBusinessType;
  companyId?: string;
  /** Orders a reseller placed for this end customer — the orders themselves belong to the reseller. */
  endCustomerId?: string;
  /** True = only orders placed by a reseller, false = only direct orders. */
  viaReseller?: boolean;
  search?: string;
};

async function orderListWhere(
  userId: string,
  params?: OrderListParams,
): Promise<Prisma.CompanyProductWhereInput> {
  // Both the reseller filter and the search narrow the related company, so they're merged into one
  // `company` clause — spreading them separately would silently drop whichever came first.
  const companyFilter = {
    ...(params?.viaReseller === true ? { relationshipType: "RESELLER" as const } : {}),
    ...(params?.viaReseller === false ? { relationshipType: { not: "RESELLER" as const } } : {}),
    ...(params?.search ? { name: { contains: params.search, mode: "insensitive" as const } } : {}),
  };
  return {
    /**
     * An order reaches its account directly — `CompanyProduct.companyId` is the customer we
     * invoice, which stays the reseller on a reseller's order.
     *
     * It goes in `AND` rather than being spread, because the scope narrows the same `company`
     * relation `companyFilter` does and a second `company` key in this literal would keep only
     * whichever was written last: exactly the silent drop the comment above is about, except that
     * losing this one loses the scope. `viaCompanyScope` yields `{}` for an unrestricted viewer,
     * and `AND: [{}]` is no condition at all.
     */
    AND: [(await viaCompanyScope(userId)) as Prisma.CompanyProductWhereInput],
    ...(params?.status ? { orderStatus: params.status } : {}),
    ...(params?.businessType ? { businessType: params.businessType } : {}),
    ...(params?.companyId ? { companyId: params.companyId } : {}),
    ...(params?.endCustomerId ? { endCustomerId: params.endCustomerId } : {}),
    ...(Object.keys(companyFilter).length > 0 ? { company: companyFilter } : {}),
  };
}

const orderListInclude = {
  company: { select: { id: true, name: true, relationshipType: true } },
  endCustomer: { select: { id: true, name: true } },
  item: { select: { id: true, name: true, sku: true, unit: true, sellingPrice: true, taxRatePercent: true } },
  vendor: { select: { id: true, name: true } },
  addedBy: { select: { id: true, name: true } },
  allocations: { select: { amount: true } },
} as const;

export async function listOrders(params?: OrderListParams) {
  const user = await requireUser();
  return db.companyProduct.findMany({
    where: await orderListWhere(user.id, params),
    orderBy: { createdAt: "desc" },
    include: orderListInclude,
  });
}

export async function listOrdersPaged(params: OrderListParams & { page: number; pageSize: number }) {
  const user = await requireUser();
  // All three queries below take this same `where`, scope included — the page, the total the pager
  // counts against, and the badge. A scoped page with an unscoped total is a pager that walks off
  // the end of the list; a scoped page with an unscoped badge is a queue that never empties.
  const where = await orderListWhere(user.id, params);
  const [rows, total, pendingApproval] = await Promise.all([
    db.companyProduct.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: orderListInclude,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.companyProduct.count({ where }),
    // Counted across the whole filtered set — an "awaiting approval" badge that only saw the
    // current page would understate the queue accounts actually has to work through.
    db.companyProduct.count({ where: { ...where, orderStatus: "PENDING_APPROVAL" } }),
  ]);
  return { rows: toPlain(rows), total, pendingApproval };
}

export async function getOrder(id: string) {
  const user = await requireUser();
  // Scoped in the `where` so the include stays exactly as the detail page expects it, and so an
  // order on somebody else's account answers the same way a made-up id does. This page carries the
  // purchase price and the vendor as well as the sale, which is more than the list ever shows.
  const order = await db.companyProduct.findFirst({
    where: { id, ...(await viaCompanyScope(user.id)) },
    include: {
      company: { select: { id: true, name: true, paymentTerms: true, relationshipType: true } },
      endCustomer: { select: { id: true, name: true } },
      location: { select: { id: true, label: true } },
      item: {
        select: { id: true, name: true, sku: true, unit: true, sellingPrice: true, taxRatePercent: true, costPrice: true, type: true },
      },
      vendor: { select: { id: true, name: true, paymentTerms: true } },
      proposal: { select: { id: true, status: true } },
      addedBy: { select: { id: true, name: true } },
      accountsApprovedBy: { select: { id: true, name: true } },
      purchasedBy: { select: { id: true, name: true } },
      watchers: { select: { id: true, name: true } },
      expenses: {
        orderBy: { createdAt: "asc" },
        include: { payee: { select: { id: true, name: true } }, payeeAccount: { select: { id: true, label: true } } },
      },
      allocations: {
        include: {
          payment: { select: { id: true, paidOn: true, method: true, reference: true } },
          allocatedBy: { select: { id: true, name: true } },
        },
      },
    },
  });
  return order ? toPlain(order) : null;
}

/** Proposals belonging to leads of this company, for the order-punch "link to proposal" picker. */
export async function listProposalOptions(companyId: string) {
  const user = await requireUser();
  return db.proposal.findMany({
    // A proposal reaches the account through its lead, so the scope goes inside the `lead` clause
    // rather than beside it. Scoped as well as filtered by the caller's `companyId`: a company id
    // is not a secret, and the picker would otherwise read out what any account has been quoted.
    where: { lead: { companyId, ...(await viaCompanyScope(user.id)) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, validUntil: true, lead: { select: { title: true } } },
  });
}

/**
 * Whether this company already has a prior order (any status except cancelled/rejected) for this
 * item — used to default the order-punch form's "New / Renewal" field to Renewal. Can't detect
 * the "new to us, but the customer already had it elsewhere" case — that's judgment only the
 * sales person punching the order has.
 */
export async function hasExistingOrderForItem(companyId: string, itemId: string): Promise<boolean> {
  const user = await requireUser();
  const existing = await db.companyProduct.findFirst({
    // Scoped as well as filtered by id: unscoped, this is a yes/no oracle over the whole order
    // book — pass a company id and an item id and it answers whether that account buys that
    // product. Out of scope it answers "no", which is what the form does for a brand-new sale.
    where: { companyId, itemId, ...(await viaCompanyScope(user.id)), orderStatus: { notIn: ["REJECTED", "CANCELLED"] } },
    select: { id: true },
  });
  return !!existing;
}
