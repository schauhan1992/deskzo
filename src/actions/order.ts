"use server";

import { revalidatePath } from "next/cache";
import { detectSalesWins } from "@/lib/wins/detect";
import { Prisma, type OrderStatus, type OrderBusinessType } from "@prisma/client";
import { db } from "@/lib/db";
import { CATEGORY_SELECT } from "@/lib/customers/categories";
import { requireModuleUser } from "@/lib/modules-access";
import { assertNotOwnRecord, AuthzError } from "@/lib/authz/guards";
import { canSeeCompany, viaCompanyScope } from "@/lib/authz/company-scope";
import { orderAccess } from "@/lib/authz/access";
import { hasEffectivePermission, viewerHas } from "@/actions/permission";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { changedLabel, customFieldsForCreate, customSearchWhere, saveCustomFields } from "@/lib/custom-fields/server";
import { customFilterWhere, type CustomFilterInputs } from "@/lib/custom-fields/filters";
import { formatOrderId } from "@/lib/order-id";
import { companyPath, orderPath } from "@/lib/record-links";
import { createOrderSchema, approveOrderSchema, processOrderSchema, orderQuoteSchema, orderDealSchema, approveLossSchema } from "@/lib/validation/order";
import { COST_SOURCE_LABELS, needsLossApproval, unitCostOf, type CostSource } from "@/lib/rebates/rules";
import { resolveRebateInput } from "@/lib/rebates/server";
import {
  MIN_INCREASE_REASON,
  calendarDay,
  checkReleaseDate,
  needsSalesApproval,
  priceCeiling,
  savingAmount,
  shortDay,
} from "@/lib/orders/handoff-rules";
import { peopleHolding, releaseDueOrders, tellPurchase } from "@/lib/orders/handoff";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { isCustomerRelationshipType, isVendorRelationshipType } from "@/lib/validation/company";
import { resellerOrderRefusal } from "@/lib/orders/reseller-gate";
import { inStepWhere, orderSteps } from "@/lib/pipeline/order-steps-server";
import { toPlain } from "@/lib/serialize";
import { pageSlice } from "@/lib/pagination";
import type { ActionResult } from "@/actions/company";
import { checkTerms, recordDecision, MIN_REASON } from "@/lib/credit/guard";
import type { CreditAssessment } from "@/lib/credit/engine";
import { orderCreditPosition } from "@/lib/credit/order";

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

const num = (v: Prisma.Decimal | number | null | undefined) => (v === null || v === undefined ? null : Number(v));
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * An order the caller may see, or null — the account scope every order action goes through, so an
 * order on somebody else's account answers exactly as a made-up id does.
 */
async function visibleOrder(userId: string, id: string) {
  const order = await db.companyProduct.findUnique({
    where: { id },
    include: { company: { select: { id: true, companySeq: true, name: true, ownerUserId: true, relationshipType: true } } },
  });
  if (!order || !(await canSeeCompany(userId, order.company))) return null;
  return order;
}

/** The salesperson who punched the order, or anyone who approves orders: who decides on its hand-off and its price. */
async function speaksForSales(userId: string, order: { addedByUserId: string }) {
  return order.addedByUserId === userId || (await hasEffectivePermission(userId, "orders.approve"));
}

type LossFields = {
  itemId: string;
  unitPrice: Prisma.Decimal | null;
  purchasePrice: Prisma.Decimal | null;
  dealPrice: Prisma.Decimal | null;
  quotedPurchasePrice: Prisma.Decimal | null;
  lossApprovedCost: Prisma.Decimal | null;
};
type LossNeed = { unitPrice: number; cost: number; from: CostSource };

/**
 * Selling below cost — a negative call — needs a manager holding `orders.approveLoss`, whatever the
 * rebate (owner, 1 Oct 2026). At `at` (what purchase is about to pay) or else the best cost known,
 * what needs approving — or null when the order isn't below cost there, or was approved at that cost
 * or more already.
 */
async function lossNeeded(order: LossFields, at?: { cost: number; from: CostSource }): Promise<LossNeed | null> {
  const known = at ?? unitCostOf({ purchasePrice: num(order.purchasePrice), dealPrice: num(order.dealPrice), quotedPurchasePrice: num(order.quotedPurchasePrice) });
  if (!known) return null;
  const unitPrice =
    num(order.unitPrice) ?? num((await db.item.findUnique({ where: { id: order.itemId }, select: { sellingPrice: true } }))?.sellingPrice);
  if (!needsLossApproval({ unitPrice, unitCost: known.cost, lossApprovedCost: num(order.lossApprovedCost) })) return null;
  return { unitPrice: unitPrice as number, cost: known.cost, from: known.from };
}

/** The words a below-cost order is held with. */
function lossWords(label: string, need: LossNeed) {
  const under = Math.round((need.cost - need.unitPrice) * 100) / 100;
  return `${label} sells at ${rupees(need.unitPrice)} a unit — ${rupees(under)} under ${COST_SOURCE_LABELS[need.from]} (${rupees(need.cost)}). Selling below cost needs a manager holding “Approve orders sold below cost”.`;
}

/**
 * Keeps the unit cost somebody was stopped at for selling below cost — the highest asked for — so the
 * order shows a manager exactly what to approve.
 */
async function recordLossRequest(order: { id: string; lossRequestedCost: Prisma.Decimal | null }, cost: number, at: Date) {
  const asked = num(order.lossRequestedCost);
  if (asked !== null && asked >= cost) return;
  await db.companyProduct.update({ where: { id: order.id }, data: { lossRequestedCost: cost, lossRequestedAt: at } });
}

/** Tells the people who may approve a negative call that one is waiting on them. */
async function askForLossApproval(order: { id: string; orderSeq: number; addedByUserId: string }, need: LossNeed, byUserId: string) {
  const label = formatOrderId(order.orderSeq);
  const approvers = (await peopleHolding("orders.approveLoss")).filter((id) => id !== byUserId && id !== order.addedByUserId);
  await Promise.all(
    approvers.map((userId) =>
      notifyUser({
        userId,
        type: "ORDER_STATUS_CHANGED",
        title: `${label}: sold below cost — needs your approval`,
        message: `It sells at ${rupees(need.unitPrice)} a unit against ${rupees(need.cost)} — ${COST_SOURCE_LABELS[need.from]}.`,
        link: orderPath(order.orderSeq),
      }),
    ),
  );
}

type QuoteData = {
  quotedPurchasePrice?: number;
  quoteVendorId?: string;
  quoteVendorName?: string;
  quoteContact?: string;
  quotedOn?: string;
  quoteRemarks?: string;
};

/**
 * The distributor price as it will be stored, checked: the distributor a vendor in the CRM (or a name
 * typed for one that isn't), the date a real one no later than today on the workspace's calendar —
 * blank is today.
 */
async function resolveQuote(data: QuoteData, now: Date, clock: Clock) {
  if (data.quotedPurchasePrice === undefined) return { ok: true as const, quote: null };
  const quoteVendorId = data.quoteVendorId || null;
  if (quoteVendorId) {
    const vendor = await db.company.findUnique({ where: { id: quoteVendorId }, select: { relationshipType: true } });
    if (!vendor || !isVendorRelationshipType(vendor.relationshipType)) {
      return { ok: false as const, error: "That distributor isn't a vendor in the CRM — pick one, or type their name." };
    }
  }
  const today = clock.today(now);
  const onKey = data.quotedOn || today;
  const quotedOn = calendarDay(onKey);
  if (!quotedOn) return { ok: false as const, error: "The date quoted isn't a date." };
  if (onKey > today) return { ok: false as const, error: "The date quoted can't be in the future." };
  return {
    ok: true as const,
    quote: {
      quotedPurchasePrice: new Prisma.Decimal(data.quotedPurchasePrice),
      quoteVendorId,
      quoteVendorName: quoteVendorId ? null : data.quoteVendorName || null,
      quoteContact: data.quoteContact || null,
      quotedOn,
      quoteRemarks: data.quoteRemarks || null,
    },
  };
}

