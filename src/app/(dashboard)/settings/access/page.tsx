import Link from "next/link";
import { notFound } from "next/navigation";
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
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { PermissionMatrix } from "@/components/settings/permission-matrix";
import { DepartmentsManager } from "@/components/settings/departments-manager";
import { ExceptionsTable } from "@/components/settings/exceptions-table";
import { WhoCan } from "@/components/settings/who-can";
import { ChangeHistory } from "@/components/settings/change-history";
import { StaffTable } from "@/components/settings/staff/staff-table";
import { RolesList, type RoleListItem } from "@/components/settings/roles/roles-list";
import { RoleHeader } from "@/components/settings/roles/role-header";
import { RoleAccessEditor } from "@/components/settings/roles/role-access-editor";
import { RolePresets } from "@/components/settings/roles/role-presets";
import { FieldPolicyEditor } from "@/components/settings/access/field-policy-editor";
import { AccessPreview } from "@/components/settings/access/access-preview";
import { roleAccessLevels } from "@/actions/access-levels";
import { roleFieldAccess } from "@/actions/field-access";
import { accessPreview } from "@/actions/person-access";
import { STANDING_WORDS } from "@/lib/staff/access-modules";
import type { CatalogueEntry, ModuleStates, StaffRow } from "@/components/settings/staff/types";
import { can, permissionsFor, resolveUserPermissions } from "@/lib/authz/resolve";
import { listUserBranchAssignments } from "@/actions/branch";
import { isMultiBranch, listBranchChoices } from "@/lib/branches/identity";
import { staffFacts } from "@/lib/staff/roster";
import { relativeAgo, staffStatus } from "@/lib/staff/status";
import { permissionModules } from "@/lib/staff/permission-modules";
import { workspaceClock } from "@/lib/time/workspace";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { isLive } from "@/lib/cards/server";

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
  searchParams: Promise<{ tab?: string; view?: string; role?: string; rtab?: string }>;
}) {
  const sessionUser = await currentUser();

  if (!sessionUser || !(await can(sessionUser.id, "permissions.view"))) notFound();

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
            roleKey={sp.role}
            rtab={sp.rtab}
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
  const [roster, users, departments, roles, mayEdit, mayAssignRole, showLeads, viewAllActivity, viewSignIns, worksAt, cardsOn, manageCards] =
    await Promise.all([
      accessRoster(),
      listUsers(),
      listDepartments(),
      listRoles(),
      can(viewerId, "users.manage"),
      can(viewerId, "users.assignRole"),
      // The leads column is lead data: only for somebody who may see leads at all, where the plan has them.
      moduleAvailableForTenant("leads").then((on) => on && can(viewerId, "leads.view")),
      // When somebody last signed in is in the activity log and the sign-in log; whoever may read
      // either sees it here, and nobody else does.
      can(viewerId, "activity.viewAll"),
      can(viewerId, "access.viewSignIns"),
      worksAtColumn(mayManage, viewerId),
      // The card column: for whoever issues cards, while Cards is in the plan and switched on.
      moduleAvailableForTenant("cards"),
      can(viewerId, "cards.manage"),
    ]);
  const showSignIns = viewAllActivity || viewSignIns;
  const showCards = cardsOn && manageCards;

  const account = new Map(users.map((u) => [u.id, u]));
  const roleName = new Map(roles.map((r) => [r.key, r.name]));
  const [facts, clock, cardRows] = await Promise.all([
    staffFacts(
      roster.map((r) => r.id),
      { leads: showLeads, signIns: showSignIns },
    ),
    workspaceClock(),
    showCards
      ? db.digitalCard.findMany({
          where: { userId: { in: roster.map((r) => r.id) } },
          select: { userId: true, handle: true, status: true, user: { select: { active: true, kind: true, employeeProfile: { select: { exitedOn: true } } } } },
        })
      : Promise.resolve([]),
  ]);
  const today = clock.today();
  const cards = new Map(
    cardRows.map((c) => [c.userId, { handle: c.handle, state: isLive(c, today) ? ("live" as const) : c.status === "ACTIVE" ? ("ended" as const) : ("off" as const) }]),
  );
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
      tempPassword: !setupPending && Boolean(u?.mustChangePassword),
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
      card: cards.get(r.id) ?? null,
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
            showCards={showCards}
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
              A reporting line decides whose records count as a manager&apos;s team — what &ldquo;Team&rdquo; means
              wherever a role&apos;s reach is set to it — so it is an access decision, not just an org chart. It
              grants no permissions: a manager holds what their role and their own exceptions give them. Change one
              from the pencil on a person&apos;s row.
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

const ROLE_TABS = [
  { key: "modules", label: "Module access" },
  { key: "records", label: "Record access" },
  { key: "fields", label: "Field permissions" },
  { key: "rules", label: "Business rules" },
  { key: "users", label: "Users" },
  { key: "summary", label: "Summary" },
] as const;

/**
 * Roles & permissions: the roles, searchable, beside the one open — what it may do by module, which
 * records it reaches, which lead fields it sees and unmasks, its business rules, its people, and a
 * summary — with a preview of what it (or one of its people) reaches. Every editor saves through the
 * actions the old role dialog and matrix used, with their rules.
 */
async function RolesTab({
  mayManage,
  viewerId,
  viewerIsSuperAdmin,
  compare,
  roleKey,
  rtab,
}: {
  mayManage: boolean;
  viewerId: string;
  viewerIsSuperAdmin: boolean;
  compare: boolean;
  roleKey?: string;
  rtab?: string;
}) {
  if (compare) return <CompareRoles mayManage={mayManage} viewerIsSuperAdmin={viewerIsSuperAdmin} />;

  const [roleRows, activeByRole, superAdmins] = await Promise.all([
    listRolesForScreen(),
    // Who holds each role and can sign in — the super admin counted on their own, not Admin's.
    db.user.groupBy({ by: ["role"], where: { active: true, isSuperAdmin: false }, _count: { _all: true } }),
    db.user.count({ where: { isSuperAdmin: true, active: true } }),
  ]);
  const active = new Map(activeByRole.map((r) => [r.role, r._count._all]));
  const roles: RoleListItem[] = (roleRows.ok ? roleRows.data : []).map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    isSystem: r.isSystem,
    active: r.active,
    people: active.get(r.key) ?? 0,
  }));
  const selected = roles.find((r) => r.key === roleKey) ?? roles[0] ?? null;
  const tab = ROLE_TABS.some((t) => t.key === rtab) ? rtab! : "modules";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-sm text-muted">
          A role is what everybody in it gets by default. For one person&apos;s exceptions — and what they can actually do — open them from Staff.
        </p>
        <Link href="/settings/access?tab=roles&view=compare" className="text-sm text-brand hover:underline">
          Compare roles side by side
        </Link>
      </div>
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="space-y-5">
          <RolesList roles={roles} selected={selected?.key ?? null} mayManage={mayManage} superAdmins={superAdmins} />
          {selected && <RolePreview role={selected.key} />}
        </div>
        {selected ? (
          <RoleWorkspace role={selected} tab={tab} mayManage={mayManage} viewerId={viewerId} viewerIsSuperAdmin={viewerIsSuperAdmin} />
        ) : (
          <Card className="p-6 text-sm text-muted">There are no roles yet.</Card>
        )}
      </div>
    </div>
  );
}

