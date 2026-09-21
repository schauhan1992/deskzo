"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type ResellerOnboardingStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { calculateOrderAmount } from "@/lib/gst";
import {
  isOnboardingComplete,
  outstandingOnboardingItems,
  type OnboardingInputs,
} from "@/lib/reseller-onboarding";
import { resellerProfileSchema, resellerItemPriceSchema, bulkUpdateResellersSchema } from "@/lib/validation/reseller";
import { toPlain } from "@/lib/serialize";
import type { ActionResult } from "@/actions/company";

/** The profile plus the company/location fields the onboarding checklist reads. */
export async function getResellerOnboarding(companyId: string) {
  await requireUser();
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      relationshipType: true,
      panNumber: true,
      paymentTerms: true,
      locations: { where: { isPrimary: true }, select: { gstNumber: true } },
      resellerProfile: { include: { agreementApprovedBy: { select: { id: true, name: true } } } },
    },
  });
  if (!company || company.relationshipType !== "RESELLER" || !company.resellerProfile) return null;

  const profile = company.resellerProfile;
  const inputs: OnboardingInputs = {
    agreementSignedOn: profile.agreementSignedOn,
    creditLimit: profile.creditLimit,
    tier: profile.tier,
    panNumber: company.panNumber,
    gstNumber: company.locations[0]?.gstNumber ?? null,
  };
  return toPlain({ company, profile, inputs });
}

/** Unpaid balance across the reseller's orders, against the credit limit they were granted. */
export async function getResellerCreditSummary(companyId: string) {
  await requireUser();
  const [profile, orders] = await Promise.all([
    db.resellerProfile.findUnique({ where: { companyId }, select: { creditLimit: true } }),
    db.companyProduct.findMany({
      where: { companyId, orderStatus: { notIn: ["REJECTED", "CANCELLED"] } },
      select: {
        quantity: true,
        unitPrice: true,
        item: { select: { sellingPrice: true, taxRatePercent: true } },
        allocations: { select: { amount: true } },
      },
    }),
  ]);

  let billed = 0;
  let paid = 0;
  for (const o of orders) {
    const { total } = calculateOrderAmount({
      quantity: o.quantity,
      unitPrice: Number(o.unitPrice ?? o.item.sellingPrice),
      taxRatePercent: o.item.taxRatePercent ? Number(o.item.taxRatePercent) : null,
    });
    billed += total;
    paid += o.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
  }

  const outstanding = Math.round((billed - paid) * 100) / 100;
  const creditLimit = profile?.creditLimit ? Number(profile.creditLimit) : null;
  return {
    creditLimit,
    outstanding,
    available: creditLimit === null ? null : Math.round((creditLimit - outstanding) * 100) / 100,
    overLimit: creditLimit !== null && outstanding > creditLimit,
  };
}

export async function updateResellerProfile(companyId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  const parsed = resellerProfileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const profile = await db.resellerProfile.findUnique({ where: { companyId } });
  if (!profile) {
    return { ok: false, error: "That company isn't a reseller." };
  }

  const data = parsed.data;
  await db.resellerProfile.update({
    where: { companyId },
    data: {
      agreementSignedOn: data.agreementSignedOn ? new Date(data.agreementSignedOn) : null,
      agreementReference: data.agreementReference || null,
      agreementApprovedByUserId: data.agreementApprovedByUserId || null,
      creditLimit: data.creditLimit ?? null,
      tier: data.tier || null,
      discountPercent: data.discountPercent ?? null,
      notes: data.notes || null,
    },
  });

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ResellerProfile", entityId: profile.id, entityLabel: "Reseller onboarding" });
  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/resellers");
  return { ok: true, data: null };
}

/**
 * Activation is the gate: a reseller can't go ACTIVE with onboarding steps still outstanding, since
 * being ACTIVE is exactly what unblocks order punching.
 */
