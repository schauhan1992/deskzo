"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { logActivity } from "@/lib/activity";
import { SECURITY_POLICY_ID, getSecurityPolicy, invalidateSecurityPolicyCache } from "@/lib/security/store";
import { DEFAULT_SECURITY_POLICY, type SecurityPolicyShape } from "@/lib/security/policy";
import { updateSecurityPolicySchema } from "@/lib/validation/security-policy";
import type { ActionResult } from "@/actions/company";

/** Admin-only, like the rest of Settings — see src/app/(dashboard)/settings/security/page.tsx. */
export async function getSecurityPolicyForAdmin(): Promise<SecurityPolicyShape | null> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "security.manage"))) return null;
  const row = await db.securityPolicy.findUnique({ where: { id: SECURITY_POLICY_ID } });
  return row ? { ...DEFAULT_SECURITY_POLICY, ...row } : DEFAULT_SECURITY_POLICY;
}

export async function updateSecurityPolicy(input: unknown): Promise<ActionResult<null>> {
  const admin = await requireUser();
  if (!(await hasEffectivePermission(admin.id, "security.manage"))) {
    return { ok: false, error: "You can't change the security policy." };
  }

  const parsed = updateSecurityPolicySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  // ADMIN is exempt in code and cannot be listed here — storing it would imply the list is what
  // grants the exemption, and somebody would eventually remove it and lock every admin out of the
  // clipboard they need to fix it with. See `dlpApplies`.
  const exemptRoles = data.exemptRoles.filter((r) => r !== "ADMIN");

  const before = await getSecurityPolicy();

  await db.securityPolicy.upsert({
    where: { id: SECURITY_POLICY_ID },
    create: { id: SECURITY_POLICY_ID, ...data, exemptRoles },
    update: { ...data, exemptRoles },
  });
  invalidateSecurityPolicyCache();

  // Which settings moved, so the log row says what changed rather than that something did. This is
  // the row that explains why other rows stopped appearing, which is exactly when you need detail.
  const changed = (Object.keys(data) as (keyof typeof data)[]).filter((key) => {
    const was = before[key];
    const now = data[key];
    return Array.isArray(was) || Array.isArray(now)
      ? JSON.stringify([...(was as string[])].sort()) !== JSON.stringify([...(now as string[])].sort())
      : was !== now;
  });

  await recordAudit({
    userId: admin.id,
    action: "UPDATE",
    entityType: "SecurityPolicy",
    entityId: SECURITY_POLICY_ID,
    entityLabel:
      changed.length === 0 ? "Security policy saved with no changes" : `Security policy: changed ${changed.join(", ")}`,
  });
  await logActivity({
    kind: "SECURITY_POLICY_CHANGED",
    summary:
      changed.length === 0
        ? `${admin.name} saved the security policy without changing anything`
        : `${admin.name} changed ${changed.length} security setting${changed.length === 1 ? "" : "s"}: ${changed.join(", ")}`,
    entityType: "SecurityPolicy",
    entityId: SECURITY_POLICY_ID,
    metadata: {
      changed,
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: Object.fromEntries(changed.map((k) => [k, data[k]])),
    },
  });

  revalidatePath("/settings/security");
  // Every page reads the policy in the dashboard layout, so the whole tree is stale.
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}
