import Link from "next/link";
import { ArrowLeft, Eye } from "lucide-react";
import type { Role } from "@/lib/roles";
import { listRoles, roleKeys } from "@/lib/authz/role-registry";
import { listRolesForScreen } from "@/actions/role";
import { currentUser } from "@/lib/session";
import { listDepartments } from "@/actions/department";
import { listUsers } from "@/actions/user";
import { accessRoster, getPermissionMatrix, permissionCatalogue } from "@/actions/permission";
import { listPermissionExceptions, permissionChangeHistory } from "@/actions/access";
import { getModuleStates } from "@/actions/module";
import { ROLE_PRESETS } from "@/lib/authz/presets";
import { OWN_ACCESS_KEYS } from "@/lib/authz/guards";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { PermissionMatrix } from "@/components/settings/permission-matrix";
import { DepartmentsManager } from "@/components/settings/departments-manager";
import { ExceptionsTable } from "@/components/settings/exceptions-table";
import { WhoCan } from "@/components/settings/who-can";
import { ChangeHistory } from "@/components/settings/change-history";
import { StaffTable } from "@/components/settings/staff/staff-table";
import { RolesPanel } from "@/components/settings/staff/roles-panel";
import type { CatalogueEntry, ModuleStates, RoleCard, StaffRow } from "@/components/settings/staff/types";
import { can, permissionsFor, resolveUserPermissions } from "@/lib/authz/resolve";
import { listUserBranchAssignments } from "@/actions/branch";
import { isMultiBranch, listBranchChoices } from "@/lib/branches/identity";
import { staffFacts } from "@/lib/staff/roster";
import { relativeAgo, staffStatus } from "@/lib/staff/status";
import { permissionModules } from "@/lib/staff/permission-modules";
import { workspaceClock } from "@/lib/time/workspace";

export const metadata = { title: "Staff & roles" };

/**
 * Staff & roles (was Users & access), in the owner's reference layout.
 *
 * Two tabs carry the reference: **Staff** — who can sign in, as a table with an Add staff page — and
 * **Roles & permissions** — one card per role, and a dialog of checkboxes that defines it. The two
 * access-review questions the old screen answered stay after them, unchanged: **Exceptions** (what
 * has been granted or denied to one person) and **Who can** (everyone holding one permission).
 *
 * Where everything else went: departments and the sign-in pointer sit under the Staff table; the old
 * team table's per-row controls are the Staff row's pencil; the role list became the role cards; the
 * permission matrix is "Compare roles" on the Roles tab, for comparing roles side by side, telling a
 * default from a stored answer, and the presets; recent role changes are under the role cards and
 * recent access changes under Exceptions, as before.
 *
 * The gates are as before: `permissions.view` opens it, `permissions.manage` changes roles and grants,
 * and the people actions keep their own key (`users.manage`) — which is now also what decides whether
 * the pencil, the switch-off and Add staff are shown, since it is what their actions check.
 */

const TABS = [
  { key: "staff", label: "Staff" },
  { key: "roles", label: "Roles & permissions" },
  { key: "exceptions", label: "Exceptions" },
  { key: "who", label: "Who can" },
] as const;

/** The old tab keys, so a saved link to People still lands on the people. */
const RENAMED_TABS: Record<string, string> = { people: "staff" };

