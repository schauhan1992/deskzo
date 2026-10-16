import { createHash } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Eye } from "lucide-react";
import { currentUser } from "@/lib/session";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { roleGrants } from "@/lib/authz/role-permission";
import { listRoles } from "@/lib/authz/role-registry";
import { getPermissionDefinition, PERMISSIONS } from "@/lib/permissions";
import { effectivePermissionsFor, accessRoster } from "@/actions/permission";
import { permissionChangeHistory, userPermissionOverrides } from "@/actions/access";
import { accessPreview, personAccessGrid } from "@/actions/person-access";
import { personFieldAccess } from "@/actions/field-access";
import { listUnmaskEvents } from "@/actions/unmask-log";
import { listDepartments } from "@/actions/department";
import { listUsers } from "@/actions/user";
import { listUserBranchAssignments } from "@/actions/branch";
import { isMultiBranch, listBranchChoices } from "@/lib/branches/identity";
import { staffFacts } from "@/lib/staff/roster";
import { relativeAgo, staffStatus } from "@/lib/staff/status";
import { rolePath, userPath } from "@/lib/staff/staff-paths";
import { workspaceClock } from "@/lib/time/workspace";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { isLive } from "@/lib/cards/server";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { ChangeHistory } from "@/components/settings/change-history";
import { PersonSignInRule } from "@/components/settings/staff/person-sign-in-rule";
import { PersonDraftProvider } from "@/components/settings/people/person-draft";
import { UserHeader } from "@/components/settings/people/user-header";
import { UsersDirectory, type DirectoryRow } from "@/components/settings/people/users-directory";
import { UserAccountActions } from "@/components/settings/people/user-account-actions";
import { FieldMaskingPanel, PersonPermissionsPanel, UnmaskLimitPanel, type PersonPermissionRow } from "@/components/settings/people/person-permissions-panel";
import { PersonRecordAccess } from "@/components/settings/people/person-record-access";
import type { StaffRow } from "@/components/settings/staff/types";

export const metadata = { title: "Users" };

const TABS = [
  { key: "profile", label: "Profile" },
  { key: "role", label: "Role" },
  { key: "permissions", label: "Permissions" },
  { key: "records", label: "Record Access" },
  { key: "fields", label: "Field Permissions" },
  { key: "rules", label: "Business Rules" },
  { key: "login", label: "Login & Access" },
  { key: "activity", label: "Activity" },
] as const;

/**
 * Settings › Staff › Users: everybody who can sign in, or could, beside the one open — who they are,
 * their role, and the exceptions made for them alone (what they may do, which records they reach, which
 * lead fields are masked for them and how many they may unmask a day), with what applies once it is all
 * put together.
 *
 * `permissions.view` opens it. Changing access takes `permissions.manage`, and the account itself
 * (profile, switching off, password reset) `users.manage`, as before; every editor saves through the
 * actions that check them again. The access editors wait for "Save changes" at the top, which saves
 * them all with one reason and end date.
 */
