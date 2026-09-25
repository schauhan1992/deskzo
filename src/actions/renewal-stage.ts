"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { viaCompanyScope } from "@/lib/authz/company-scope";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { RENEWAL_STAGES, SETTABLE_RENEWAL_STAGES, renewalStageMeta, type RenewalStageKey } from "@/lib/renewals";
import { formatOrderId } from "@/lib/order-id";
import type { ActionResult } from "@/actions/company";

/**
 * Pinning a renewal's stage by hand.
 *
 * The stage is normally derived from what has actually happened — a call logged, a proposal raised,
 * the renewal punched — because a field people have to remember to update is a field that is wrong.
 * But three of the stages that matter most leave no trace at all: "we're negotiating", "they've
 * parked it", "we lost this on price". Nothing in the database can infer those, and they are exactly
 * what somebody looking down the renewals list wants to know.
 *
 * So this writes an override, and `resolveRenewalStage` prefers it over the derived value — except
 * once the renewal has actually been punched, where the fact wins.
 */

async function access() {
  const user = await requireUser();
  // The same pair the renewal order itself needs. Recording where a renewal has got to is part of
  // working it, not a separate privilege.
  const allowed =
    (await hasEffectivePermission(user.id, "products.edit")) ||
    (await hasEffectivePermission(user.id, "orders.process"));
  return { user, allowed };
}

const SETTABLE = new Set(SETTABLE_RENEWAL_STAGES.map((s) => s.key));

/**
 * Whether to offer the picker at all.
 *
 * The action refuses on its own, so this is not the gate — it is only so the column reads as
 * information rather than as a control that turns out not to work.
 */
export async function canSetRenewalStage(): Promise<boolean> {
  const { allowed } = await access();
  return allowed;
}

export async function setRenewalStage(input: {
  companyProductId: string;
  /** Null clears the pin and hands the row back to the derived stage. */
  stage: RenewalStageKey | null;
  note?: string;
}): Promise<ActionResult<null>> {
  const { user, allowed } = await access();
  if (!allowed) return { ok: false, error: "You can't change a renewal's stage." };

  /**
   * Only the stages that cannot be inferred.
   *
   * Pinning "Quoted" by hand would be worse than useless: it stops moving on its own, and it can
   * then claim a renewal was quoted when no quote exists. The enum holds the derived stages so this
   * restriction can be relaxed without another migration, but nothing should relax it without a
   * reason.
   */
  if (input.stage !== null && !SETTABLE.has(input.stage)) {
    const known = RENEWAL_STAGES.some((s) => s.key === input.stage);
    return {
      ok: false,
      error: known
        ? `"${renewalStageMeta(input.stage).label}" is worked out from what's happened, so it can't be set by hand. Clear the stage to go back to that.`
        : "That isn't a renewal stage.",
    };
  }

  const order = await db.companyProduct.findFirst({
    // Scoped as well as filtered by id — the id is posted from the browser, and the refusal for a
    // record outside the caller's book has to read the same as for one that does not exist.
    where: { id: input.companyProductId, ...(await viaCompanyScope(user.id)) },
    select: {
      id: true,
      orderSeq: true,
      renewalStage: true,
      item: { select: { name: true } },
      company: { select: { name: true } },
    },
  });
  if (!order) return { ok: false, error: "That subscription no longer exists." };

  const note = input.note?.trim() || null;

  await db.companyProduct.update({
    where: { id: order.id },
    data: {
      renewalStage: input.stage,
      // All four move together. A note or an attribution left behind after the stage was cleared
      // would be a reason attached to nothing, which reads as though a stage were still set.
      renewalStageNote: input.stage === null ? null : note,
      renewalStageAt: input.stage === null ? null : new Date(),
      renewalStageById: input.stage === null ? null : user.id,
    },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "CompanyProduct",
    entityId: order.id,
    entityLabel:
      input.stage === null
        ? `${user.name} cleared the renewal stage on ${formatOrderId(order.orderSeq)} (${order.item.name} — ${order.company.name}), handing it back to what the record says`
        : `${user.name} set the renewal stage on ${formatOrderId(order.orderSeq)} (${order.item.name} — ${order.company.name}) to ${renewalStageMeta(input.stage).label}${note ? ` — ${note}` : ""}`,
  });

  revalidatePath("/renewals");
  return { ok: true, data: null };
}
