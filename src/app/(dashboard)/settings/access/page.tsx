import Link from "next/link";
import { Eye } from "lucide-react";
import { ROLES } from "@/lib/roles";
import { currentUser } from "@/lib/session";
import { listDepartments } from "@/actions/department";
import { listUsers } from "@/actions/user";
import { accessRoster, getPermissionMatrix, permissionCatalogue } from "@/actions/permission";
import { listPermissionExceptions, permissionChangeHistory } from "@/actions/access";
import { ROLE_PRESETS } from "@/lib/authz/presets";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { PermissionMatrix } from "@/components/settings/permission-matrix";
import { DepartmentsManager } from "@/components/settings/departments-manager";
import { TeamManager } from "@/components/settings/team-manager";
import { NewUserDialog } from "@/components/settings/new-user-dialog";
import { AccessRoster } from "@/components/settings/access-roster";
import { ExceptionsTable } from "@/components/settings/exceptions-table";
import { WhoCan } from "@/components/settings/who-can";
import { ChangeHistory } from "@/components/settings/change-history";
import { can } from "@/lib/authz/resolve";

/**
 * Users & access, as four questions rather than one long page.
 *
 * The old screen stacked Team, an access review, the role matrix and Departments, which meant the
 * three questions an administrator actually arrives with — *why can she do that*, *what temporary
 * access is live*, *who can do X* — were answered by the same scroll, badly or not at all. Each tab
 * here is one of those questions; the matrix, which is for **defining** a role rather than
 * answering anything, is last and marked as such.
 */

const TABS = [
  { key: "people", label: "People" },
  { key: "exceptions", label: "Exceptions" },
  { key: "who", label: "Who can" },
  { key: "roles", label: "Roles" },
] as const;

export default async function UsersAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sessionUser = await currentUser();

  if (!sessionUser || !(await can(sessionUser.id, "permissions.view"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Users &amp; access</h1>
        <p className="mt-2 text-sm text-muted">Only an admin can view and change these settings.</p>
      </div>
    );
  }

  /**
   * Seeing and changing are different permissions, and this screen used to offer the second to
   * anybody holding the first — roughly six hundred live-looking toggles, every one of which
   * answered "You can't change permissions." MANAGEMENT holds `permissions.view` by default and the
   * auditor preset grants it while describing itself as read-only.
   */
  const mayManage = await can(sessionUser.id, "permissions.manage");

  const viewer = await db.user.findUnique({ where: { id: sessionUser.id }, select: { isSuperAdmin: true } });
  const viewerIsSuperAdmin = viewer?.isSuperAdmin ?? false;

  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "people";

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">Users &amp; access</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Who works here, what each of them can do, and where every one of those permissions came from.
      </p>

      {!mayManage && (
        <Card className="mt-4 flex items-center gap-2 border-line px-4 py-3 text-sm text-muted">
          <Eye className="h-4 w-4 shrink-0 text-subtle" />
          You can review access but not change it. Everything here is read-only.
        </Card>
      )}

      <div className="mt-4">
        <TabNav tabs={[...TABS]} activeKey={tab} basePath="/settings/access" />
      </div>

      <div className="mt-5">
        {tab === "people" && <PeopleTab mayManage={mayManage} viewerIsSuperAdmin={viewerIsSuperAdmin} />}
        {tab === "exceptions" && <ExceptionsTab mayManage={mayManage} />}
        {tab === "who" && <WhoCanTab />}
        {tab === "roles" && <RolesTab mayManage={mayManage} viewerIsSuperAdmin={viewerIsSuperAdmin} />}
      </div>
    </div>
  );
}