export default async function UsersPage({ searchParams }: { searchParams: Promise<{ user?: string; tab?: string }> }) {
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "permissions.view"))) notFound();
  const sp = await searchParams;

  const [mayManage, viewerRow] = await Promise.all([
    can(viewer.id, "permissions.manage"),
    db.user.findUnique({ where: { id: viewer.id }, select: { isSuperAdmin: true } }),
  ]);
  const viewerIsSuperAdmin = viewerRow?.isSuperAdmin ?? false;
  const staff = await staffRows(viewer.id, mayManage);
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "permissions";
  const row = staff.rows.find((r) => r.id === sp.user) ?? staff.rows.find((r) => r.active && !r.isSuperAdmin) ?? staff.rows[0] ?? null;

  const directory: DirectoryRow[] = staff.rows.map((r) => ({
    id: r.id,
    name: r.name,
    roleName: r.roleName,
    role: r.role,
    departmentId: r.departmentId,
    departmentName: r.departmentName,
    active: r.active,
    setupPending: r.setupPending,
    isSuperAdmin: r.isSuperAdmin,
    photoUpdatedAt: r.photoUpdatedAt,
    exceptions: r.exceptions,
    lapsingSoon: r.lapsingSoon,
  }));

  return (
    <div className="animate-fade-rise space-y-5">
      <Link href="/settings" className="inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Settings
      </Link>

      {!mayManage && (
        <Card className="flex items-center gap-2 px-4 py-3 text-sm text-muted">
          <Eye className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
          You can review access but not change it. Everything here is read-only.
        </Card>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <UsersDirectory
          rows={directory}
          selected={row?.id ?? null}
          tab={tab}
          departments={staff.departments}
          roles={staff.roles}
          mayAdd={staff.mayEdit}
        />
        {row ? (
          <PersonDraftProvider key={row.id}>
            <Person row={row} tab={tab} staff={staff} mayManage={mayManage} viewerId={viewer.id} viewerIsSuperAdmin={viewerIsSuperAdmin} />
          </PersonDraftProvider>
        ) : (
          <Card className="p-6 text-sm text-muted">Nobody can sign in yet.</Card>
        )}
      </div>
    </div>
  );
}

type Staff = Awaited<ReturnType<typeof staffRows>>;

/** Everybody on the list, as the Staff table built them — and the choices its editors need. */
async function staffRows(viewerId: string, mayManage: boolean) {
  const [roster, users, departments, roles, mayEdit, mayAssignRole, showLeads, viewAllActivity, viewSignIns, worksAt, cardsOn, manageCards] = await Promise.all([
    accessRoster(),
    listUsers(),
    listDepartments(),
    listRoles(),
    can(viewerId, "users.manage"),
    can(viewerId, "users.assignRole"),
    // Open leads are lead data: only for somebody who may see leads at all, where the plan has them.
    moduleAvailableForTenant("leads").then((on) => on && can(viewerId, "leads.view")),
    // When somebody last signed in is in the activity log and the sign-in log; whoever may read either
    // sees it here, and nobody else does.
    can(viewerId, "activity.viewAll"),
    can(viewerId, "access.viewSignIns"),
    worksAtChoices(mayManage, viewerId),
    // Digital cards: for whoever issues them, while Cards is in the plan and switched on.
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
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      roleName: roleName.get(r.role) ?? r.role,
      isSuperAdmin: r.isSuperAdmin,
      status: staffStatus({ active: r.active, setupPending: r.setupPending }),
      active: r.active,
      setupPending: r.setupPending,
      setupLinkIssued: u?.setupLinkIssued ?? false,
      tempPassword: !r.setupPending && Boolean(u?.mustChangePassword),
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
      lastSignIn: f?.lastSignInAt ? { label: relativeAgo(f.lastSignInAt, now), exact: clock.dateTime(f.lastSignInAt), iso: f.lastSignInAt.toISOString() } : null,
      isYou: r.id === viewerId,
      card: cards.get(r.id) ?? null,
    };
  });

  return {
    rows,
    roles: roles.map((r) => ({ key: r.key, name: r.name })),
    departments: departments.map((d) => ({ id: d.id, name: d.name })),
    branches: worksAt?.branches ?? null,
    mayEdit,
    mayAssignRole,
    showLeads,
    showSignIns,
    showCards,
  };
}

/**
 * The "Works at" choices (spec §10.1), or null when they have no place here: only with more than one
 * active branch, and only for somebody who may change it — `setUserBranch` checks `users.manage`, and
 * without it the assignments come back empty, which would show every person as working nowhere.
 */
async function worksAtChoices(mayManage: boolean, viewerId: string) {
  if (!mayManage || !(await can(viewerId, "users.manage")) || !(await isMultiBranch())) return null;
  const assignments = await listUserBranchAssignments();
  const assigned = [...new Set(assignments.flatMap((a) => (a.branchId ? [a.branchId] : [])))];
  // The active branches, plus any somebody still works at after it closed, so they show it rather than "none".
  const branches = await listBranchChoices({ include: assigned });
  return {
    branches: branches.map((b) => ({ id: b.id, name: b.name, code: b.code, isHeadOffice: b.isHeadOffice, active: b.active })),
    branchByUser: Object.fromEntries(assignments.map((a) => [a.userId, a.branchId] as const)) as Record<string, string | null>,
  };
}

