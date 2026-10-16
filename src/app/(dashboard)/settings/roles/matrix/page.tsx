import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import type { Role } from "@/lib/roles";
import { currentUser } from "@/lib/session";
import { db } from "@/lib/db";
import { roleKeys } from "@/lib/authz/role-registry";
import { can } from "@/lib/authz/resolve";
import { getPermissionMatrix, permissionCatalogue } from "@/actions/permission";
import { listPermissionExceptions, permissionChangeHistory } from "@/actions/access";
import { ROLE_PRESETS } from "@/lib/authz/presets";
import { PermissionMatrix } from "@/components/settings/permission-matrix";
import { ChangeHistory } from "@/components/settings/change-history";
import { ExceptionsTable } from "@/components/settings/exceptions-table";
import { WhoCan } from "@/components/settings/who-can";

export const metadata = { title: "Permission matrix" };

/**
 * Roles & Permissions › Permission matrix: every role side by side. Each cell is Default (the
 * registry decides), Allow or Deny (an answer somebody stored); the arrow puts a row back to its
 * defaults, and a preset sets a role up in one step after showing what it would change. ADMIN is a
 * real column, so a super admin can genuinely restrict what admins do.
 *
 * Under it, the two access-review questions a matrix of role defaults can't answer (what the old
 * Staff & roles screen kept as tabs of their own): every exception made for one person, lapsed and
 * ending first; and who holds one permission, and how each of them came by it.
 */
export default async function PermissionMatrixPage() {
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "permissions.view"))) notFound();
  const [mayManage, viewerRow, permissions, history, roles, exceptions, catalogue] = await Promise.all([
    can(viewer.id, "permissions.manage"),
    db.user.findUnique({ where: { id: viewer.id }, select: { isSuperAdmin: true } }),
    getPermissionMatrix(),
    permissionChangeHistory({ limit: 8 }),
    roleKeys(),
    listPermissionExceptions(),
    permissionCatalogue(),
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
      <ChangeHistory rows={history} title="Recent role and access changes" />

      <section id="exceptions" className="scroll-mt-20 space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-text">Exceptions to roles</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Every permission granted or denied to one person rather than to their whole role. An exception nobody can explain is one nobody dares remove, and a
            temporary grant with no end date stops being temporary the day everyone forgets it.
          </p>
        </div>
        <ExceptionsTable result={exceptions} mayManage={mayManage} />
      </section>

      <section id="who-can" className="scroll-mt-20 space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-text">Who holds a permission</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            The reverse of the matrix: it shows what each role gives by default, and can&apos;t show somebody who holds a key personally, or because they are an
            admin. This can.
          </p>
        </div>
        <WhoCan catalogue={catalogue} />
      </section>
    </div>
  );
}