async function RolePreview({ role }: { role: string }) {
  const [initial, people] = await Promise.all([
    accessPreview({ role }),
    db.user.findMany({ where: { role, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true }, take: 200 }),
  ]);
  return <AccessPreview role={role} people={people} initial={initial} />;
}

async function RoleWorkspace({
  role,
  tab,
  mayManage,
  viewerId,
  viewerIsSuperAdmin,
}: {
  role: RoleListItem;
  tab: string;
  mayManage: boolean;
  viewerId: string;
  viewerIsSuperAdmin: boolean;
}) {
  return (
    <Card className="min-w-0">
      <CardContent className="space-y-4 pt-4">
        <RoleHeader role={role} mayManage={mayManage} />
        <TabNav
          tabs={ROLE_TABS.map((t) => ({ key: t.key, label: t.key === "users" ? `${t.label} (${role.people})` : t.label }))}
          activeKey={tab}
          paramName="rtab"
          basePath="/settings/access"
          otherParams={{ tab: "roles", role: role.key }}
        />
        {(tab === "modules" || tab === "records") && (
          <RoleAccessTab role={role.key} view={tab} mayManage={mayManage} viewerId={viewerId} viewerIsSuperAdmin={viewerIsSuperAdmin} />
        )}
        {tab === "fields" && <RoleFieldsTab role={role.key} />}
        {tab === "rules" && <RoleRulesTab role={role.key} mayManage={mayManage} />}
        {tab === "users" && <RoleUsersTab role={role.key} />}
        {tab === "summary" && <RoleSummaryTab role={role.key} />}
      </CardContent>
    </Card>
  );
}