/** The order-punching form (sales). Vendor/purchase price aren't collected here — that's the purchase team's job once accounts approves. */
export async function createOrder(input: unknown): Promise<ActionResult<{ id: string; orderSeq: number }>> {
  const user = await requireModuleUser("orders");
  const parsed = createOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const company = await db.company.findUnique({ where: { id: data.companyId } });
  // Scoped: an order can only be punched for an account this person could open. It took any id.
  if (!company || !(await canSeeCompany(user.id, company))) {
    return { ok: false, error: "Company not found." };
  }
  /**
   * Terms set on the order itself, longer than the customer's credit record supports, are an
   * override. An order left on the customer's default is not — that default was its own decision
   * — though approval still weighs both against the rating as it stands then.
   */
  const termsCheck = data.paymentTerms
    ? await checkTerms({
        userId: user.id,
        companyId: company.id,
        relationshipType: company.relationshipType,
        terms: data.paymentTerms,
        previousTerms: company.paymentTerms,
        reason: data.creditOverrideReason,
        subject: "Terms on a new order",
      })
    : ({ ok: true, decision: null } as const);
  if (!termsCheck.ok) return { ok: false, error: termsCheck.error };
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
  // A reseller can only trade once onboarding is signed off — the same gate for seats and renewals.
  const resellerRefusal = await resellerOrderRefusal(company);
  if (resellerRefusal) return { ok: false, error: resellerRefusal };
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

  /**
   * The hand-off. Sent now is what every order always did. Held or scheduled, it stays out of
   * purchase's queue and counts as booked only once a payment arrives or it is released (O-D2), so
   * `bookedAt` starts empty.
   */
  const now = new Date();
  const clock = await workspaceClock();
  let handoff: Pick<Prisma.CompanyProductUncheckedCreateInput, "purchaseRelease" | "releaseOn" | "releasedAt" | "releasedById" | "bookedAt">;
  if (data.handoff === "SCHEDULE") {
    const day = checkReleaseDate(data.releaseOn, now, clock);
    if (!day.ok) return { ok: false, error: day.error };
    handoff = { purchaseRelease: "SCHEDULED", releaseOn: day.day, bookedAt: null };
  } else if (data.handoff === "HOLD") {
    handoff = { purchaseRelease: "HELD", bookedAt: null };
  } else {
    handoff = { purchaseRelease: "RELEASED", releasedAt: now, releasedById: user.id };
  }
  const quoted = await resolveQuote(data, now, clock);
  if (!quoted.ok) return { ok: false, error: quoted.error };
  const quote = quoted.quote;

  // A backend rebate is seen — and so entered — only with `rebates.view` (owner: managers, not executives).
  if (data.rebates.length > 0 && !(await hasEffectivePermission(user.id, "rebates.view"))) {
    return { ok: false, error: "You can't enter a backend rebate — a manager adds it once the order is in." };
  }
  const rebateRows: Awaited<ReturnType<typeof resolveRebateInput>>[] = await Promise.all(data.rebates.map((r) => resolveRebateInput(r)));
  for (const r of rebateRows) if (!r.ok) return { ok: false, error: r.error };
  const rebateData = rebateRows.flatMap((r) => (r.ok ? [r.data] : []));
  const dealRegValidTo = data.dealRegValidTo ? calendarDay(data.dealRegValidTo) : null;
  // The workspace's own fields (src/lib/custom-fields), every required one answered. Add-ons and
  // renewals are raised from an order already punched, and start without them.
  const custom = await customFieldsForCreate("ORDER", user.id, data.customFields, { checkRequired: true });
  if (!custom.ok) return { ok: false, error: custom.error };

  const order = await db.companyProduct.create({
    data: {
      ...handoff,
      dealRegStatus: data.dealRegStatus || null,
      dealRegNumber: data.dealRegNumber || null,
      dealRegValidTo,
      dealPrice: data.dealPrice ?? null,
      rebates:
        rebateData.length > 0 ? { create: rebateData.map((r) => ({ ...r, createdById: user.id })) } : undefined,
      ...(quote
        ? {
            ...quote,
            quotedById: user.id,
            priceChanges: {
              create: {
                event: "QUOTED",
                toPrice: quote.quotedPurchasePrice,
                vendorId: quote.quoteVendorId,
                reason: quote.quoteRemarks,
                byUserId: user.id,
              },
            },
          }
        : {}),
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
      ...custom.data,
    },
  });

  const held =
    handoff.purchaseRelease === "HELD"
      ? " — held, not yet sent to purchase"
      : handoff.purchaseRelease === "SCHEDULED"
        ? ` — goes to purchase on ${shortDay(handoff.releaseOn as Date, clock, now)}`
        : "";
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Order",
    entityId: order.id,
    entityLabel: `Order for ${company.name}${held}${quote ? ` · distributor price ${rupees(Number(quote.quotedPurchasePrice))}` : ""}${data.dealRegStatus ? ` · deal registration ${data.dealRegStatus.toLowerCase()}${data.dealRegNumber ? ` (${data.dealRegNumber})` : ""}` : ""}${data.dealPrice !== undefined ? ` · deal price ${rupees(data.dealPrice)}` : ""}`,
  });
  if (termsCheck.decision) {
    await recordDecision({
      userId: user.id,
      companyId: company.id,
      orderId: order.id,
      kind: "ORDER",
      ...termsCheck.decision,
      detail: termsCheck.decision.detail.replace("a new order", formatOrderId(order.orderSeq)),
    });
  }

  await Promise.all(
    data.watcherUserIds
      .filter((id) => id !== user.id)
      .map((watcherId) =>
        notifyUser({
          userId: watcherId,
          type: "ORDER_WATCHER_ADDED",
          title: "You were added as a watcher on an order",
          message: `${formatOrderId(order.orderSeq)} — ${company.name}`,
          link: orderPath(order.orderSeq),
        }),
      ),
  );

  revalidatePath("/orders");
  revalidatePath(`/companies/${data.companyId}`);
  // The sequence as well as the id: the form goes straight to the order's clean address (ORD-…),
  // where the id alone would land on the cuid URL first and be redirected from there.
  return { ok: true, data: { id: order.id, orderSeq: order.orderSeq } };
}