export async function setResellerStatus(companyId: string, status: ResellerOnboardingStatus): Promise<ActionResult<null>> {
  const user = await requireUser();
  const onboarding = await getResellerOnboarding(companyId);
  if (!onboarding) {
    return { ok: false, error: "That company isn't a reseller." };
  }

  if (status === "ACTIVE" && !isOnboardingComplete(onboarding.inputs)) {
    const missing = outstandingOnboardingItems(onboarding.inputs).map((i) => i.label);
    return { ok: false, error: `Onboarding isn't complete — still outstanding: ${missing.join(", ")}.` };
  }

  await db.resellerProfile.update({
    where: { companyId },
    data: { status, activatedAt: status === "ACTIVE" ? (onboarding.profile.activatedAt ?? new Date()) : onboarding.profile.activatedAt },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "ResellerProfile",
    entityId: onboarding.profile.id,
    entityLabel: `${onboarding.company.name} → ${status}`,
  });
  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/resellers");
  return { ok: true, data: null };
}

export async function listResellerItemPrices(resellerId: string) {
  await requireUser();
  return toPlain(
    await db.resellerItemPrice.findMany({
      where: { resellerId },
      orderBy: { item: { name: "asc" } },
      include: { item: { select: { id: true, name: true, sku: true, unit: true, sellingPrice: true } } },
    }),
  );
}

export async function upsertResellerItemPrice(resellerId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  const parsed = resellerItemPriceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const reseller = await db.company.findUnique({ where: { id: resellerId }, select: { relationshipType: true } });
  if (!reseller || reseller.relationshipType !== "RESELLER") {
    return { ok: false, error: "That company isn't a reseller." };
  }

  const { itemId, price, notes } = parsed.data;
  try {
    await db.resellerItemPrice.upsert({
      where: { resellerId_itemId: { resellerId, itemId } },
      create: { resellerId, itemId, price, notes: notes || null },
      update: { price, notes: notes || null },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      return { ok: false, error: "That product no longer exists." };
    }
    throw err;
  }

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ResellerItemPrice", entityId: resellerId, entityLabel: "Reseller pricing" });
  revalidatePath(`/companies/${resellerId}`);
  return { ok: true, data: null };
}

export async function deleteResellerItemPrice(id: string): Promise<ActionResult<null>> {
  await requireUser();
  const existing = await db.resellerItemPrice.findUnique({ where: { id } });
  if (!existing) {
    return { ok: false, error: "Price not found." };
  }
  await db.resellerItemPrice.delete({ where: { id } });
  revalidatePath(`/companies/${existing.resellerId}`);
  return { ok: true, data: null };
}

/** The price a reseller pays for one item — used by the punch form to fill in the sale price. */
export async function getResellerPriceForItem(resellerId: string, itemId: string) {
  await requireUser();
  const [profile, special, item] = await Promise.all([
    db.resellerProfile.findUnique({ where: { companyId: resellerId }, select: { discountPercent: true } }),
    db.resellerItemPrice.findUnique({ where: { resellerId_itemId: { resellerId, itemId } }, select: { price: true } }),
    db.item.findUnique({ where: { id: itemId }, select: { sellingPrice: true } }),
  ]);
  if (!item) return null;
  return {
    catalogPrice: Number(item.sellingPrice),
    specialPrice: special ? Number(special.price) : null,
    discountPercent: profile?.discountPercent ? Number(profile.discountPercent) : null,
  };
}

/**
 * Bulk status/tier changes from the reseller list. Status goes through `setResellerStatus` per
 * reseller so the activation gate still applies — being ACTIVE is what unblocks order punching, and
 * a bulk path that skipped the onboarding check would be a way to let unvetted resellers trade.
 * Resellers that fail the gate are reported by name rather than failing the whole batch.
 */
export async function bulkUpdateResellers(input: unknown): Promise<ActionResult<{ count: number; blocked: string[] }>> {
  await requireUser();
  const parsed = bulkUpdateResellersSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { companyIds, status, tier } = parsed.data;
  if (!status && !tier) return { ok: false, error: "Pick a status or tier to apply." };

  const blocked: string[] = [];
  let changed = 0;

  for (const companyId of companyIds) {
    if (tier) {
      await db.resellerProfile.updateMany({ where: { companyId }, data: { tier } });
    }
    if (status) {
      const result = await setResellerStatus(companyId, status);
      if (!result.ok) {
        const company = await db.company.findUnique({ where: { id: companyId }, select: { name: true } });
        blocked.push(company?.name ?? companyId);
        continue;
      }
    }
    changed += 1;
  }

  revalidatePath("/resellers");
  return { ok: true, data: { count: changed, blocked } };
}