export default async function StaffAndRolesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; view?: string }>;
}) {
  const sessionUser = await currentUser();

  if (!sessionUser || !(await can(sessionUser.id, "permissions.view"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Staff &amp; roles</h1>
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
  const requested = RENAMED_TABS[sp.tab ?? ""] ?? sp.tab;
  const tab = TABS.some((t) => t.key === requested) ? requested! : "staff";

  // The tabs' counts: everybody who can sign in or is about to, and every card on the roles tab.
  const [staffCount, roleCount, superAdmins] = await Promise.all([
    db.user.count({ where: { active: true } }),
    db.role.count(),
    db.user.count({ where: { isSuperAdmin: true, active: true } }),
  ]);
  const counts: Record<string, number> = { staff: staffCount, roles: roleCount + (superAdmins > 0 ? 1 : 0) };

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">Staff &amp; roles</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">Who can sign in, and exactly what each of them may do.</p>

      {!mayManage && (
        <Card className="mt-4 flex items-center gap-2 border-line px-4 py-3 text-sm text-muted">
          <Eye className="h-4 w-4 shrink-0 text-subtle" />
          You can review access but not change it. Everything here is read-only.
        </Card>
      )}

      <div className="mt-4">
        <TabNav tabs={TABS.map((t) => ({ ...t, count: counts[t.key] }))} activeKey={tab} basePath="/settings/access" />
      </div>

      <div className="mt-5">
        {tab === "staff" && (
          <StaffTab mayManage={mayManage} viewerId={sessionUser.id} viewerIsSuperAdmin={viewerIsSuperAdmin} />
        )}
        {tab === "roles" && (
          <RolesTab
            mayManage={mayManage}
            viewerId={sessionUser.id}
            viewerIsSuperAdmin={viewerIsSuperAdmin}
            compare={sp.view === "compare"}
          />
        )}
        {tab === "exceptions" && <ExceptionsTab mayManage={mayManage} />}
        {tab === "who" && <WhoCanTab />}
      </div>
    </div>
  );
}

// ─── Staff ────────────────────────────────────────────────────────────────────────────────────────

async function StaffTab({
  mayManage,
  viewerId,
  viewerIsSuperAdmin,
}: {
  mayManage: boolean;
  viewerId: string;
  viewerIsSuperAdmin: boolean;
}) {
  const [roster, users, departments, roles, mayEdit, mayAssignRole, showLeads, viewAllActivity, viewSignIns, worksAt] =
    await Promise.all([
      accessRoster(),
      listUsers(),
      listDepartments(),
      listRoles(),
      can(viewerId, "users.manage"),
      can(viewerId, "users.assignRole"),
      // The leads column is lead data: only for somebody who may see leads at all.
      can(viewerId, "leads.view"),
      // When somebody last signed in is in the activity log and the sign-in log; whoever may read
      // either sees it here, and nobody else does.
      can(viewerId, "activity.viewAll"),
      can(viewerId, "access.viewSignIns"),
      worksAtColumn(mayManage, viewerId),
    ]);
  const showSignIns = viewAllActivity || viewSignIns;

  const account = new Map(users.map((u) => [u.id, u]));
  const roleName = new Map(roles.map((r) => [r.key, r.name]));
  const [facts, clock] = await Promise.all([
    staffFacts(
      roster.map((r) => r.id),
      { leads: showLeads, signIns: showSignIns },
    ),
    workspaceClock(),
  ]);
  const now = new Date();

  const rows: StaffRow[] = roster.map((r) => {
    const u = account.get(r.id);
    const f = facts.get(r.id);
    const setupPending = r.setupPending;
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      roleName: roleName.get(r.role) ?? r.role,
      isSuperAdmin: r.isSuperAdmin,
      status: staffStatus({ active: r.active, setupPending }),
      active: r.active,
      setupPending,
      setupLinkIssued: u?.setupLinkIssued ?? false,
      photoUpdatedAt: f?.photoUpdatedAt?.toISOString() ?? null,
      jobTitle: f?.jobTitle ?? null,
      phone: f?.phone ?? null,
      departmentId: u?.departmentId ?? null,
      departmentName: r.department,
      managerId: u?.managerId ?? null,
      managerName: r.managerName,
      branchId: worksAt?.branchByUser[r.id] ?? null,
      twoFactorOn: Boolean(u?.twoFactorEnabledAt),
      holds: r.holds,
      total: r.total,
      exceptions: r.exceptions,
      lapsingSoon: r.lapsingSoon,
      openLeads: f?.openLeads ?? null,
      overdueLeads: f?.overdueLeads ?? null,
      lastSignIn: f?.lastSignInAt
        ? { label: relativeAgo(f.lastSignInAt, now), exact: clock.dateTime(f.lastSignInAt), iso: f.lastSignInAt.toISOString() }
        : null,
      isYou: r.id === viewerId,
    };
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-text">Staff</h2>
            <p className="mt-0.5 text-xs text-muted">Everyone who can sign in to this workspace.</p>
          </div>
          {mayEdit && (
            <Link
              href="/settings/access/new"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-base bg-brand px-3 text-[13px] font-medium text-brand-contrast shadow-sm transition-[filter] hover:brightness-110"
            >
              + Add staff
            </Link>
          )}
        </CardHeader>
        <div className="pb-2">
          <StaffTable
            rows={rows}
            roles={roles.map((r) => ({ key: r.key, name: r.name }))}
            departments={departments.map((d) => ({ id: d.id, name: d.name }))}
            branches={worksAt?.branches ?? null}
            mayEdit={mayEdit}
            mayAssignRole={mayAssignRole}
            mayManageAccess={mayManage}
            viewerIsSuperAdmin={viewerIsSuperAdmin}
            showLeads={showLeads}
            showSignIns={showSignIns}
          />
        </div>
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
          <CardContent className="space-y-2 text-sm text-muted">
            <p>
              Two-factor, lockout and session length are set under{" "}
              <Link href="/settings/security" className="text-brand hover:underline">
                Security &amp; data protection
              </Link>
              .
            </p>
            <p>
              A manager automatically gets every permission their team has, direct and indirect, on top of their own
              role — so a reporting line is an access decision, not just an org chart. Change one from the pencil on
              a person&apos;s row.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * The "Works at" choices (spec §10.1), or null when they have no place here.
 *
 * Only with more than one active branch — a single-branch company has one answer for everybody — and
 * only for somebody who may change it. That takes `users.manage` as well as this screen's
 * `permissions.manage`: `setUserBranch` checks the first, and without it the assignments come back
 * empty, which would show every person as working nowhere.
 */
async function worksAtColumn(mayManage: boolean, viewerId: string) {
  if (!mayManage || !(await can(viewerId, "users.manage")) || !(await isMultiBranch())) return null;
  const assignments = await listUserBranchAssignments();
  const assigned = [...new Set(assignments.flatMap((a) => (a.branchId ? [a.branchId] : [])))];
  // The active branches, plus any somebody still works at after it closed, so their row shows it
  // rather than falling back to "none".
  const branches = await listBranchChoices({ include: assigned });
  return {
    branches: branches.map((b) => ({ id: b.id, name: b.name, code: b.code, isHeadOffice: b.isHeadOffice, active: b.active })),
    branchByUser: Object.fromEntries(assignments.map((a) => [a.userId, a.branchId] as const)) as Record<string, string | null>,
  };
}

// ─── Roles & permissions ─────────────────────────────────────────────────────────────────────────

async function RolesTab({
  mayManage,
  viewerId,
  viewerIsSuperAdmin,
  compare,
}: {
  mayManage: boolean;
  viewerId: string;
  viewerIsSuperAdmin: boolean;
  compare: boolean;
}) {
  if (compare) return <CompareRoles mayManage={mayManage} viewerIsSuperAdmin={viewerIsSuperAdmin} />;

  const [matrix, history, roleRows, activeByRole, superAdmins, moduleStates, viewerHolds, resolved] = await Promise.all([
    getPermissionMatrix(),
    permissionChangeHistory({ limit: 8 }),
    listRolesForScreen(),
    // Who holds each role and can sign in — the super admin counted on their own card, not Admin's.
    db.user.groupBy({ by: ["role"], where: { active: true, isSuperAdmin: false }, _count: { _all: true } }),
    db.user.count({ where: { isSuperAdmin: true, active: true } }),
    getModuleStates(),
    permissionsFor(viewerId),
    resolveUserPermissions(viewerId),
  ]);

  const active = new Map(activeByRole.map((r) => [r.role, r._count._all]));
  const roles: RoleCard[] = (roleRows.ok ? roleRows.data : []).map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    isSystem: r.isSystem,
    headcount: r.headcount,
    activeStaff: active.get(r.key) ?? 0,
    held: matrix.filter((p) => p.roles[r.key]).map((p) => p.key),
  }));

  const catalogue: CatalogueEntry[] = matrix.map((p) => ({
    key: p.key,
    label: p.label,
    description: p.description,
    group: p.group,
    tier: p.tier,
    superAdminOnly: p.superAdminOnly,
    modules: permissionModules(p.key),
  }));

  const modules: ModuleStates = Object.fromEntries(
    moduleStates.map((m) => [m.key, { key: m.key, label: m.label, entitled: m.entitled, switchedOn: m.switchedOn }]),
  );

  // Which of the two keys that open these screens the viewer holds *through their role*: those boxes
  // are locked on their own role, as `assertKeepsOwnAccessAdmin` would refuse unticking them.
  const ownAccessThroughRole = OWN_ACCESS_KEYS.filter((key) => {
    const source = resolved.sources.get(key);
    return source?.via === "roleDefault" || source?.via === "adminDefault" || (source?.via === "roleOverride" && source.allowed);
  });

  return (
    <div className="space-y-6">
      <RolesPanel
        roles={roles}
        superAdminStaff={superAdmins > 0 ? superAdmins : null}
        compareHref="/settings/access?tab=roles&view=compare"
        dialog={{
          catalogue,
          modules,
          mayManage,
          viewerIsSuperAdmin,
          viewerHolds,
          viewerRole: resolved.role ?? "",
          ownAccessThroughRole: [...ownAccessThroughRole],
        }}
      />

      <p className="max-w-3xl text-sm text-subtle">
        {/*
          The caption the audit asked for, carried over from the matrix: a role is what it gives by
          default, and that is not the same question as what one person can do.
        */}
        A role shows what it gives everybody who holds it. It doesn&apos;t show personal exceptions or anything somebody
        inherits from a report. For &ldquo;can this person do X&rdquo; open them from Staff; for &ldquo;who can do
        X&rdquo; use Who can.
      </p>

      <ChangeHistory rows={history} title="Recent role changes" />
    </div>
  );
}

/**
 * The permission matrix, kept as "Compare roles". It does three things the role dialog doesn't: every
 * role side by side; a stored answer told apart from a registry default, with the arrow that puts a
 * row back to its defaults; and the built-in presets, with a preview of what applying one would change.
 */
async function CompareRoles({ mayManage, viewerIsSuperAdmin }: { mayManage: boolean; viewerIsSuperAdmin: boolean }) {
  const [permissions, history, roles] = await Promise.all([
    getPermissionMatrix(),
    permissionChangeHistory({ limit: 8 }),
    roleKeys(),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href="/settings/access?tab=roles"
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-text"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Roles &amp; permissions
        </Link>
        <h2 className="text-base font-semibold text-text">Compare roles</h2>
        <div className="max-w-3xl space-y-2 text-sm text-muted">
          <p>
            Every role side by side. Each cell is Default (the registry decides), Allow or Deny (an answer somebody
            stored); the arrow puts a row back to its defaults, and a preset sets a role up in one step after showing
            what it would change. ADMIN is a real column, so a super admin can genuinely restrict what admins do.
          </p>
          <p className="text-subtle">
            This screen does not show personal exceptions, the permissions an admin holds by default, or anything
            somebody inherits from a report. For &ldquo;can this person do X&rdquo; use Staff; for &ldquo;who can do
            X&rdquo; use Who can.
          </p>
        </div>
      </div>

      <PermissionMatrix
        rows={permissions.map((p) => ({ ...p, roles: p.roles as Record<string, boolean> }))}
        roles={roles}
        presetsByRole={Object.fromEntries(roles.map((r: Role) => [r, ROLE_PRESETS.filter((p) => p.role === r)]))}
        viewerIsSuperAdmin={viewerIsSuperAdmin}
        mayManage={mayManage}
      />

      <ChangeHistory rows={history} title="Recent role changes" />
    </div>
  );
}

// ─── Exceptions and Who can — unchanged ──────────────────────────────────────────────────────────

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