/** Accounts reviews payment terms and gives (or refuses) the go-ahead. */
export async function approveOrder(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("orders");
  if (!(await hasEffectivePermission(user.id, "orders.approve"))) {
    return { ok: false, error: "You don't have permission to approve orders." };
  }
  const parsed = approveOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orderId, approved, notes, creditOverrideReason } = parsed.data;

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

  /**
   * Credit, weighed now rather than when the order was punched: the customer may have stopped
   * paying in between. Terms longer than the rating supports (unless an override for this order
   * was already recorded when it was punched), and a balance that would go over the limit, each
   * need `credit.override` and a reason. Rejecting never does.
   */
  let creditDecision: { assessment: CreditAssessment; detail: string; reason: string } | null = null;
  if (approved && isCustomerRelationshipType(order.company.relationshipType)) {
    const position = await orderCreditPosition(order.id);
    const concerns = position ? position.concerns.map((c) => c.text) : [];
    if (position && concerns.length > 0) {
      if (!(await hasEffectivePermission(user.id, "credit.override"))) {
        return {
          ok: false,
          error: `This order needs a credit override — ${concerns.join("; and ")}. Ask someone who can override credit, or reject it.`,
        };
      }
      if ((creditOverrideReason ?? "").trim().length < MIN_REASON) {
        return { ok: false, error: `Say why you're approving it anyway — ${concerns.join("; and ")}.` };
      }
      creditDecision = {
        assessment: position.assessment,
        detail: `Approved ${formatOrderId(order.orderSeq)} — ${concerns.join("; ")}`,
        reason: creditOverrideReason!,
      };
    }
  }

  /**
   * Below cost at the best price known — the deal price, or the distributor's quote — the go-ahead is
   * a manager's: whoever holds `orders.approveLoss` approves the negative call with the order;
   * anybody else is told a manager must first (`approveOrderLoss`). Rejecting never needs it.
   */
  let lossApprovedAt: number | null = null;
  if (approved) {
    const need = await lossNeeded(order);
    if (need) {
      if (!(await hasEffectivePermission(user.id, "orders.approveLoss"))) {
        return { ok: false, error: `${lossWords(formatOrderId(order.orderSeq), need)} Ask one to approve it on the order first, or reject it.` };
      }
      lossApprovedAt = need.cost;
    }
  }

  const nextStatus: OrderStatus = approved ? "APPROVED" : "REJECTED";
  await db.companyProduct.update({
    where: { id: orderId },
    data: {
      orderStatus: nextStatus,
      accountsApprovedByUserId: user.id,
      accountsApprovedAt: new Date(),
      accountsNotes: notes || null,
      ...(lossApprovedAt !== null
        ? { lossApprovedAt: new Date(), lossApprovedById: user.id, lossApprovedCost: lossApprovedAt, lossApprovalNote: notes || "Approved with the order" }
        : {}),
    },
  });

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Order", entityId: orderId, entityLabel: formatOrderId(order.orderSeq) });
  if (creditDecision) {
    await recordDecision({ userId: user.id, companyId: order.companyId, orderId, kind: "ORDER", ...creditDecision });
  }

  if (order.addedByUserId !== user.id) {
    await notifyUser({
      userId: order.addedByUserId,
      type: "ORDER_STATUS_CHANGED",
      title: approved ? "Your order was approved" : "Your order was rejected",
      message: `${formatOrderId(order.orderSeq)} — ${order.company.name}`,
      link: orderPath(order.orderSeq),
    });
  }

  /**
   * Purchase hears about an order the moment it can act on it: approved and released. An order punched
   * to go now reaches them here; a held one only when sales lets it go (`releaseOrder`), and one whose
   * scheduled day has already come is released now and announced by that.
   */
  if (approved) {
    const releasedNow = await releaseDueOrders(new Date(), [orderId]);
    if (releasedNow.length === 0 && order.purchaseRelease === "RELEASED") {
      await tellPurchase({ id: orderId, orderSeq: order.orderSeq, companyName: order.company.name }, "approved by accounts.", user.id);
    }
  }

  // Booked now: a new customer's first order, or the order that tips somebody past target.
  if (approved) await detectSalesWins().catch((err) => console.error("sales wins could not be detected", err));
  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/companies/${order.companyId}`);
  return { ok: true, data: { id: orderId } };
}

/** Clears a price increase waiting for sales — every field of it, as the database insists (all or none). */
const NO_PENDING_INCREASE = {
  pendingPurchasePrice: null,
  pendingVendorId: null,
  priceIncreaseReason: null,
  priceReviewRequestedAt: null,
  priceReviewRequestedById: null,
} as const;

/**
 * Purchase team sets the vendor, cost price, and our PO once an order is approved — and released: an
 * order sales is still holding (or has scheduled for a later day) isn't theirs yet.
 *
 * Against the salesperson's distributor price, when there is one:
 *
 *   · at or below it, the order is processed as it always was, and the difference × quantity is
 *     recorded as this purchaser's saving (`PurchaseSaving`);
 *   · above it, a reason is required and the order is **not** processed: the price waits for the
 *     salesperson to accept it (`acceptPriceIncrease`) or send it back (`sendBackPriceIncrease`).
 *
 * No distributor price, or one the purchaser entered themselves, is processed as always, with no
 * saving (owner decision O-D1).
 */
export async function processOrder(input: unknown): Promise<ActionResult<{ id: string; awaitingSales: boolean }>> {
  const user = await requireModuleUser("orders");
  if (!(await hasEffectivePermission(user.id, "orders.process"))) {
    return { ok: false, error: "You don't have permission to process orders." };
  }
  const parsed = processOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orderId, vendorId, purchasePrice, ourPoNumber, increaseReason } = parsed.data;

  // Purchase's queue releases a scheduled order whose day has come, whether or not the job has run yet.
  const now = new Date();
  const clock = await workspaceClock();
  await releaseDueOrders(now, [orderId]);
  const order = await visibleOrder(user.id, orderId);
  if (!order) {
    return { ok: false, error: "Order not found." };
  }
  if (order.orderStatus !== "APPROVED" && order.orderStatus !== "PROCESSING") {
    return { ok: false, error: "This order isn't ready for purchasing yet — it needs accounts approval first." };
  }
  if (order.purchaseRelease !== "RELEASED") {
    return {
      ok: false,
      error:
        order.purchaseRelease === "HELD"
          ? "Sales is holding this order — it hasn't been sent to purchase yet."
          : `This order goes to purchase on ${order.releaseOn ? shortDay(order.releaseOn, clock, now) : "its scheduled day"} — it can't be processed before then.`,
    };
  }
  const vendor = await db.company.findUnique({ where: { id: vendorId } });
  if (!vendor || !isVendorRelationshipType(vendor.relationshipType)) {
    return { ok: false, error: "That's not a valid vendor." };
  }

  const quote = num(order.quotedPurchasePrice);
  const ceiling = priceCeiling(
    { quotedPurchasePrice: quote, quotedById: order.quotedById, orderStatus: order.orderStatus, purchasePrice: num(order.purchasePrice) },
    user.id,
  );
  const label = formatOrderId(order.orderSeq);

  if (needsSalesApproval(ceiling, purchasePrice)) {
    const reason = (increaseReason ?? "").trim();
    const over = Math.round((purchasePrice - ceiling!) * 100) / 100;
    const against = ceiling === quote ? "the salesperson's distributor price" : "the price sales accepted";
    if (reason.length < MIN_INCREASE_REASON) {
      return {
        ok: false,
        error: `That's ${rupees(over)} above ${against} (${rupees(ceiling!)}). Say why — at least ${MIN_INCREASE_REASON} characters — and sales will be asked to accept it.`,
      };
    }
    await db.$transaction(async (tx) => {
      await tx.companyProduct.update({
        where: { id: orderId },
        data: {
          pendingPurchasePrice: new Prisma.Decimal(purchasePrice),
          pendingVendorId: vendorId,
          priceIncreaseReason: reason,
          priceReviewRequestedAt: now,
          priceReviewRequestedById: user.id,
        },
      });
      await tx.orderPriceChange.create({
        data: {
          companyProductId: orderId,
          event: "INCREASE_REQUESTED",
          fromPrice: new Prisma.Decimal(ceiling!),
          toPrice: new Prisma.Decimal(purchasePrice),
          vendorId,
          reason,
          byUserId: user.id,
          at: now,
        },
      });
    });
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "Order",
      entityId: orderId,
      entityLabel: `${label} — asked sales to accept ${rupees(purchasePrice)} from ${vendor.name}, ${rupees(over)} above ${rupees(ceiling!)}`,
    });
    if (order.addedByUserId !== user.id) {
      await notifyUser({
        userId: order.addedByUserId,
        type: "ORDER_STATUS_CHANGED",
        title: `${label}: purchase needs a higher price`,
        message: `Purchase can get this at ${rupees(purchasePrice)}, ${rupees(over)} above ${ceiling === quote ? "your distributor's price" : "the price you accepted"}: ${reason}`,
        link: orderPath(order.orderSeq),
      });
    }
    revalidatePath("/orders");
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, data: { id: orderId, awaitingSales: true } };
  }

  /**
   * Bought at a price that puts the order below cost, and not approved at that cost: whoever holds
   * `orders.approveLoss` approves it by buying it (never on their own order); anybody else is stopped,
   * and the approvers are told.
   */
  const lossNeed = await lossNeeded(order, { cost: purchasePrice, from: "PURCHASE" });
  if (lossNeed && (order.addedByUserId === user.id || !(await hasEffectivePermission(user.id, "orders.approveLoss")))) {
    await recordLossRequest(order, purchasePrice, now);
    await askForLossApproval(order, lossNeed, user.id);
    return { ok: false, error: `${lossWords(label, lossNeed)} The approvers have been told — once one approves it on the order, buy it.` };
  }

  // A re-save that only adds the PO number is not a new purchase: the price's history and the saving
  // (and the period it counts in) stay as they were.
  const priceChanged =
    order.orderStatus !== "PROCESSING" || order.vendorId !== vendorId || num(order.purchasePrice) !== purchasePrice;
  const benchmark = ceiling === null ? null : quote;
  await db.$transaction(async (tx) => {
    await tx.companyProduct.update({
      where: { id: orderId },
      data: {
        vendorId,
        purchasePrice,
        ourPoNumber: ourPoNumber || null,
        purchasedByUserId: user.id,
        orderStatus: "PROCESSING",
        // Found it at or under the price after all: whatever was waiting for sales is overtaken.
        ...NO_PENDING_INCREASE,
        ...(lossNeed
          ? { lossApprovedAt: now, lossApprovedById: user.id, lossApprovedCost: purchasePrice, lossApprovalNote: "Approved while buying it", lossRequestedCost: null, lossRequestedAt: null }
          : {}),
      },
    });
    if (priceChanged) {
      await tx.orderPriceChange.create({
        data: {
          companyProductId: orderId,
          event: "PURCHASED",
          fromPrice: benchmark === null ? null : new Prisma.Decimal(benchmark),
          toPrice: new Prisma.Decimal(purchasePrice),
          vendorId,
          byUserId: user.id,
          at: now,
        },
      });
      if (benchmark !== null) {
        const saving = {
          purchaserId: user.id,
          quotedPrice: new Prisma.Decimal(benchmark),
          actualPrice: new Prisma.Decimal(purchasePrice),
          quantity: order.quantity,
          amount: new Prisma.Decimal(savingAmount(benchmark, purchasePrice, order.quantity)),
          recordedAt: now,
          recordedOn: clock.calendarDate(now),
          cancelledAt: null,
        };
        await tx.purchaseSaving.upsert({ where: { companyProductId: orderId }, create: { companyProductId: orderId, ...saving }, update: saving });
      }
    }
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Order",
    entityId: orderId,
    entityLabel:
      benchmark !== null && priceChanged
        ? `${label} — purchased at ${rupees(purchasePrice)} against a distributor price of ${rupees(benchmark)}`
        : label,
  });

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/companies/${order.companyId}`);
  return { ok: true, data: { id: orderId, awaitingSales: false } };
}

/**
 * The salesperson (or an approver) agrees to purchase's higher price: the order is processed at it, as
 * `processOrder` would have, and the difference is recorded against the purchaser as a negative saving —
 * so the performance view shows what the increase cost rather than nothing at all.
 */
export async function acceptPriceIncrease(orderId: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("orders");
  const order = await visibleOrder(user.id, orderId);
  if (!order) return { ok: false, error: "Order not found." };
  if (!(await speaksForSales(user.id, order))) {
    return { ok: false, error: "Only the salesperson who punched this order, or someone who approves orders, can accept a higher price." };
  }
  if (order.pendingPurchasePrice === null) return { ok: false, error: "There's no higher price waiting on this order." };
  if (order.priceReviewRequestedById === user.id) {
    return { ok: false, error: "You proposed this price — the salesperson, or another approver, decides on it." };
  }
  if (order.orderStatus !== "APPROVED" && order.orderStatus !== "PROCESSING") {
    return { ok: false, error: "This order can't be processed any more." };
  }
  if (!order.pendingVendorId || !order.priceReviewRequestedById) {
    return { ok: false, error: "The vendor or the purchaser behind this price is no longer in the CRM — send it back to purchase." };
  }
  const quote = num(order.quotedPurchasePrice);
  const price = Number(order.pendingPurchasePrice);
  const purchaserId = order.priceReviewRequestedById;
  const vendorId = order.pendingVendorId;
  const now = new Date();
  const clock = await workspaceClock();
  // At the higher price the order may sell below cost: that is a manager's call, not the salesperson's.
  const lossNeed = await lossNeeded(order, { cost: price, from: "PURCHASE" });
  if (lossNeed && (order.addedByUserId === user.id || !(await hasEffectivePermission(user.id, "orders.approveLoss")))) {
    await recordLossRequest(order, price, now);
    await askForLossApproval(order, lossNeed, user.id);
    return { ok: false, error: `${lossWords(formatOrderId(order.orderSeq), lossNeed)} The approvers have been told — once one approves it on the order, accept the price.` };
  }

  await db.$transaction(async (tx) => {
    await tx.companyProduct.update({
      where: { id: orderId },
      data: {
        vendorId,
        purchasePrice: new Prisma.Decimal(price),
        purchasedByUserId: purchaserId,
        orderStatus: "PROCESSING",
        ...NO_PENDING_INCREASE,
        ...(lossNeed
          ? { lossApprovedAt: now, lossApprovedById: user.id, lossApprovedCost: price, lossApprovalNote: "Approved with the higher price", lossRequestedCost: null, lossRequestedAt: null }
          : {}),
      },
    });
    await tx.orderPriceChange.create({
      data: {
        companyProductId: orderId,
        event: "INCREASE_ACCEPTED",
        fromPrice: quote === null ? null : new Prisma.Decimal(quote),
        toPrice: new Prisma.Decimal(price),
        vendorId,
        reason: order.priceIncreaseReason,
        byUserId: user.id,
        at: now,
      },
    });
    if (quote !== null) {
      const saving = {
        purchaserId,
        quotedPrice: new Prisma.Decimal(quote),
        actualPrice: new Prisma.Decimal(price),
        quantity: order.quantity,
        amount: new Prisma.Decimal(savingAmount(quote, price, order.quantity)),
        recordedAt: now,
        recordedOn: clock.calendarDate(now),
        cancelledAt: null,
      };
      await tx.purchaseSaving.upsert({ where: { companyProductId: orderId }, create: { companyProductId: orderId, ...saving }, update: saving });
    }
  });

  const label = formatOrderId(order.orderSeq);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Order", entityId: orderId, entityLabel: `${label} — accepted purchase's price of ${rupees(price)}` });
  await notifyUser({
    userId: purchaserId,
    type: "ORDER_STATUS_CHANGED",
    title: `${label}: higher price accepted`,
    message: `${rupees(price)} was accepted — go ahead with the purchase.`,
    link: orderPath(order.orderSeq),
  });
  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/companies/${order.companyId}`);
  return { ok: true, data: { id: orderId } };
}

/** The salesperson (or an approver) turns purchase's higher price down, with a note: purchase looks again. */
export async function sendBackPriceIncrease(orderId: string, note: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("orders");
  const order = await visibleOrder(user.id, orderId);
  if (!order) return { ok: false, error: "Order not found." };
  if (!(await speaksForSales(user.id, order))) {
    return { ok: false, error: "Only the salesperson who punched this order, or someone who approves orders, can send a price back." };
  }
  if (order.pendingPurchasePrice === null) return { ok: false, error: "There's no higher price waiting on this order." };
  if (order.priceReviewRequestedById === user.id) {
    return { ok: false, error: "You proposed this price — the salesperson, or another approver, decides on it." };
  }
  const why = (note ?? "").trim();
  if (why.length < 3) return { ok: false, error: "Tell purchase what to do instead — a better price, another distributor…" };
  const price = Number(order.pendingPurchasePrice);
  const requesterId = order.priceReviewRequestedById;

  await db.$transaction(async (tx) => {
    await tx.companyProduct.update({ where: { id: orderId }, data: { ...NO_PENDING_INCREASE } });
    await tx.orderPriceChange.create({
      data: {
        companyProductId: orderId,
        event: "SENT_BACK",
        fromPrice: order.quotedPurchasePrice,
        toPrice: new Prisma.Decimal(price),
        vendorId: order.pendingVendorId,
        reason: why.slice(0, 1000),
        byUserId: user.id,
      },
    });
  });

  const label = formatOrderId(order.orderSeq);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Order", entityId: orderId, entityLabel: `${label} — sent purchase's price of ${rupees(price)} back` });
  if (requesterId) {
    await notifyUser({
      userId: requesterId,
      type: "ORDER_STATUS_CHANGED",
      title: `${label}: ${rupees(price)} sent back`,
      message: why,
      link: orderPath(order.orderSeq),
    });
  }
  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, data: { id: orderId } };
}

