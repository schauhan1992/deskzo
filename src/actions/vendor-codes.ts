"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { vendorRelationshipTypeValues } from "@/lib/validation/company";
import {
  VENDOR_CODE_PREFIX_PATTERN,
  assignVendorCodes,
  formatVendorCode,
  vendorCodeNumber,
  vendorCodePrefix,
} from "@/lib/companies/vendor-code";

/**
 * Settings › Vendor codes (owner, 8 Oct 2026): the prefix every new vendor's code starts with, and
 * numbering the vendors from before codes were given automatically. Seen and changed with
 * `settings.manage`.
 */

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type VendorCodeSettings = {
  prefix: string;
  /** What the next vendor created would be given. */
  nextCode: string;
  /** Vendors with no code at all — what "Give them codes" would number. */
  withoutCode: number;
};

const NO_RIGHT = "Changing vendor codes needs the “Change organisation settings” permission.";

async function manager() {
  const user = await requireModuleUser("vendors");
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return null;
  return user;
}

export async function getVendorCodeSettings(): Promise<VendorCodeSettings | null> {
  if (!(await manager())) return null;
  const prefix = await vendorCodePrefix(db);
  const [taken, withoutCode] = await Promise.all([
    db.company.findMany({ where: { vendorCode: { startsWith: prefix, mode: "insensitive" } }, select: { vendorCode: true } }),
    db.company.count({ where: { relationshipType: { in: vendorRelationshipTypeValues }, vendorCode: null } }),
  ]);
  const highest = Math.max(0, ...taken.map((c) => (c.vendorCode ? vendorCodeNumber(c.vendorCode, prefix) ?? 0 : 0)));
  return { prefix, nextCode: formatVendorCode(prefix, highest + 1), withoutCode };
}

export async function saveVendorCodePrefix(input: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NO_RIGHT };
  const prefix = input.trim().toUpperCase();
  if (!VENDOR_CODE_PREFIX_PATTERN.test(prefix)) {
    return { ok: false, error: "Use 1–12 letters or digits, optionally with - / or _ — for example VEN- or V/." };
  }
  // Codes already given keep their old prefix; only vendors created from now on take the new one.
  await db.organisationSettings.upsert({
    where: { id: "global" },
    update: { vendorCodePrefix: prefix },
    create: { id: "global", vendorCodePrefix: prefix },
    select: { id: true },
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "OrganisationSettings", entityId: "global", entityLabel: `Vendor code prefix: ${prefix}` });
  revalidatePath("/settings/vendor-codes");
  return { ok: true, data: null };
}

/** Every vendor with no code gets the next one, oldest first. */
export async function giveVendorsCodes(): Promise<ActionResult<{ given: number }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NO_RIGHT };
  const waiting = await db.company.findMany({
    where: { relationshipType: { in: vendorRelationshipTypeValues }, vendorCode: null },
    select: { id: true },
  });
  const given = await assignVendorCodes(waiting.map((c) => c.id));
  if (given.length > 0) {
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "Company",
      entityId: "vendor-codes",
      entityLabel: `Vendor codes given to ${given.length} vendor${given.length === 1 ? "" : "s"}: ${given[0]!.vendorCode}…${given.at(-1)!.vendorCode}`,
    });
  }
  revalidatePath("/settings/vendor-codes");
  revalidatePath("/vendors");
  return { ok: true, data: { given: given.length } };
}
