import type { PermissionChangeKind, PermissionSubjectType } from "@prisma/client";
import type { Role } from "@/lib/roles";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { resolveViewAs } from "@/lib/impersonation";
import { getPermissionDefinition } from "@/lib/permissions";
import { logActivity, alertAdmins } from "@/lib/activity";

/**
 * Recording who changed what somebody could do.
 *
 * Server-only and not exported from a `"use server"` module, the same rule `recordAudit` follows:
 * an append-only authorization log that any signed-in user can write rows into is not a log.
 *
 * This is the record that was simply missing. `setRolePermission` wrote nothing at all, and
 * `RolePermission.updatedAt` is overwritten on every edit — so "who held payroll.manage in March,
 * and who gave it to them" had no answer anywhere in the system. Authorization changes are exactly
 * the changes that matter after an incident and were the least recorded.
 */
export async function recordPermissionChange(input: {
  actorUserId: string;
  subjectType: PermissionSubjectType;
  subjectRole?: Role | null;
  subjectUserId?: string | null;
  permission?: string | null;
  fromAllowed?: boolean | null;
  toAllowed?: boolean | null;
  changeKind: PermissionChangeKind;
  detail?: string | null;
}) {
  try {
    // Worked out here rather than passed in, for the reason src/lib/audit.ts gives: "remember to
    // attribute this correctly" is a rule a hundred call sites break within a week. Without it,
    // "view as" is a way to launder a grant onto somebody else's name.
    let impersonatedByUserId: string | null = null;
    try {
      const session = await auth();
      if (session?.user) {
        const viewAs = await resolveViewAs(session.user.id);
        impersonatedByUserId = viewAs?.actor.id ?? null;
      }
    } catch {
      // No request context — a script or a background job. Not impersonated by definition.
    }

    await db.permissionChange.create({
      data: {
        actorUserId: input.actorUserId,
        impersonatedByUserId,
        subjectType: input.subjectType,
        subjectRole: input.subjectRole ?? null,
        subjectUserId: input.subjectUserId ?? null,
        permission: input.permission ?? null,
        fromAllowed: input.fromAllowed ?? null,
        toAllowed: input.toAllowed ?? null,
        changeKind: input.changeKind,
        detail: input.detail ?? null,
      },
    });

    // Also written to the activity log, so an access change appears in the same timeline as the
    // sign-ins and exports somebody is reviewing. One screen, one story.
    await logActivity({
      kind: "SECURITY_POLICY_CHANGED",
      severity: "CRITICAL",
      userId: input.actorUserId,
      summary: input.detail ?? `${input.changeKind.toLowerCase().replaceAll("_", " ")}`,
      entityType: input.subjectType === "USER" ? "User" : "Role",
      entityId: input.subjectUserId ?? input.subjectRole ?? "",
      metadata: {
        changeKind: input.changeKind,
        permission: input.permission ?? null,
        from: input.fromAllowed ?? null,
        to: input.toAllowed ?? null,
      },
    });

    // The changes worth waking somebody for. A grant of a critical key, or any movement of the
    // super-admin flag, is told to the admins rather than left in a table nobody opens.
    const def = input.permission ? getPermissionDefinition(input.permission) : undefined;
    const isSuperAdminChange =
      input.changeKind === "SUPER_ADMIN_GRANTED" || input.changeKind === "SUPER_ADMIN_REVOKED";
    if (isSuperAdminChange || def?.tier === "critical" || def?.superAdminOnly) {
      await alertAdmins({
        title: isSuperAdminChange ? "Super admin access changed" : "A critical permission was changed",
        message: input.detail ?? `${input.changeKind} on ${input.permission ?? "an account"}`,
        link: "/settings/access",
      });
    }
  } catch (err) {
    // Same contract as recordAudit: the log is a side effect of the change and must never be the
    // reason the change fails.
    console.error("recordPermissionChange failed", err);
  }
}