// ─── One person ───────────────────────────────────────────────────────────────────────────────────

type PersonFacts = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  isSuperAdmin: boolean;
  createdAt: Date;
  twoFactorEnabledAt: Date | null;
  lockedAt: Date | null;
  roleRef: { name: string; description: string | null };
};

async function Person({
  row,
  tab,
  staff,
  mayManage,
  viewerId,
  viewerIsSuperAdmin,
}: {
  row: StaffRow;
  tab: string;
  staff: Staff;
  mayManage: boolean;
  viewerId: string;
  viewerIsSuperAdmin: boolean;
}) {
  const [person, viewAsAllowed, ownLimit] = await Promise.all([
    db.user.findUnique({
      where: { id: row.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        isSuperAdmin: true,
        createdAt: true,
        twoFactorEnabledAt: true,
        lockedAt: true,
        roleRef: { select: { name: true, description: true } },
        _count: { select: { permissionGrants: true, accessLevels: true, fieldPolicies: true } },
      },
    }),
    can(viewerId, "impersonation.use"),
    db.userUnmaskLimit.count({ where: { userId: row.id } }).catch(() => 0),
  ]);
  if (!person) return <Card className="p-6 text-sm text-muted">That user no longer exists.</Card>;

  const exceptions = person._count.permissionGrants + person._count.accessLevels + person._count.fieldPolicies + ownLimit;
  const lockedWhy = !mayManage
    ? "You can review access but not change it."
    : person.isSuperAdmin
      ? "A super admin holds everything and sees every field. There is nothing to set for them."
      : person.id === viewerId
        ? "Your own access is changed by another admin."
        : null;
  const canEdit = lockedWhy === null;
  const people = staff.rows.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name }));
  const account = {
    row,
    roles: staff.roles,
    departments: staff.departments,
    people,
    branches: staff.branches,
    mayEdit: staff.mayEdit,
    mayAssignRole: staff.mayAssignRole,
    mayChangeManager: mayManage,
    viewerIsSuperAdmin,
  };

  return (
    <div className="min-w-0 space-y-5">
      <Card>
        <CardContent className="space-y-4 pb-0 pt-5">
          <UserHeader
            person={{
              id: person.id,
              name: person.name,
              email: person.email,
              phone: row.phone,
              active: person.active,
              setupPending: row.setupPending,
              isSuperAdmin: person.isSuperAdmin,
              roleName: person.isSuperAdmin ? "Super Admin" : person.roleRef.name,
              department: row.departmentName,
              photoUpdatedAt: row.photoUpdatedAt,
            }}
            exceptions={exceptions}
            canReset={canEdit}
            canViewAs={viewAsAllowed && person.active && person.id !== viewerId && !person.isSuperAdmin}
          />
          <TabNav tabs={TABS.map((t) => ({ ...t }))} activeKey={tab} defaultKey="permissions" basePath="/settings/users" otherParams={{ user: person.id }} />
        </CardContent>
      </Card>

      {tab === "profile" && <ProfileTab person={person} row={row} staff={staff} account={account} />}
      {tab === "role" && <RoleTab person={person} account={account} />}
      {tab === "permissions" && <PermissionsTab person={person} canEdit={canEdit} lockedWhy={lockedWhy} />}
      {tab === "records" && <RecordsTab person={person} canEdit={canEdit} lockedWhy={lockedWhy} />}
      {tab === "fields" && <FieldsTab person={person} canEdit={canEdit} lockedWhy={lockedWhy} />}
      {tab === "rules" && <RulesTab person={person} />}
      {tab === "login" && <LoginTab person={person} row={row} staff={staff} account={account} viewerId={viewerId} />}
      {tab === "activity" && <ActivityTab person={person} viewerId={viewerId} />}
    </div>
  );
}