async function PeopleTab({ mayManage, viewerIsSuperAdmin }: { mayManage: boolean; viewerIsSuperAdmin: boolean }) {
  const [roster, users, departments, history] = await Promise.all([
    accessRoster(),
    listUsers(),
    listDepartments(),
    permissionChangeHistory({ limit: 8 }),
  ]);
  const nonAdminRoles = ROLES.filter((r) => r !== "ADMIN");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          How much of the app each person can reach. Open anybody to see every permission they hold and where it
          came from — their role, an exception somebody made for them, or a report they inherit it through.
        </p>
        {mayManage && <NewUserDialog roles={nonAdminRoles} departments={departments} />}
      </div>

      <AccessRoster rows={roster} viewerIsSuperAdmin={viewerIsSuperAdmin} mayManage={mayManage} />

      <Card>
        <CardHeader className="text-sm font-medium text-text">Roles, departments &amp; reporting lines</CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted">
            A manager automatically gets every permission their team has, direct and indirect, on top of their own
            role — so the reporting line is an access decision, not just an org chart. Changing one needs permission
            to manage access.
          </p>
          <TeamManager users={users} departments={departments} roles={ROLES} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader className="text-sm font-medium text-text">Departments</CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted">
              {/* Said plainly, because the picker sits beside role and manager and looks like one of them. */}
              Grouping only — a department carries no permissions of its own.
            </p>
            <DepartmentsManager departments={departments} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="text-sm font-medium text-text">Sign-in</CardHeader>
          <CardContent>
            <p className="text-sm text-muted">
              Two-factor, lockout and session length are set under{" "}
              <Link href="/settings/security" className="text-brand hover:underline">
                Security &amp; data protection
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </div>

      <ChangeHistory rows={history} title="Recent access changes" />
    </div>
  );
}

async function ExceptionsTab({ mayManage }: { mayManage: boolean }) {
  const [result, history] = await Promise.all([listPermissionExceptions(), permissionChangeHistory({ limit: 8 })]);

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">
        Every permission granted or denied to one person rather than to their whole role. These are the ones worth
        reviewing: an exception nobody can explain is one nobody dares remove, and a temporary grant with no end
        date stops being temporary the day everyone forgets it.
      </p>

      <ExceptionsTable result={result} mayManage={mayManage} />
      <ChangeHistory rows={history} title="Recent access changes" />
    </div>
  );
}

async function WhoCanTab() {
  const catalogue = await permissionCatalogue();
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">
        The reverse of every other screen here. The roles tab can only tell you what a role grants by default — it
        cannot show you somebody who holds a key personally, or through a report, or because they are an admin. This
        can.
      </p>
      <WhoCan catalogue={catalogue} />
    </div>
  );
}

async function RolesTab({ mayManage, viewerIsSuperAdmin }: { mayManage: boolean; viewerIsSuperAdmin: boolean }) {
  const [permissions, history] = await Promise.all([getPermissionMatrix(), permissionChangeHistory({ limit: 8 })]);

  return (
    <div className="space-y-6">
      <div className="max-w-3xl space-y-2 text-sm text-muted">
        <p>
          What each role gives by default. Start from a preset, then adjust — ADMIN is a real column rather than an
          implied yes, so a super admin can genuinely restrict what admins do.
        </p>
        <p className="text-subtle">
          {/*
            The caption the audit asked for. This screen is load-bearing for defining a role and
            actively misleading as an answer to "can this person do X".
          */}
          This screen does not show personal exceptions, the permissions an admin holds by default, or anything
          somebody inherits from a report. For &ldquo;can this person do X&rdquo; use People; for &ldquo;who can do
          X&rdquo; use Who can.
        </p>
      </div>

      <PermissionMatrix
        rows={permissions.map((p) => ({ ...p, roles: p.roles as Record<string, boolean> }))}
        roles={[...ROLES]}
        presetsByRole={Object.fromEntries(ROLES.map((r) => [r, ROLE_PRESETS.filter((p) => p.role === r)]))}
        viewerIsSuperAdmin={viewerIsSuperAdmin}
        mayManage={mayManage}
      />

      <ChangeHistory rows={history} title="Recent role changes" />
    </div>
  );
}