/**
 * Adds, changes or removes the salesperson's distributor price after punching — until purchase has
 * processed the order. After that it is the benchmark a saving was measured against, and moving it
 * would rewrite somebody's performance.
 */
export async function setOrderQuote(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("orders");
  const parsed = orderQuoteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const order = await visibleOrder(user.id, parsed.data.orderId);
  if (!order) return { ok: false, error: "Order not found." };
  if (!(await speaksForSales(user.id, order))) {
    return { ok: false, error: "Only the salesperson who punched this order, or someone who approves orders, can set its distributor price." };
  }
  if (order.orderStatus !== "PENDING_APPROVAL" && order.orderStatus !== "APPROVED") {
    return { ok: false, error: "The distributor price can't change once purchase has processed the order." };
  }
  if (order.pendingPurchasePrice !== null) {
    return { ok: false, error: "Purchase is waiting on a decision about a higher price — accept it or send it back first." };
  }
  const resolved = await resolveQuote(parsed.data, new Date(), await workspaceClock());
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const quote = resolved.quote;
  const cleared = {
    quotedPurchasePrice: null,
    quoteVendorId: null,
    quoteVendorName: null,
    quoteContact: null,
    quotedOn: null,
    quoteRemarks: null,
    quotedById: null,
  };
  if (!quote && order.quotedPurchasePrice === null) return { ok: true, data: { id: order.id } };

  await db.$transaction(async (tx) => {
    await tx.companyProduct.update({ where: { id: order.id }, data: quote ? { ...quote, quotedById: user.id } : cleared });
    await tx.orderPriceChange.create({
      data: {
        companyProductId: order.id,
        event: "QUOTED",
        fromPrice: order.quotedPurchasePrice,
        toPrice: quote ? quote.quotedPurchasePrice : null,
        vendorId: quote ? quote.quoteVendorId : null,
        reason: quote ? quote.quoteRemarks : "Distributor price removed",
        byUserId: user.id,
      },
    });
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Order",
    entityId: order.id,
    entityLabel: `${formatOrderId(order.orderSeq)} — distributor price ${quote ? `set to ${rupees(Number(quote.quotedPurchasePrice))}` : "removed"}`,
  });
  revalidatePath(`/orders/${order.id}`);
  return { ok: true, data: { id: order.id } };
}

