import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import type { Role } from "@/lib/roles";
import { currentUser } from "@/lib/session";
import { db } from "@/lib/db";
import { roleKeys } from "@/lib/authz/role-registry";
import { can } from "@/lib/authz/resolve";
import { getPermissionMatrix } from "@/actions/permission";
import { permissionChangeHistory } from "@/actions/access";
import { ROLE_PRESETS } from "@/lib/authz/presets";
import { PermissionMatrix } from "@/components/settings/permission-matrix";
import { ChangeHistory } from "@/components/settings/change-history";

export const metadata = { title: "Permission matrix" };

/**
 * Roles & Permissions › Permission matrix: every role side by side. Each cell is Default (the
 * registry decides), Allow or Deny (an answer somebody stored); the arrow puts a row back to its
 * defaults, and a preset sets a role up in one step after showing what it would change. ADMIN is a
 * real column, so a super admin can genuinely restrict what admins do.
 */
export default async function PermissionMatrixPage() {
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "permissions.view"))) notFound();
  const [mayManage, viewerRow, permissions, history, roles] = await Promise.all([
    can(viewer.id, "permissions.manage"),
    db.user.findUnique({ where: { id: viewer.id }, select: { isSuperAdmin: true } }),
    getPermissionMatrix(),
    permissionChangeHistory({ limit: 8 }),
    roleKeys(),
  ]);

  return (
    <div className="animate-fade-rise space-y-5">
      <Link href="/settings/roles" className="inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Roles &amp; Permissions
      </Link>
      <div>
        <h1 className="text-2xl font-semibold text-text">Permission matrix</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Every role side by side. Each cell is Default (the registry decides), Allow or Deny (an answer somebody stored); the arrow puts a row back to its
          defaults, and a preset sets a role up in one step after showing what it would change.
        </p>
      </div>
      <PermissionMatrix
        rows={permissions.map((p) => ({ ...p, roles: p.roles as Record<string, boolean> }))}
        roles={roles}
        presetsByRole={Object.fromEntries(roles.map((r: Role) => [r, ROLE_PRESETS.filter((p) => p.role === r)]))}
        viewerIsSuperAdmin={viewerRow?.isSuperAdmin ?? false}
        mayManage={mayManage}
      />
      <ChangeHistory rows={history} title="Recent role changes" />
    </div>
  );
}