type Account = Omit<Parameters<typeof UserAccountActions>[0], "mode">;

async function ProfileTab({ person, row, staff, account }: { person: PersonFacts; row: StaffRow; staff: Staff; account: Account }) {
  const clock = await workspaceClock();
  const branch = row.branchId ? staff.branches?.find((b) => b.id === row.branchId) : null;
  const rows: [string, string][] = [
    ["Name", person.name],
    ["Email", person.email],
    ["Phone", row.phone ?? "—"],
    ["Job title", row.jobTitle ?? "—"],
    ["Role", person.isSuperAdmin ? "Super Admin" : person.roleRef.name],
    ["Department", row.departmentName ?? "—"],
    ["Reports to", row.managerName ?? "—"],
    ...(staff.branches ? ([["Works at", branch?.name ?? "—"]] as [string, string][]) : []),
    ["Account", person.active ? (row.setupPending ? "Invited — no password chosen yet" : "Active") : "Switched off"],
    ["Added", clock.date(person.createdAt)],
    ...(row.openLeads !== null ? ([["Open leads", row.overdueLeads ? `${row.openLeads} (${row.overdueLeads} past their expected close date)` : String(row.openLeads)]] as [string, string][]) : []),
  ];
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">Profile</h3>
        <UserAccountActions mode="profile" {...account} />
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-line py-1.5">
              <dt className="text-muted">{k}</dt>
              <dd className="text-right text-text">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-subtle">
          A department is grouping only and carries no permissions. A reporting line decides whose records count as a manager&apos;s team — what &ldquo;Team&rdquo;
          means wherever a scope is set to it — and grants nothing else.
        </p>
      </CardContent>
    </Card>
  );
}