/** Who may move an order's hand-off, and whether it can still move: the checks the three actions below share. */
async function handOffAccess(userId: string, orderId: string) {
  const order = await visibleOrder(userId, orderId);
  if (!order) return { ok: false as const, error: "Order not found." };
  if (!(await speaksForSales(userId, order))) {
    return { ok: false as const, error: "Only the salesperson who punched this order, or someone who approves orders, can decide when it goes to purchase." };
  }
  if (order.orderStatus === "CANCELLED" || order.orderStatus === "REJECTED" || order.orderStatus === "FULFILLED") {
    return { ok: false as const, error: `This order is ${order.orderStatus.toLowerCase()}.` };
  }
  if (order.purchaseRelease === "RELEASED") return { ok: false as const, error: "This order is already with purchase." };
  return { ok: true as const, order };
}

/**
 * Sends a held or scheduled order to purchase now. With no payment against it yet, it counts as booked
 * from this moment (O-D2); purchase is told if accounts has already approved it.
 */
export async function releaseOrder(orderId: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("orders");
  const access = await handOffAccess(user.id, orderId);
  if (!access.ok) return { ok: false, error: access.error };
  const { order } = access;
  const now = new Date();

  const claim = await db.companyProduct.updateMany({
    where: { id: orderId, purchaseRelease: { in: ["HELD", "SCHEDULED"] } },
    data: { purchaseRelease: "RELEASED", releaseOn: null, releasedAt: now, releasedById: user.id },
  });
  if (claim.count !== 1) return { ok: false, error: "This order is already with purchase." };
  const booked = await db.companyProduct.updateMany({ where: { id: orderId, bookedAt: null }, data: { bookedAt: now } });

  const label = formatOrderId(order.orderSeq);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Order", entityId: orderId, entityLabel: `${label} — sent to purchase` });
  if (order.orderStatus === "APPROVED") {
    await tellPurchase({ id: orderId, orderSeq: order.orderSeq, companyName: order.company.name }, "sales has sent it to purchase.", user.id);
  }
  if (booked.count > 0) await detectSalesWins().catch((err) => console.error("sales wins could not be detected", err));
  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/companies/${order.companyId}`);
  return { ok: true, data: { id: orderId } };
}

/** Schedules a held (or already scheduled) order to go to purchase on a day after today, on the workspace's calendar. */
export async function scheduleRelease(orderId: string, date: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("orders");
  const access = await handOffAccess(user.id, orderId);
  if (!access.ok) return { ok: false, error: access.error };
  const now = new Date();
  const clock = await workspaceClock();
  const day = checkReleaseDate(date, now, clock);
  if (!day.ok) return { ok: false, error: day.error };

  const moved = await db.companyProduct.updateMany({
    where: { id: orderId, purchaseRelease: { in: ["HELD", "SCHEDULED"] } },
    data: { purchaseRelease: "SCHEDULED", releaseOn: day.day },
  });
  if (moved.count !== 1) return { ok: false, error: "This order is already with purchase." };
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Order",
    entityId: orderId,
    entityLabel: `${formatOrderId(access.order.orderSeq)} — goes to purchase on ${shortDay(day.day, clock, now)}`,
  });
  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, data: { id: orderId } };
}

/** Takes a scheduled order off its schedule: held, until sales decides. */
export async function holdOrder(orderId: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("orders");
  const access = await handOffAccess(user.id, orderId);
  if (!access.ok) return { ok: false, error: access.error };
  if (access.order.purchaseRelease === "HELD") return { ok: false, error: "This order is already held." };

  const moved = await db.companyProduct.updateMany({
    where: { id: orderId, purchaseRelease: "SCHEDULED" },
    data: { purchaseRelease: "HELD", releaseOn: null },
  });
  if (moved.count !== 1) return { ok: false, error: "This order is already with purchase." };
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Order",
    entityId: orderId,
    entityLabel: `${formatOrderId(access.order.orderSeq)} — held; its scheduled day was dropped`,
  });
  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, data: { id: orderId } };
}

/** Purchase team marks the order complete — this is what makes it a normal, fully-live line in the customer's Products & Subscriptions. */
export async function fulfillOrder(orderId: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("orders");
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
  if (order.purchaseRelease !== "RELEASED") {
    return { ok: false, error: "Sales hasn't sent this order to purchase yet." };
  }
  if (order.pendingPurchasePrice !== null) {
    return { ok: false, error: "A higher price is waiting for sales to accept — settle that first." };
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
        link: orderPath(order.orderSeq),
      }),
    ),
  );

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/companies/${order.companyId}`);
  revalidatePath("/renewals");
  return { ok: true, data: null };
}

/**
 * Cancels an order, by where it had got to:
 *
 *   · **Held or scheduled** — cancels cleanly: the scheduled day is dropped and purchase never hears of it.
 *   · **With purchase, not yet processed** — a reason is required; it leaves purchase's queue, and if it
 *     was in that queue (approved), everyone who processes orders is told.
 *   · **Processing** (a vendor chosen, our PO issued) — a reason is required, the purchaser is told, and
 *     the order shows "Vendor PO to cancel" until they say what became of it (`settleVendorPo`).
 *   · **Fulfilled** — can't be: a return goes through a credit note.
 *
 * In every case, in one transaction: a price increase waiting for sales is cleared; the purchase saving
 * is marked cancelled (kept, struck through, and never counted — see `PurchaseSaving.cancelledAt`); and
 * any payment against the order moves on account (O-D3): its allocations are released, so the money is
 * the customer's unapplied balance, and accounts is told to refund it or apply it to another order. No
 * ledger entry — the receipt already sits in receivables as received; only its application changes.
 */