async function RoleAccessTab({
  role,
  view,
  mayManage,
  viewerId,
  viewerIsSuperAdmin,
}: {
  role: string;
  view: "modules" | "records";
  mayManage: boolean;
  viewerId: string;
  viewerIsSuperAdmin: boolean;
}) {
  const [matrix, grid, moduleStates, viewerHolds, resolved] = await Promise.all([
    getPermissionMatrix(),
    roleAccessLevels(role),
    getModuleStates(),
    permissionsFor(viewerId),
    resolveUserPermissions(viewerId),
  ]);
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
    <RoleAccessEditor
      key={`${role}:${view}`}
      view={view}
      roleKey={role}
      catalogue={catalogue}
      selfExcluded={matrix.filter((p) => p.selfExcluded).map((p) => p.key)}
      held={matrix.filter((p) => p.roles[role]).map((p) => p.key)}
      grid={grid?.rows ?? []}
      gridWhy={grid ? grid.why : "This role's records can't be read."}
      modules={modules}
      viewer={{ mayManage, isSuperAdmin: viewerIsSuperAdmin, holds: viewerHolds.map(String), role: resolved.role ?? "", ownAccessThroughRole: [...ownAccessThroughRole] }}
    />
  );
}

async function RoleFieldsTab({ role }: { role: string }) {
  const data = await roleFieldAccess(role);
  if (!data) return <p className="text-sm text-muted">This role&apos;s field access can&apos;t be read.</p>;
  return <FieldPolicyEditor key={role} mode="role" role={role} data={data} canEdit={data.editable} lockedWhy={data.why} />;
}

