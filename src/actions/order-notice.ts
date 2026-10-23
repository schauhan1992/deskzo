"use server";

import { revalidatePath } from "next/cache";
import { requireModuleUser } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { mayAccess } from "@/lib/authz/access";
import { queueCustomerNotice, resolveNoticeRecipients } from "@/lib/marketing/order-notice";
import type { NoticeKind } from "@/lib/marketing/customer-notices";
import type { ActionResult } from "@/actions/company";
import { tenantOrigin } from "@/lib/tenancy/resolve";

/**
 * The mail icon on a renewal, and the one on a fulfilled order.
 *
 * Thin on purpose: who is allowed, where the links point, and what goes in the audit trail. The work
 * is in src/lib/marketing/order-notice.ts, which has no session to read and can therefore be
 * exercised directly by a script.
 */

/** The same population that may change an order may write to the customer about one. */
async function access() {
  const user = await requireModuleUser(["orders", "renewals"]);
  const allowed =
    (await hasEffectivePermission(user.id, "products.edit")) ||
    (await hasEffectivePermission(user.id, "orders.process")) ||
    (await hasEffectivePermission(user.id, "marketing.send"));
  return { user, allowed };
}

/** Where links in what this sends should point — the workspace's own address. */
async function currentOrigin() {
  return tenantOrigin();
}

/**
 * And only about an order the person may change (security review, 23 Oct 2026): the permissions above said who may
 * write to customers at all, not about whose orders — any order's id read back its customer's people and mailed them.
 */
async function mayChangeOrder(userId: string, companyProductId: string): Promise<boolean> {
  return typeof companyProductId === "string" && !!companyProductId && mayAccess(userId, "orders", "edit", companyProductId);
}

/** Who this could go to, and what would happen to each of them, before anybody presses send. */
export async function noticeRecipients(companyProductId: string, kind: NoticeKind = "RENEWAL") {
  const { user, allowed } = await access();
  if (!allowed || !(await mayChangeOrder(user.id, companyProductId))) return null;
  return resolveNoticeRecipients(companyProductId, kind);
}

export async function sendCustomerNotice(input: {
  companyProductId: string;
  contactIds: string[];
  kind?: NoticeKind;
  templateId?: string;
  note?: string;
}): Promise<ActionResult<{ sent: number; failed: number; skipped: { name: string; reason: string }[] }>> {
  const { user, allowed } = await access();
  if (!allowed) return { ok: false, error: "You can't write to customers about orders." };
  if (!(await mayChangeOrder(user.id, input?.companyProductId))) return { ok: false, error: "That order isn't one of yours to write about." };

  const result = await queueCustomerNotice({ ...input, origin: await currentOrigin(), sentByUserId: user.id });
  if (!result.ok) return result;

  const { product, ...outcome } = result.data;
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "CompanyProduct",
    entityId: product.id,
    entityLabel: `${input.kind === "FULFILMENT" ? "Fulfilment notice" : input.kind === "RENEWED" ? "Renewal confirmation" : "Renewal reminder"} for ${product.itemName} sent to ${outcome.sent} contact(s) at ${product.companyName}`,
  });
  revalidatePath("/renewals");
  revalidatePath("/orders");
  revalidatePath(`/companies/${product.companyId}`);

  return { ok: true, data: outcome };
}
