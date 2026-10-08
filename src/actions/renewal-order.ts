"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { hasEffectivePermission } from "@/actions/permission";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { resellerOrderRefusal } from "@/lib/orders/reseller-gate";
import { renewalGroup } from "@/lib/subscriptions/proration";
import { renewalOrderDraft } from "@/lib/subscriptions/renewal-order";
import { formatOrderId } from "@/lib/order-id";
import type { ActionResult } from "@/actions/company";

/**
 * Punching the order that replaces an expiring subscription.
 *
 * Raised from the renewals list rather than the blank order form, because everything about it is
 * already known — the customer, the site, the product, the seats including any added mid-term, and
 * the full-term price. Retyping all that is how a renewal gets punched for ten seats when the
 * customer has twenty.
 *
 * It goes through the ordinary approval route. A renewal is a sale, and the margin on it matters as
 * much as on a new one.
 */

async function access() {
  const user = await requireModuleUser("renewals");
  const allowed =
    (await hasEffectivePermission(user.id, "products.edit")) ||
    (await hasEffectivePermission(user.id, "orders.process"));
  return { user, allowed };
}

/**
 * The subscription and everything co-terminating with it — null when it doesn't exist or its account
 * is not this person's to see (`canSeeCompany`, as punching an order is scoped): the same answer for
 * both, so an id can't be used to find out which subscriptions are real.
 */
async function loadForRenewal(id: string, userId: string) {
  const product = await db.companyProduct.findUnique({
    where: { id },
    include: {
      company: { select: { id: true, name: true, relationshipType: true, ownerUserId: true } },
      item: { select: { id: true, name: true, billingCycle: true, unit: true } },
      location: { select: { id: true, label: true } },
      endCustomer: { select: { id: true, name: true } },
      renewedBy: { select: { id: true, orderSeq: true, orderStatus: true } },
      addons: {
        where: { orderStatus: { not: "CANCELLED" } },
        select: { id: true, quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true },
      },
    },
  });
  if (!product || !(await canSeeCompany(userId, product.company))) return null;

  const group = renewalGroup([
    {
      id: product.id,
      quantity: product.quantity,
      unitPrice: product.unitPrice ? Number(product.unitPrice) : null,
      fullTermUnitPrice: product.fullTermUnitPrice ? Number(product.fullTermUnitPrice) : null,
      startDate: product.startDate,
      isAddon: false,
    },
    ...product.addons.map((a) => ({
      id: a.id,
      quantity: a.quantity,
      unitPrice: a.unitPrice ? Number(a.unitPrice) : null,
      fullTermUnitPrice: a.fullTermUnitPrice ? Number(a.fullTermUnitPrice) : null,
      startDate: a.startDate,
      isAddon: true,
    })),
  ]);

  return { product, group };
}

/** What the renewal would look like, before anybody commits to it. */
export async function renewalDraft(companyProductId: string) {
  const { user, allowed } = await access();
  if (!allowed) return null;

  const loaded = await loadForRenewal(companyProductId, user.id);
  if (!loaded) return null;
  const { product, group } = loaded;

  const draft = renewalOrderDraft({
    quantity: product.quantity,
    unitPrice: product.unitPrice ? Number(product.unitPrice) : null,
    fullTermUnitPrice: product.fullTermUnitPrice ? Number(product.fullTermUnitPrice) : null,
    endDate: product.endDate,
    billingCycle: product.item.billingCycle,
    group,
  });

  return toPlain({
    draft,
    product: {
      id: product.id,
      orderSeq: product.orderSeq,
      itemName: product.item.name,
      unit: product.item.unit,
      billingCycle: product.item.billingCycle,
      quantity: product.quantity,
      endDate: product.endDate,
      locationLabel: product.location?.label ?? null,
      companyName: product.company.name,
      endCustomerName: product.endCustomer?.name ?? null,
      paymentTerms: product.paymentTerms,
    },
    /** Set once it has been renewed, so the button can say so rather than making a second one. */
    alreadyRenewed: product.renewedBy
      ? { id: product.renewedBy.id, orderSeq: product.renewedBy.orderSeq, status: product.renewedBy.orderStatus }
      : null,
  });
}