async function RoleRulesTab({ role, mayManage }: { role: string; mayManage: boolean }) {
  const [matrix, fields] = await Promise.all([getPermissionMatrix(), roleFieldAccess(role)]);
  const held = matrix.filter((p) => p.roles[role]);
  const separated = held.filter((p) => p.selfExcluded);
  const labels = Object.fromEntries(matrix.map((p) => [p.key, p.label]));
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-text">Separation of duties</h3>
        <p className="text-sm text-muted">
          These permissions are never used on a record the person raised themselves — an order they punched, a claim they made — whoever holds them. The rule
          is the permission&apos;s own, enforced on the server.
        </p>
        {separated.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {separated.map((p) => (
              <li key={p.key}>
                <Badge tone="blue">{p.label}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-subtle">This role holds none of them.</p>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-text">Daily unmasking limit</h3>
        <p className="text-sm text-muted">
          {fields?.dailyLimit ? `${fields.dailyLimit} leads a day for each person in this role.` : "No limit set: people in this role may unmask as many leads as their field access allows."}{" "}
          <Link href={`/settings/access?tab=roles&role=${encodeURIComponent(role)}&rtab=fields`} className="text-brand hover:underline">
            Change it under Field permissions
          </Link>
        </p>
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-text">Sign-in rules</h3>
        <p className="text-sm text-muted">
          Which devices and networks this role may sign in from is set with the other sign-in rules, under{" "}
          <Link href="/settings/security/access" className="text-brand hover:underline">
            Devices, networks &amp; sign-ins
          </Link>
          .
        </p>
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-text">Start from a preset</h3>
        <RolePresets presets={ROLE_PRESETS.filter((p) => p.role === role).map((p) => ({ key: p.key, label: p.label, description: p.description }))} mayManage={mayManage} labels={labels} />
      </section>
    </div>
  );
}

async function RoleUsersTab({ role }: { role: string }) {
  const people = await db.user.findMany({
    where: { role },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: { id: true, name: true, email: true, active: true, _count: { select: { permissionGrants: true } } },
  });
  if (people.length === 0) return <p className="text-sm text-muted">Nobody holds this role.</p>;
  return (
    <div className="overflow-x-auto rounded-base border border-line">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
          <tr>
            <th className="px-3 py-2">Person</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Exceptions</th>
            <th className="px-3 py-2 text-right">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.id} className="border-b border-line last:border-0">
              <td className="px-3 py-2">
                <span className="text-text">{p.name}</span>
                <span className="block text-xs text-subtle">{p.email}</span>
              </td>
              <td className="px-3 py-2">{p.active ? <Badge tone="green">Active</Badge> : <Badge>Switched off</Badge>}</td>
              <td className="px-3 py-2 text-muted">{p._count.permissionGrants || "—"}</td>
              <td className="px-3 py-2 text-right">
                <Link href={`/settings/access/users/${p.id}`} className="text-sm text-brand hover:underline">
                  Permissions
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function RoleSummaryTab({ role }: { role: string }) {
  const [preview, matrix, grid, fields, history] = await Promise.all([
    accessPreview({ role }),
    getPermissionMatrix(),
    roleAccessLevels(role),
    roleFieldAccess(role),
    permissionChangeHistory({ role, limit: 12 }),
  ]);
  const held = matrix.filter((p) => p.roles[role] && p.group !== "Sections");
  const masked = (fields?.rows ?? []).filter((r) => !r.effective.view || r.effective.maskInList || r.effective.maskInDetail);
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-3">
          <p className="text-xs uppercase tracking-wide text-subtle">Permissions</p>
          <p className="mt-0.5 text-xl font-semibold text-text">
            {held.length} <span className="text-sm font-normal text-muted">of {matrix.filter((p) => p.group !== "Sections").length}</span>
          </p>
        </Card>
        <Card className="p-3">
          <p className="text-xs uppercase tracking-wide text-subtle">Records it reaches</p>
          <p className="mt-0.5 text-xl font-semibold text-text">
            {(grid?.rows ?? []).filter((r) => (r.cells.view.stored ?? r.cells.view.derived) !== "NONE").length} <span className="text-sm font-normal text-muted">of {grid?.rows.length ?? 0} types</span>
          </p>
        </Card>
        <Card className="p-3">
          <p className="text-xs uppercase tracking-wide text-subtle">Lead fields masked</p>
          <p className="mt-0.5 text-xl font-semibold text-text">
            {masked.length} <span className="text-sm font-normal text-muted">· {fields?.dailyLimit ? `${fields.dailyLimit}/day` : "no daily limit"}</span>
          </p>
        </Card>
      </div>
      {preview && (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {preview.map((m) => (
            <li key={m.key} className="flex items-center justify-between rounded-base border border-line px-3 py-2 text-sm">
              <span className="text-text">{m.label}</span>
              <Badge tone={m.standing === "full" ? "green" : m.standing === "limited" ? "amber" : "red"}>{STANDING_WORDS[m.standing]}</Badge>
            </li>
          ))}
        </ul>
      )}
      <ChangeHistory rows={history} title="This role's history" />
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
            This screen does not show personal exceptions or the permissions an admin holds by default. For
            &ldquo;can this person do X&rdquo; use Staff; for &ldquo;who can do X&rdquo; use Who can.
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
        cannot show you somebody who holds a key personally, or because they are an admin. This can.
      </p>
      <WhoCan catalogue={catalogue} />
    </div>
  );
}