async function RoleTab({ person, account }: { person: PersonFacts; account: Account }) {
  const preview = await accessPreview({ role: person.role });
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text">{person.isSuperAdmin ? "Super Admin" : person.roleRef.name}</h3>
          <p className="mt-0.5 text-xs text-muted">
            {person.isSuperAdmin ? "Holds everything and sees every field, whatever their role says." : (person.roleRef.description ?? "What everybody in this role gets by default.")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <UserAccountActions mode="profile" {...account} editLabel="Change role" />
          <Link href={rolePath(person.role)} className="text-sm text-brand hover:underline">
            Open the role
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted">What the role gives on its own, before anything made for {person.name} alone:</p>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {(preview ?? []).map((m) => (
            <li key={m.key} className="flex items-center justify-between rounded-base border border-line px-3 py-2 text-sm">
              <span className="text-text">{m.label}</span>
              <Badge tone={m.standing === "full" ? "green" : m.standing === "limited" ? "amber" : "red"}>
                {m.standing === "full" ? "Full access" : m.standing === "limited" ? "Limited access" : "No access"}
              </Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Which of a person's own answers the editors were drawn from — the key that remounts them when a save
 * brings different answers back, so their drafts start again from what is now stored.
 */
function versionOf(
  userId: string,
  permissions: PersonPermissionRow[] | null,
  grid: Awaited<ReturnType<typeof personAccessGrid>>,
  fields: Awaited<ReturnType<typeof personFieldAccess>>,
): string {
  const parts = [
    userId,
    (permissions ?? []).flatMap((p) => (p.own ? [`${p.key}:${p.own.allowed}:${p.own.expiresAt}:${p.own.expired}`] : [])).join(","),
    (grid ?? []).flatMap((r) => r.actions.map((a) => `${r.key}:${a}:${r.cells[a].own?.level ?? ""}:${r.cells[a].own?.expiresAt ?? ""}`)).join(","),
    JSON.stringify(fields ? [fields.rows.map((r) => r.stored), fields.limit.own] : null),
  ];
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** Their permissions as the editors show them: what their role gives, their own answer, and what applies. */
async function permissionRows(person: PersonFacts): Promise<PersonPermissionRow[]> {
  const [effective, overrides, grants] = await Promise.all([effectivePermissionsFor(person.id), userPermissionOverrides(person.id), roleGrants(person.role)]);
  const own = new Map(overrides.map((o) => [o.permission, o]));
  return (effective?.permissions ?? []).map((p) => {
    const def = getPermissionDefinition(p.key);
    const o = own.get(p.key);
    return {
      key: p.key,
      label: p.label,
      description: def?.description ?? "",
      tier: p.tier,
      selfExcluded: def?.selfExcluded === true,
      role: grants(p.key),
      own: o ? { allowed: o.allowed, reason: o.reason, expiresAt: o.expiresAt ? o.expiresAt.toISOString() : null, expired: o.expired } : null,
      held: p.held,
      why: p.why,
    };
  });
}

async function PermissionsTab({ person, canEdit, lockedWhy }: { person: PersonFacts; canEdit: boolean; lockedWhy: string | null }) {
  const [permissions, grid, fields] = await Promise.all([permissionRows(person), personAccessGrid(person.id), personFieldAccess(person.id)]);
  return (
    <PersonPermissionsPanel
      key={versionOf(person.id, permissions, grid, fields)}
      userId={person.id}
      name={person.name}
      roleName={person.isSuperAdmin ? "Super Admin" : person.roleRef.name}
      permissions={permissions}
      grid={grid ?? []}
      fields={fields}
      canEdit={canEdit}
      lockedWhy={lockedWhy ?? (fields && !fields.editable ? fields.why : null)}
    />
  );
}

async function RecordsTab({ person, canEdit, lockedWhy }: { person: PersonFacts; canEdit: boolean; lockedWhy: string | null }) {
  const grid = await personAccessGrid(person.id);
  return <PersonRecordAccess key={versionOf(person.id, null, grid, null)} userId={person.id} name={person.name} grid={grid ?? []} canEdit={canEdit} lockedWhy={lockedWhy} />;
}

async function FieldsTab({ person, canEdit, lockedWhy }: { person: PersonFacts; canEdit: boolean; lockedWhy: string | null }) {
  const data = await personFieldAccess(person.id);
  if (!data) return <Card className="p-6 text-sm text-muted">Their field access can&apos;t be read.</Card>;
  const editable = canEdit && data.editable;
  return (
    <div className="space-y-4">
      {(lockedWhy ?? data.why) && <p className="text-sm text-muted">{lockedWhy ?? data.why}</p>}
      <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_24rem]">
        <FieldMaskingPanel key={`fields:${versionOf(person.id, null, null, data)}`} userId={person.id} name={person.name} data={data} canEdit={editable} detailed />
        <UnmaskLimitPanel key={`limit:${versionOf(person.id, null, null, data)}`} userId={person.id} name={person.name} data={data} canEdit={editable} />
      </div>
    </div>
  );
}

async function RulesTab({ person }: { person: PersonFacts }) {
  const [effective, fields] = await Promise.all([effectivePermissionsFor(person.id), personFieldAccess(person.id)]);
  const held = new Set((effective?.permissions ?? []).filter((p) => p.held).map((p) => p.key));
  const separated = PERMISSIONS.filter((d) => d.selfExcluded && held.has(d.key));
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="text-sm font-semibold text-text">Separation of duties</CardHeader>
        <CardContent className="space-y-2 text-sm text-muted">
          <p>These are held, and never on a record {person.name} raised themselves — enforced by the server for every request.</p>
          {separated.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {separated.map((d) => (
                <li key={d.key}>
                  <Badge tone="blue">{d.label}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-subtle">They hold none of them.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="text-sm font-semibold text-text">Daily unmasking</CardHeader>
        <CardContent className="space-y-1 text-sm text-muted">
          <p>
            {fields?.limit.effective === null || fields?.limit.effective === undefined ? "No daily limit." : `${fields.limit.effective} leads a day.`} {fields?.limit.why}
          </p>
          {fields && <p>{fields.usage.limit === null ? `${fields.usage.used} unmasked today.` : `${fields.usage.used} / ${fields.usage.limit} unmasked today.`}</p>}
          <p>The same lead is never counted twice in a day, and the count starts again at midnight ({fields?.zone ?? "the workspace's time zone"}).</p>
          <Link href={userPath(person.id, "fields")} className="text-brand hover:underline">
            Change it under Field Permissions
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

async function LoginTab({ person, row, staff, account, viewerId }: { person: PersonFacts; row: StaffRow; staff: Staff; account: Account; viewerId: string }) {
  const [seesSignIns, clock] = await Promise.all([can(viewerId, "access.viewSignIns"), workspaceClock()]);
  const last = seesSignIns ? await db.signIn.findFirst({ where: { userId: person.id }, orderBy: { at: "desc" }, select: { at: true, ip: true, city: true } }) : null;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="pt-1 text-sm font-semibold text-text">Account</h3>
          <UserAccountActions mode="login" {...account} showCards={staff.showCards} />
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <p className="text-muted">
            Status: <span className="text-text">{!person.active ? "Switched off" : row.setupPending ? "Invited — no password chosen yet" : "Active"}</span>
          </p>
          <p className="text-muted">
            Two-factor: <span className="text-text">{person.twoFactorEnabledAt ? `on since ${clock.date(person.twoFactorEnabledAt)}` : "not set up"}</span>
          </p>
          <p className="text-muted">
            Lock: <span className="text-text">{person.lockedAt ? `locked ${clock.dateTime(person.lockedAt)}` : "not locked"}</span>
          </p>
          {seesSignIns && (
            <p className="text-muted">
              Last sign-in: <span className="text-text">{last ? `${clock.dateTime(last.at)}${last.city ? ` · ${last.city}` : ""}${last.ip ? ` · ${last.ip}` : ""}` : "never"}</span>
            </p>
          )}
          {!seesSignIns && staff.showSignIns && (
            <p className="text-muted">
              Last sign-in: <span className="text-text">{row.lastSignIn ? row.lastSignIn.exact : "never"}</span>
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="text-sm font-semibold text-text">How they sign in</CardHeader>
        <CardContent>
          <PersonSignInRule userId={person.id} name={person.name} />
          <p className="mt-3 text-xs text-subtle">
            Two-factor, lockout and session length for everybody are under{" "}
            <Link href="/settings/security" className="text-brand hover:underline">
              Security &amp; data protection
            </Link>
            ; devices, networks and the sign-in log under{" "}
            <Link href="/settings/security/access" className="text-brand hover:underline">
              Devices, networks &amp; sign-ins
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

async function ActivityTab({ person, viewerId }: { person: PersonFacts; viewerId: string }) {
  const [history, superAdmin] = await Promise.all([permissionChangeHistory({ userId: person.id, limit: 25 }), actingAsSuperAdmin(viewerId)]);
  const unmasking = superAdmin ? await listUnmaskEvents({ userId: person.id }, { page: 1, pageSize: 10 }) : null;
  const clock = await workspaceClock();
  return (
    <div className="space-y-4">
      <ChangeHistory rows={history} title={`Changes to ${person.name}'s access`} />
      {unmasking?.ok && (
        <Card>
          <CardHeader className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-text">Recent unmasking</h3>
            <Link href={`/settings/unmasking-logs?userId=${person.id}`} className="text-sm text-brand hover:underline">
              All of it
            </Link>
          </CardHeader>
          <CardContent>
            {unmasking.data.rows.length === 0 ? (
              <p className="text-sm text-subtle">None.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {unmasking.data.rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap justify-between gap-2">
                    <span className="text-text">
                      {r.leadRef ?? "—"} · {r.result.replace("_", " ").toLowerCase()}
                    </span>
                    <span className="text-xs text-subtle">{clock.dateTime(new Date(r.at))}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
      <p className="text-sm text-muted">
        Everything else they did is in the{" "}
        <Link href={`/activity?userId=${person.id}`} className="text-brand hover:underline">
          activity log
        </Link>
        .
      </p>
    </div>
  );
}