export async function cancelOrder(orderId: string, reason?: string): Promise<ActionResult<{ movedOnAccount: number }>> {
  const user = await requireModuleUser("orders");
  const order = await visibleOrder(user.id, orderId);
  if (!order) {
    return { ok: false, error: "Order not found." };
  }
  if (order.orderStatus === "FULFILLED") {
    return { ok: false, error: "A fulfilled order can't be cancelled — a return goes through a credit note." };
  }
  if (order.orderStatus === "CANCELLED") {
    return { ok: false, error: "This order can no longer be cancelled." };
  }
  const [canApprove, canProcess] = await Promise.all([
    hasEffectivePermission(user.id, "orders.approve"),
    hasEffectivePermission(user.id, "orders.process"),
  ]);
  if (order.addedByUserId !== user.id && !canApprove && !canProcess) {
    return { ok: false, error: "You don't have permission to cancel this order." };
  }

  const why = (reason ?? "").trim();
  const withPurchase = order.purchaseRelease === "RELEASED";
  const processing = order.orderStatus === "PROCESSING";
  if (withPurchase && why.length < 3) {
    return {
      ok: false,
      error: processing
        ? "Say why it's being cancelled — the purchaser is told, and has a vendor PO to cancel."
        : "Say why it's being cancelled — it's already with purchase.",
    };
  }

  const now = new Date();
  let moved: number;
  try {
    moved = await db.$transaction(async (tx) => {
      const changed = await tx.companyProduct.updateMany({
        where: { id: orderId, orderStatus: { notIn: ["CANCELLED", "FULFILLED"] } },
        data: {
          orderStatus: "CANCELLED",
          accountsNotes: why ? `Cancelled: ${why}` : order.accountsNotes,
          cancelledAt: now,
          cancelledById: user.id,
          cancelReason: why || null,
          vendorPoCancel: processing ? "PENDING" : null,
          // The scheduled go-ahead is dropped: it never went to purchase, and now never will.
          ...(order.purchaseRelease === "SCHEDULED" ? { purchaseRelease: "HELD" as const, releaseOn: null } : {}),
          ...NO_PENDING_INCREASE,
        },
      });
      if (changed.count !== 1) throw new Error("ORDER_MOVED_ON");
      const allocations = await tx.paymentAllocation.findMany({ where: { companyProductId: orderId }, select: { id: true, amount: true } });
      if (allocations.length > 0) await tx.paymentAllocation.deleteMany({ where: { id: { in: allocations.map((a) => a.id) } } });
      await tx.purchaseSaving.updateMany({ where: { companyProductId: orderId, cancelledAt: null }, data: { cancelledAt: now } });
      return Math.round(allocations.reduce((t, a) => t + Number(a.amount), 0) * 100) / 100;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "ORDER_MOVED_ON") return { ok: false, error: "This order can no longer be cancelled." };
    throw err;
  }

  const label = formatOrderId(order.orderSeq);
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Order",
    entityId: orderId,
    entityLabel: `${label} cancelled${why ? `: ${why}` : ""}${moved > 0 ? ` · ${rupees(moved)} moved on account` : ""}`,
  });

  const said = why ? `: ${why}` : ".";
  if (processing && order.purchasedByUserId && order.purchasedByUserId !== user.id) {
    await notifyUser({
      userId: order.purchasedByUserId,
      type: "ORDER_STATUS_CHANGED",
      title: `${label} was cancelled — cancel our vendor PO`,
      message: `${order.company.name}${said} Mark on the order what became of the PO.`,
      link: orderPath(order.orderSeq),
    });
  } else if (withPurchase && order.orderStatus === "APPROVED") {
    const holders = await peopleHolding("orders.process", [user.id]);
    await Promise.all(
      holders.map((userId) =>
        notifyUser({ userId, type: "ORDER_STATUS_CHANGED", title: `${label} was cancelled`, message: `${order.company.name}${said}`, link: orderPath(order.orderSeq) }),
      ),
    );
  }
  if (order.addedByUserId !== user.id) {
    await notifyUser({
      userId: order.addedByUserId,
      type: "ORDER_STATUS_CHANGED",
      title: "Your order was cancelled",
      message: `${label} — ${order.company.name}${said}`,
      link: orderPath(order.orderSeq),
    });
  }
  if (moved > 0) {
    const accounts = await peopleHolding("payments.record", [user.id]);
    await Promise.all(
      accounts.map((userId) =>
        notifyUser({
          userId,
          type: "ORDER_STATUS_CHANGED",
          title: `${rupees(moved)} is on account for ${order.company.name}`,
          message: `${label} was cancelled with payment against it. Refund it, or apply it to another order.`,
          link: `${companyPath(order.company.companySeq)}?tab=payments`,
        }),
      ),
    );
  }

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/companies/${order.companyId}`);
  revalidatePath("/payments");
  return { ok: true, data: { movedOnAccount: moved } };
}

/** The purchaser says what became of our vendor PO on a cancelled order: cancelled with the vendor, or never needed. */
export async function settleVendorPo(orderId: string, outcome: "CANCELLED" | "NOT_NEEDED"): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("orders");
  if (!(await hasEffectivePermission(user.id, "orders.process"))) {
    return { ok: false, error: "Only purchase can settle a vendor PO." };
  }
  if (outcome !== "CANCELLED" && outcome !== "NOT_NEEDED") return { ok: false, error: "Say whether the PO was cancelled or wasn't needed." };
  const order = await visibleOrder(user.id, orderId);
  if (!order) return { ok: false, error: "Order not found." };
  const settled = await db.companyProduct.updateMany({
    where: { id: orderId, vendorPoCancel: "PENDING" },
    data: { vendorPoCancel: outcome, vendorPoSettledAt: new Date(), vendorPoSettledById: user.id },
  });
  if (settled.count !== 1) return { ok: false, error: "There's no vendor PO waiting to be cancelled on this order." };
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Order",
    entityId: orderId,
    entityLabel: `${formatOrderId(order.orderSeq)} — vendor PO ${outcome === "CANCELLED" ? "cancelled" : "cancellation not needed"}`,
  });
  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, data: { id: orderId } };
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
  /**
   * The hand-off views: sales's in-hand orders (held or scheduled), purchase's queue (approved and
   * released), orders waiting on sales to accept a higher price, and cancelled orders whose vendor PO
   * purchase still has to deal with.
   */
  flag?: OrderListFlag;
  /** The workspace's own order fields filtered on, as the page read them (src/lib/custom-fields/filters.ts). */
  customFilters?: CustomFilterInputs;
  /** A step of the workspace's own within a status, by its key (Settings → Pipeline → Orders). */
  step?: string;
};

const ORDER_LIST_FLAGS = ["held", "ready", "review", "vendorPo"] as const;
type OrderListFlag = (typeof ORDER_LIST_FLAGS)[number];

const flagWhere: Record<OrderListFlag, Prisma.CompanyProductWhereInput> = {
  held: { purchaseRelease: { in: ["HELD", "SCHEDULED"] }, orderStatus: { notIn: ["CANCELLED", "REJECTED", "FULFILLED"] } },
  ready: { orderStatus: "APPROVED", purchaseRelease: "RELEASED", pendingPurchasePrice: null },
  review: { pendingPurchasePrice: { not: null } },
  vendorPo: { vendorPoCancel: "PENDING" },
};

/** The orders a step of the workspace's own shows (`inStepWhere`), by its key. A key it doesn't have narrows nothing. */
async function atStep(key: string | undefined): Promise<Prisma.CompanyProductWhereInput[]> {
  if (!key) return [];
  const data = await orderSteps();
  const step = data.steps.find((s) => s.key === key);
  return step ? [inStepWhere(data, step)] : [];
}

async function orderListWhere(
  userId: string,
  params?: OrderListParams,
): Promise<Prisma.CompanyProductWhereInput> {
  // The reseller filter narrows the related company. The search is its own clause: the customer's
  // name, or one of the workspace's own order fields this person may see (src/lib/custom-fields).
  const companyFilter = {
    ...(params?.viaReseller === true ? { relationshipType: "RESELLER" as const } : {}),
    ...(params?.viaReseller === false ? { relationshipType: { not: "RESELLER" as const } } : {}),
  };
  const search: Prisma.CompanyProductWhereInput[] = params?.search
    ? [
        {
          OR: [
            { company: { name: { contains: params.search, mode: "insensitive" as const } } },
            ...((await customSearchWhere("ORDER", userId, params.search)) as Prisma.CompanyProductWhereInput[]),
          ],
        },
      ]
    : [];
  // The field filters, a clause each in the same `AND` — one can be an `OR` of its own.
  const fieldFilters = (await customFilterWhere("ORDER", userId, params?.customFilters)) as Prisma.CompanyProductWhereInput[];
  return {
    /**
     * An order reaches its account directly — `CompanyProduct.companyId` is the customer we
     * invoice, which stays the reseller on a reseller's order.
     *
     * It goes in `AND` rather than being spread, because the scope narrows the same `company`
     * relation `companyFilter` does and a second `company` key in this literal would keep only
     * whichever was written last: exactly the silent drop the comment above is about, except that
     * losing this one loses the scope. The access engine answers it (`orderAccess`): `{}` for an
     * unrestricted viewer, and `AND: [{}]` is no condition at all.
     */
    AND: [await orderAccess(userId, "view"), ...search, ...fieldFilters, ...(await atStep(params?.step))],
    ...(params?.status ? { orderStatus: params.status } : {}),
    ...(params?.businessType ? { businessType: params.businessType } : {}),
    ...(params?.companyId ? { companyId: params.companyId } : {}),
    ...(params?.endCustomerId ? { endCustomerId: params.endCustomerId } : {}),
    ...(Object.keys(companyFilter).length > 0 ? { company: companyFilter } : {}),
    ...(params?.flag && ORDER_LIST_FLAGS.includes(params.flag) ? flagWhere[params.flag] : {}),
  };
}

const orderListInclude = {
  company: { select: { id: true, companySeq: true, name: true, relationshipType: true } },
  endCustomer: { select: { id: true, name: true } },
  item: { select: { id: true, name: true, sku: true, unit: true, sellingPrice: true, taxRatePercent: true } },
  vendor: { select: { id: true, name: true } },
  addedBy: { select: { id: true, name: true } },
  allocations: { select: { amount: true } },
} as const;

export async function listOrders(params?: OrderListParams) {
  const user = await requireModuleUser("orders");
  if (!(await viewerHas("orders.view"))) return [];
  return db.companyProduct.findMany({
    where: await orderListWhere(user.id, params),
    orderBy: { createdAt: "desc" },
    include: orderListInclude,
  });
}

export async function listOrdersPaged(params: OrderListParams & { page: number; pageSize: number }) {
  const user = await requireModuleUser("orders");
  if (!(await viewerHas("orders.view"))) return { rows: [], total: 0, pendingApproval: 0 };
  // Purchase's queue releases scheduled orders whose day has come as it loads, so a missed tick of the
  // daily job never holds one back. The schedule does the releasing, not whoever opened the list.
  await releaseDueOrders();
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

/**
 * A manager approves selling an order below cost — a negative call (owner, 1 Oct 2026) — at the cost
 * it would go on at now: a higher price waiting for sales, else the best known. Never on their own
 * order. Buying it later for more needs approving again.
 */
export async function approveOrderLoss(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("orders");
  if (!(await hasEffectivePermission(user.id, "orders.approveLoss"))) {
    return { ok: false, error: "You can't approve selling below cost." };
  }
  const parsed = approveLossSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const order = await visibleOrder(user.id, parsed.data.orderId);
  if (!order) return { ok: false, error: "Order not found." };
  try {
    assertNotOwnRecord("orders.approveLoss", user.id, order.addedByUserId);
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.message };
    throw err;
  }
  if (order.orderStatus === "CANCELLED" || order.orderStatus === "REJECTED" || order.orderStatus === "FULFILLED") {
    return { ok: false, error: "This order isn't going ahead any more." };
  }
  /**
   * The highest cost in play: what purchase (or sales) was stopped at, a higher price waiting for sales,
   * the best known, or one the manager names — so whoever was stopped can go ahead.
   */
  const known = unitCostOf({ purchasePrice: num(order.purchasePrice), dealPrice: num(order.dealPrice), quotedPurchasePrice: num(order.quotedPurchasePrice) });
  const candidates: { cost: number; from: CostSource }[] = [
    ...(known ? [known] : []),
    ...(order.lossRequestedCost !== null ? [{ cost: Number(order.lossRequestedCost), from: "PURCHASE" as const }] : []),
    ...(order.pendingPurchasePrice !== null ? [{ cost: Number(order.pendingPurchasePrice), from: "PURCHASE" as const }] : []),
    ...(parsed.data.upToCost !== undefined ? [{ cost: parsed.data.upToCost, from: "PURCHASE" as const }] : []),
  ];
  const highest = candidates.sort((a, b) => b.cost - a.cost)[0];
  const need = highest ? await lossNeeded(order, highest) : null;
  if (!need) return { ok: false, error: "This order isn't sold below cost — there's nothing to approve." };
  const now = new Date();
  await db.companyProduct.update({
    where: { id: order.id },
    data: {
      lossApprovedAt: now,
      lossApprovedById: user.id,
      lossApprovedCost: need.cost,
      lossApprovalNote: parsed.data.note,
      lossRequestedCost: null,
      lossRequestedAt: null,
    },
  });
  const label = formatOrderId(order.orderSeq);
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Order",
    entityId: order.id,
    entityLabel: `${label} — selling below cost approved at ${rupees(need.cost)} a unit (sells at ${rupees(need.unitPrice)}): ${parsed.data.note}`,
  });
  const told = new Set([order.addedByUserId, order.priceReviewRequestedById].filter((id): id is string => !!id && id !== user.id));
  await Promise.all(
    [...told].map((userId) =>
      notifyUser({
        userId,
        type: "ORDER_STATUS_CHANGED",
        title: `${label}: selling below cost approved`,
        message: `Approved at ${rupees(need.cost)} a unit — it can go ahead.`,
        link: orderPath(order.orderSeq),
      }),
    ),
  );
  revalidatePath("/orders");
  revalidatePath(`/orders/${order.id}`);
  return { ok: true, data: { id: order.id } };
}

/**
 * The deal registration and deal price on an order already punched — by the salesperson (or an
 * approver) or by purchase, until it is fulfilled. Recorded for information: nothing waits on it.
 */
export async function setOrderDeal(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("orders");
  const parsed = orderDealSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;
  const order = await visibleOrder(user.id, data.orderId);
  if (!order) return { ok: false, error: "Order not found." };
  if (!(await speaksForSales(user.id, order)) && !(await hasEffectivePermission(user.id, "orders.process"))) {
    return { ok: false, error: "Only the salesperson, an approver or purchase can change the deal registration." };
  }
  if (order.orderStatus === "CANCELLED" || order.orderStatus === "REJECTED" || order.orderStatus === "FULFILLED") {
    return { ok: false, error: "This order can't be changed any more." };
  }
  await db.companyProduct.update({
    where: { id: order.id },
    data: {
      dealRegStatus: data.dealRegStatus || null,
      dealRegNumber: data.dealRegNumber || null,
      dealRegValidTo: data.dealRegValidTo ? calendarDay(data.dealRegValidTo) : null,
      dealPrice: data.dealPrice ?? null,
    },
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Order",
    entityId: order.id,
    entityLabel: `${formatOrderId(order.orderSeq)} — deal registration ${data.dealRegStatus ? data.dealRegStatus.toLowerCase() : "cleared"}${data.dealRegNumber ? ` (${data.dealRegNumber})` : ""}${data.dealPrice !== undefined ? `, deal price ${rupees(data.dealPrice)}` : ""}`,
  });
  revalidatePath(`/orders/${order.id}`);
  return { ok: true, data: { id: order.id } };
}

/**
 * The order's own fields (src/lib/custom-fields), from the "More details" card on its page — bound to
 * the order there. Whoever may change its deal registration may change them, as `setOrderDeal` decides
 * it: the salesperson who punched it or an approver, or purchase, until it is fulfilled.
 */
export async function updateOrderCustomFields(orderId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("orders");
  // Bound on the order's page, but an action can be called with anything: the id is checked like any input.
  if (typeof orderId !== "string" || !orderId) return { ok: false, error: "Order not found." };
  const order = await visibleOrder(user.id, orderId);
  if (!order) return { ok: false, error: "Order not found." };
  if (!(await speaksForSales(user.id, order)) && !(await hasEffectivePermission(user.id, "orders.process"))) {
    return { ok: false, error: "Only the salesperson, an approver or purchase can change this order's details." };
  }
  if (order.orderStatus === "CANCELLED" || order.orderStatus === "REJECTED" || order.orderStatus === "FULFILLED") {
    return { ok: false, error: "This order can't be changed any more." };
  }
  const saved = await saveCustomFields("ORDER", order.id, user.id, input);
  if (!saved.ok) return saved;
  if (saved.changed.length > 0) {
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "Order",
      entityId: order.id,
      entityLabel: `${formatOrderId(order.orderSeq)}${changedLabel(saved.changed)}`,
    });
    revalidatePath("/orders");
    revalidatePath(`/orders/${order.id}`);
  }
  return { ok: true, data: null };
}

export async function getOrder(id: string) {
  const user = await requireModuleUser("orders");
  if (!(await viewerHas("orders.view"))) return null;
  // A scheduled order whose day has come is released before anybody reads it as still waiting.
  await releaseDueOrders(new Date(), [id]);
  // Scoped in the `where` so the include stays exactly as the detail page expects it, and so an
  // order on somebody else's account answers the same way a made-up id does. This page carries the
  // purchase price and the vendor as well as the sale, which is more than the list ever shows.
  // The access engine answers the scope (`orderAccess`), the same fragment the list takes.
  const order = await db.companyProduct.findFirst({
    where: { AND: [{ id }, await orderAccess(user.id, "view")] },
    include: {
      company: { select: { id: true, companySeq: true, name: true, paymentTerms: true, relationshipType: true, customerCategory: { select: CATEGORY_SELECT } } },
      endCustomer: { select: { id: true, companySeq: true, name: true } },
      location: { select: { id: true, label: true } },
      item: {
        select: { id: true, name: true, sku: true, unit: true, sellingPrice: true, taxRatePercent: true, costPrice: true, type: true },
      },
      vendor: { select: { id: true, companySeq: true, name: true, paymentTerms: true } },
      proposal: { select: { id: true, status: true } },
      addedBy: { select: { id: true, name: true } },
      accountsApprovedBy: { select: { id: true, name: true } },
      lossApprovedBy: { select: { id: true, name: true } },
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
      releasedBy: { select: { id: true, name: true } },
      quoteVendor: { select: { id: true, companySeq: true, name: true } },
      quotedBy: { select: { id: true, name: true } },
      pendingVendor: { select: { id: true, name: true } },
      priceReviewRequestedBy: { select: { id: true, name: true } },
      cancelledBy: { select: { id: true, name: true } },
      vendorPoSettledBy: { select: { id: true, name: true } },
      priceChanges: { orderBy: { at: "asc" }, include: { byUser: { select: { id: true, name: true } } } },
      purchaseSaving: { include: { purchaser: { select: { id: true, name: true } } } },
    },
  });
  if (!order) return null;
  // The price history keeps a vendor as a bare id (a vendor deleted later mustn't erase the step), so
  // the names are looked up for display — and a gone one reads as such rather than as nothing.
  const vendorIds = [...new Set(order.priceChanges.map((c) => c.vendorId).filter((v): v is string => !!v))];
  const vendors = vendorIds.length
    ? await db.company.findMany({ where: { id: { in: vendorIds } }, select: { id: true, name: true } })
    : [];
  const vendorName = new Map(vendors.map((v) => [v.id, v.name]));
  return toPlain({
    ...order,
    priceChanges: order.priceChanges.map((c) => ({
      ...c,
      vendorName: c.vendorId ? (vendorName.get(c.vendorId) ?? "a vendor no longer in the CRM") : null,
    })),
  });
}

/** Proposals belonging to leads of this company, for the order-punch "link to proposal" picker. */
export async function listProposalOptions(companyId: string) {
  const user = await requireModuleUser("orders");
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
  const user = await requireModuleUser("orders");
  const existing = await db.companyProduct.findFirst({
    // Scoped as well as filtered by id: unscoped, this is a yes/no oracle over the whole order
    // book — pass a company id and an item id and it answers whether that account buys that
    // product. Out of scope it answers "no", which is what the form does for a brand-new sale.
    where: { companyId, itemId, ...(await viaCompanyScope(user.id)), orderStatus: { notIn: ["REJECTED", "CANCELLED"] } },
    select: { id: true },
  });
  return !!existing;
}

/**
 * What purchase saved against salespeople's distributor prices, by person and month — the "Purchase
 * savings" report. Savings and accepted increases are added up separately, because a net figure hides
 * a purchaser who saves on most orders and gives it all back on one.
 *
 * Everyone's to anybody who can see team performance or approves orders; a purchaser sees their own.
 * `from`/`to` are calendar days (`yyyy-mm-dd`), matched against the workspace's day each saving was
 * recorded on — a `@db.Date`, so compared by calendar day, both ends included; either left out is open, as the
 * date-range picker's "All time" is. A saving on a cancelled order is listed, struck through, and
 * counted nowhere.
 */
export async function purchaseSavingsReport(params: { from?: string; to?: string }) {
  const user = await requireModuleUser("orders");
  if (!(await viewerHas("orders.view"))) return null;
  const [seesPerformance, approves, purchases] = await Promise.all([
    viewerHas("performance.view"),
    viewerHas("orders.approve"),
    viewerHas("orders.process"),
  ]);
  const everyone = seesPerformance || approves;
  if (!everyone && !purchases) return null;

  const from = params.from ? calendarDay(params.from) : null;
  const to = params.to ? calendarDay(params.to) : null;
  const scope = await viaCompanyScope(user.id);

  const rows = await db.purchaseSaving.findMany({
    where: {
      ...(from || to ? { recordedOn: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(everyone ? {} : { purchaserId: user.id }),
      ...(Object.keys(scope).length ? { companyProduct: scope as Prisma.CompanyProductWhereInput } : {}),
    },
    orderBy: [{ recordedOn: "desc" }, { recordedAt: "desc" }],
    include: {
      purchaser: { select: { id: true, name: true } },
      companyProduct: {
        select: {
          id: true,
          orderSeq: true,
          orderStatus: true,
          company: { select: { name: true } },
          item: { select: { name: true } },
          addedBy: { select: { name: true } },
        },
      },
    },
  });

  type Bucket = { purchaserId: string; purchaser: string; month: string; savings: number; increases: number; lines: number };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    if (r.cancelledAt) continue;
    const month = r.recordedOn.toISOString().slice(0, 7);
    const key = `${r.purchaserId}|${month}`;
    const b = buckets.get(key) ?? { purchaserId: r.purchaserId, purchaser: r.purchaser.name, month, savings: 0, increases: 0, lines: 0 };
    const amount = Number(r.amount);
    if (amount >= 0) b.savings += amount;
    else b.increases += amount;
    b.lines += 1;
    buckets.set(key, b);
  }
  const summary = [...buckets.values()]
    .map((b) => ({ ...b, savings: Math.round(b.savings * 100) / 100, increases: Math.round(b.increases * 100) / 100, net: Math.round((b.savings + b.increases) * 100) / 100 }))
    .sort((a, b) => b.month.localeCompare(a.month) || a.purchaser.localeCompare(b.purchaser));

  return {
    /** The days asked for, as `yyyy-mm-dd`, or null where the range is open. */
    from: from ? from.toISOString().slice(0, 10) : null,
    to: to ? to.toISOString().slice(0, 10) : null,
    everyone,
    summary,
    lines: rows.map((r) => ({
      id: r.id,
      recordedOn: r.recordedOn.toISOString().slice(0, 10),
      purchaser: r.purchaser.name,
      orderId: r.companyProduct.id,
      orderSeq: r.companyProduct.orderSeq,
      customer: r.companyProduct.company.name,
      item: r.companyProduct.item.name,
      salesperson: r.companyProduct.addedBy.name,
      quotedPrice: Number(r.quotedPrice),
      actualPrice: Number(r.actualPrice),
      quantity: r.quantity,
      amount: Number(r.amount),
      cancelled: !!r.cancelledAt,
    })),
  };
}
