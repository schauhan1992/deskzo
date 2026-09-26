"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser, viewAsContext } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { MAX_GRANT_HOURS, activeSupportGrant, endSupportAccess, grantSupportAccess } from "@/lib/platform/support";
import { currentTenant } from "@/lib/tenancy/resolve";
import type { ActionResult } from "@/actions/company";

/**
 * Letting the platform's support staff into this workspace, for a while — see src/lib/platform/
 * support.ts. The super admin's decision alone: nobody else in the workspace can give it, and staff
 * can never give it to themselves. Not while "viewing as" somebody — a grant is given as oneself.
 */

export type SupportAccessState = {
  grant: { level: "READONLY" | "ADMIN"; reason: string; grantedByName: string; expiresAt: string } | null;
  maxHours: number;
};

async function superAdmin(): Promise<{ ok: true; me: { id: string; name: string } } | { ok: false; error: string }> {
  const user = await requireUser();
  if (await viewAsContext()) return { ok: false, error: "Switch back to your own account first." };
  const me = await db.user.findUnique({ where: { id: user.id }, select: { id: true, name: true, isSuperAdmin: true, kind: true } });
  if (!me || !me.isSuperAdmin || me.kind !== "MEMBER") return { ok: false, error: "Only the super admin can let platform support in." };
  return { ok: true, me: { id: me.id, name: me.name } };
}

/** Null for anybody but the super admin — the card is theirs alone. */
export async function getSupportAccess(): Promise<SupportAccessState | null> {
  const a = await superAdmin();
  if (!a.ok) return null;
  const grant = await activeSupportGrant((await currentTenant()).id, true);
  return {
    grant: grant ? { level: grant.level, reason: grant.reason, grantedByName: grant.grantedByName, expiresAt: grant.expiresAt.toISOString() } : null,
    maxHours: MAX_GRANT_HOURS,
  };
}

export async function grantPlatformSupport(input: { level: "READONLY" | "ADMIN"; hours: number; reason: string }): Promise<ActionResult<null>> {
  const a = await superAdmin();
  if (!a.ok) return a;
  const level = input?.level === "ADMIN" ? "ADMIN" : input?.level === "READONLY" ? "READONLY" : null;
  if (!level) return { ok: false, error: "Choose read-only or administrator." };
  const hours = Number(input.hours);
  if (!Number.isFinite(hours) || hours < 1 || hours > MAX_GRANT_HOURS) return { ok: false, error: `Between 1 and ${MAX_GRANT_HOURS} hours.` };
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 5) return { ok: false, error: "Say what support is for — it is kept with the grant." };

  const grant = await grantSupportAccess((await currentTenant()).id, a.me, { level, hours, reason });
  await recordAudit({
    userId: a.me.id,
    action: "CREATE",
    entityType: "SupportAccess",
    entityId: grant.id,
    entityLabel: `Platform support, ${level === "ADMIN" ? "administrator" : "read-only"}, for ${Math.round(hours)} hour(s)`,
  });
  revalidatePath("/settings/security");
  return { ok: true, data: null };
}

export async function endPlatformSupport(): Promise<ActionResult<null>> {
  const a = await superAdmin();
  if (!a.ok) return a;
  const tenantId = (await currentTenant()).id;
  const grant = await activeSupportGrant(tenantId, true);
  await endSupportAccess(tenantId, a.me);
  await recordAudit({ userId: a.me.id, action: "DELETE", entityType: "SupportAccess", entityId: grant?.id ?? "none", entityLabel: "Platform support ended" });
  revalidatePath("/settings/security");
  return { ok: true, data: null };
}