export async function createRenewalOrder(input: {
  companyProductId: string;
  quantity?: number;
  unitPrice?: number | null;
  startDate?: string;
  endDate?: string;
  poNumber?: string;
  notes?: string;
}): Promise<ActionResult<{ id: string; orderSeq: number }>> {
  const { user, allowed } = await access();
  if (!allowed) return { ok: false, error: "You can't punch orders." };

  const loaded = await loadForRenewal(input.companyProductId, user.id);
  if (!loaded) return { ok: false, error: "That subscription no longer exists." };
  const { product, group } = loaded;
  const resellerRefusal = await resellerOrderRefusal(product.company);
  if (resellerRefusal) return { ok: false, error: resellerRefusal };

  // One renewal per subscription. A second would double-bill the same term, and the unique index
  // would refuse it anyway — better to say why.
  if (product.renewedBy) {
    return {
      ok: false,
      error: `Already renewed by ${formatOrderId(product.renewedBy.orderSeq)}. Cancel that first if it was wrong.`,
    };
  }
  if (!product.locationId) {
    return { ok: false, error: "The original has no site on it, so the renewal has nowhere to go. Set one first." };
  }

  const draft = renewalOrderDraft({
    quantity: product.quantity,
    unitPrice: product.unitPrice ? Number(product.unitPrice) : null,
    fullTermUnitPrice: product.fullTermUnitPrice ? Number(product.fullTermUnitPrice) : null,
    endDate: product.endDate,
    billingCycle: product.item.billingCycle,
    group,
  });

  const quantity = input.quantity ?? draft.quantity;
  if (!Number.isInteger(quantity) || quantity < 1) return { ok: false, error: "Quantity has to be at least 1." };

  const unitPrice = input.unitPrice === undefined ? draft.unitPrice : input.unitPrice;
  const startDate = input.startDate || draft.term?.startDate;
  const endDate = input.endDate || draft.term?.endDate;
  if (!startDate || !endDate) {
    return { ok: false, error: "The new term needs a start and an end date." };
  }
  if (new Date(endDate) <= new Date(startDate)) {
    return { ok: false, error: "The new term ends before it starts." };
  }

  const created = await db.companyProduct.create({
    data: {
      // Everything about *where* it goes is inherited — same customer, same site, same product, and
      // on a reseller's order the same end customer. Only the term and the price are new.
      companyId: product.companyId,
      locationId: product.locationId,
      itemId: product.itemId,
      vendorId: product.vendorId,
      endCustomerId: product.endCustomerId,
      paymentTerms: product.paymentTerms,

      renewedFromId: product.id,
      businessType: "RENEWAL",
      quantity,
      unitPrice: unitPrice === null ? null : new Prisma.Decimal(unitPrice),
      // A renewal is a full term by definition, so the two prices are the same — and recording it
      // means next year's renewal has something to price from without inferring anything.
      fullTermUnitPrice: unitPrice === null ? null : new Prisma.Decimal(unitPrice),
      startDate: new Date(`${startDate}T00:00:00.000Z`),
      endDate: new Date(`${endDate}T00:00:00.000Z`),
      poNumber: input.poNumber?.trim() || null,
      notes:
        [input.notes?.trim(), `Renewal of ${formatOrderId(product.orderSeq)}${draft.warnings.length > 0 ? ` — ${draft.warnings.join(" ")}` : ""}`]
          .filter(Boolean)
          .join("\n\n"),
      orderStatus: "PENDING_APPROVAL",
      addedByUserId: user.id,
    },
    select: { id: true, orderSeq: true },
  });

  // The account manager hears about it even when somebody else punched it — it is their number.
  if (product.company.ownerUserId && product.company.ownerUserId !== user.id) {
    await notifyUser({
      userId: product.company.ownerUserId,
      type: "ORDER_STATUS_CHANGED",
      title: `Renewal punched for ${product.company.name}`,
      message: `${formatOrderId(created.orderSeq)} — ${quantity} × ${product.item.name}, waiting for approval.`,
      link: `/orders?orderId=${created.id}`,
    });
  }

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    // An order like any other in the trail, so the history of orders includes renewals.
    entityType: "Order",
    entityId: created.id,
    entityLabel: `${formatOrderId(created.orderSeq)} — renewal of ${formatOrderId(product.orderSeq)}, ${quantity} × ${product.item.name}`,
  });
  revalidatePath("/renewals");
  revalidatePath("/orders");
  revalidatePath(`/companies/${product.companyId}`);
  return { ok: true, data: created };
}
