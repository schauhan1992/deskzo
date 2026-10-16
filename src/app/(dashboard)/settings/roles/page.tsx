import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Eye, Grid3x3 } from "lucide-react";
import { currentUser } from "@/lib/session";
import { db } from "@/lib/db";
import { listRolesForScreen } from "@/actions/role";
import { getPermissionMatrix } from "@/actions/permission";
import { permissionChangeHistory } from "@/actions/access";
import { getModuleStates } from "@/actions/module";
import { roleAccessLevels } from "@/actions/access-levels";
import { roleFieldAccess } from "@/actions/field-access";
import { accessPreview } from "@/actions/person-access";
import { ROLE_PRESETS } from "@/lib/authz/presets";
import { OWN_ACCESS_KEYS } from "@/lib/authz/guards";
import { can, permissionsFor, resolveUserPermissions } from "@/lib/authz/resolve";
import { permissionModules } from "@/lib/staff/permission-modules";
import { STANDING_WORDS } from "@/lib/staff/access-modules";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { ChangeHistory } from "@/components/settings/change-history";
import { RolesList, CreateRoleButton, type RoleListItem } from "@/components/settings/roles/roles-list";
import { rolePath } from "@/lib/staff/staff-paths";
import { RoleHeader } from "@/components/settings/roles/role-header";
import { RoleAccessEditor } from "@/components/settings/roles/role-access-editor";
import { RoleModulesWorkspace } from "@/components/settings/roles/role-modules-workspace";
import { RolePresets } from "@/components/settings/roles/role-presets";
import { FieldPolicyEditor } from "@/components/settings/access/field-policy-editor";
import type { CatalogueEntry, ModuleStates } from "@/components/settings/staff/types";

export const metadata = { title: "Roles & Permissions" };

const ROLE_TABS = [
  { key: "modules", label: "Module Access" },
  { key: "records", label: "Record Access" },
  { key: "fields", label: "Field Permissions" },
  { key: "rules", label: "Business Rules" },
  { key: "users", label: "Users" },
  { key: "summary", label: "Summary" },
] as const;

/**
 * Settings › Staff › Roles & Permissions: the roles, searchable, beside the one open — what it may do
 * module by module (Allow, record scope, conditions, and whether the module is in its menu at all),
 * which records it reaches, which lead fields it sees and unmasks, its business rules, its people and
 * a summary — with a preview of what it, or one of its people, can reach.
 *
 * `permissions.view` opens it; `permissions.manage` changes anything, and every editor saves through
 * the actions that check that again. The permission matrix (every role side by side, the presets) is
 * a page of its own, behind "Permission matrix".
 */
export default async function RolesAndPermissionsPage({ searchParams }: { searchParams: Promise<{ role?: string; tab?: string }> }) {
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "permissions.view"))) notFound();
  const sp = await searchParams;

  const [mayManage, viewerRow, roleRows, activeByRole, superAdmins] = await Promise.all([
    can(viewer.id, "permissions.manage"),
    db.user.findUnique({ where: { id: viewer.id }, select: { isSuperAdmin: true } }),
    listRolesForScreen(),
    // Who holds each role and can sign in — the super admin counted on their own, not Admin's.
    db.user.groupBy({ by: ["role"], where: { active: true, isSuperAdmin: false }, _count: { _all: true } }),
    db.user.count({ where: { isSuperAdmin: true, active: true } }),
  ]);
  const viewerIsSuperAdmin = viewerRow?.isSuperAdmin ?? false;
  const active = new Map(activeByRole.map((r) => [r.role, r._count._all]));
  const roles: RoleListItem[] = (roleRows.ok ? roleRows.data : []).map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    isSystem: r.isSystem,
    active: r.active,
    people: active.get(r.key) ?? 0,
  }));
  const selected = roles.find((r) => r.key === sp.role) ?? roles.find((r) => r.key !== "ADMIN") ?? roles[0] ?? null;
  const tab = ROLE_TABS.some((t) => t.key === sp.tab) ? sp.tab! : "modules";

  return (
    <div className="animate-fade-rise space-y-5">
      <Link href="/settings" className="inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Settings
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text">Roles &amp; Permissions</h1>
          <p className="mt-1 text-sm text-muted">Create and manage roles with fine-grained access control across modules, actions, records and fields.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/settings/roles/matrix"
            className="inline-flex h-9 items-center gap-2 rounded-base border border-line-strong bg-surface px-3.5 text-sm text-text shadow-sm transition-colors hover:bg-surface-sunken"
          >
            <Grid3x3 className="h-4 w-4" aria-hidden />
            Permission matrix
          </Link>
          {mayManage && <CreateRoleButton />}
        </div>
      </div>

      {!mayManage && (
        <Card className="flex items-center gap-2 px-4 py-3 text-sm text-muted">
          <Eye className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
          You can review roles but not change them. Everything here is read-only.
        </Card>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <RolesList roles={roles} selected={selected?.key ?? null} mayManage={mayManage} superAdmins={superAdmins} />
        {selected ? (
          <div className="min-w-0 space-y-5">
            <Card>
              <CardContent className="space-y-4 pb-0 pt-5">
                <RoleHeader role={selected} mayManage={mayManage} />
                <TabNav
                  tabs={ROLE_TABS.map((t) => ({ key: t.key, label: t.key === "users" ? `${t.label} (${selected.people})` : t.label }))}
                  activeKey={tab}
                  basePath="/settings/roles"
                  otherParams={{ role: selected.key }}
                />
              </CardContent>
            </Card>
            {tab === "modules" && <ModulesTab role={selected.key} mayManage={mayManage} viewerId={viewer.id} viewerIsSuperAdmin={viewerIsSuperAdmin} />}
            {tab === "records" && <RecordsTab role={selected.key} mayManage={mayManage} viewerId={viewer.id} viewerIsSuperAdmin={viewerIsSuperAdmin} />}
            {tab === "fields" && <FieldsTab role={selected.key} />}
            {tab === "rules" && <RulesTab role={selected.key} mayManage={mayManage} />}
            {tab === "users" && <UsersTab role={selected.key} />}
            {tab === "summary" && <SummaryTab role={selected.key} />}
          </div>
        ) : (
          <Card className="p-6 text-sm text-muted">There are no roles yet.</Card>
        )}
      </div>
    </div>
  );
}

/** What the role editors need: the permission catalogue, the role's answers, and who is looking. */
async function editorData(role: string, viewerId: string) {
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
  const modules: ModuleStates = Object.fromEntries(moduleStates.map((m) => [m.key, { key: m.key, label: m.label, entitled: m.entitled, switchedOn: m.switchedOn }]));
  // Which of the two keys that open these screens the viewer holds *through their role*: those boxes
  // are locked on their own role, as `assertKeepsOwnAccessAdmin` would refuse unticking them.
  const ownAccessThroughRole = OWN_ACCESS_KEYS.filter((key) => {
    const source = resolved.sources.get(key);
    return source?.via === "roleDefault" || source?.via === "adminDefault" || (source?.via === "roleOverride" && source.allowed);
  });
  return {
    catalogue,
    modules,
    held: matrix.filter((p) => p.roles[role]).map((p) => p.key),
    selfExcluded: matrix.filter((p) => p.selfExcluded).map((p) => p.key),
    grid: grid?.rows ?? [],
    gridWhy: grid ? grid.why : "This role's records can't be read.",
    viewer: { holds: viewerHolds.map(String), role: resolved.role ?? "", ownAccessThroughRole: [...ownAccessThroughRole] },
  };
}

async function ModulesTab({ role, mayManage, viewerId, viewerIsSuperAdmin }: { role: string; mayManage: boolean; viewerId: string; viewerIsSuperAdmin: boolean }) {
  const [data, people, roleRow] = await Promise.all([
    editorData(role, viewerId),
    db.user.findMany({ where: { role, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true }, take: 200 }),
    db.role.findUnique({ where: { key: role }, select: { name: true } }),
  ]);
  return (
    <RoleModulesWorkspace
      key={role}
      roleKey={role}
      catalogue={data.catalogue}
      held={data.held}
      grid={data.grid}
      gridWhy={data.gridWhy}
      selfExcluded={data.selfExcluded}
      moduleStates={data.modules}
      viewer={{ mayManage, isSuperAdmin: viewerIsSuperAdmin, ...data.viewer }}
      people={people.map((p) => ({ ...p, roleName: roleRow?.name ?? role }))}
      roleSummaryHref={rolePath(role, "summary")}
    />
  );
}

async function RecordsTab({ role, mayManage, viewerId, viewerIsSuperAdmin }: { role: string; mayManage: boolean; viewerId: string; viewerIsSuperAdmin: boolean }) {
  const data = await editorData(role, viewerId);
  return (
    <Card>
      <CardContent className="pt-5">
        <RoleAccessEditor
          key={`${role}:records`}
          view="records"
          roleKey={role}
          catalogue={data.catalogue}
          selfExcluded={data.selfExcluded}
          held={data.held}
          grid={data.grid}
          gridWhy={data.gridWhy}
          modules={data.modules}
          viewer={{ mayManage, isSuperAdmin: viewerIsSuperAdmin, ...data.viewer }}
        />
      </CardContent>
    </Card>
  );
}

async function FieldsTab({ role }: { role: string }) {
  const data = await roleFieldAccess(role);
  if (!data) return <p className="text-sm text-muted">This role&apos;s field access can&apos;t be read.</p>;
  return <FieldPolicyEditor key={role} mode="role" role={role} data={data} canEdit={data.editable} lockedWhy={data.why} />;
}

async function RulesTab({ role, mayManage }: { role: string; mayManage: boolean }) {
  const [matrix, fields] = await Promise.all([getPermissionMatrix(), roleFieldAccess(role)]);
  const held = matrix.filter((p) => p.roles[role]);
  const separated = held.filter((p) => p.selfExcluded);
  const labels = Object.fromEntries(matrix.map((p) => [p.key, p.label]));
  return (
    <Card>
      <CardContent className="space-y-5 pt-5">
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-text">Separation of duties</h3>
          <p className="text-sm text-muted">
            These permissions are never used on a record the person raised themselves — an order they punched, a claim they made — whoever holds them. The rule is
            the permission&apos;s own, enforced on the server.
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
            <Link href={rolePath(role, "fields")} className="text-brand hover:underline">
              Change it under Field Permissions
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
      </CardContent>
    </Card>
  );
}

async function UsersTab({ role }: { role: string }) {
  const people = await db.user.findMany({
    where: { role },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: { id: true, name: true, email: true, active: true, _count: { select: { permissionGrants: true } } },
  });
  return (
    <Card>
      {people.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">Nobody holds this role.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
              <tr>
                <th className="px-4 py-2.5">User</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Exceptions</th>
                <th className="px-4 py-2.5 text-right">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="text-text">{p.name}</span>
                    <span className="block text-xs text-subtle">{p.email}</span>
                  </td>
                  <td className="px-4 py-2.5">{p.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                  <td className="px-4 py-2.5 text-muted">{p._count.permissionGrants || "—"}</td>
                  <td className="px-4 py-2.5 text-right">
                    <Link href={`/settings/users?user=${p.id}&tab=permissions`} className="text-sm text-brand hover:underline">
                      Permissions
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

async function SummaryTab({ role }: { role: string }) {
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
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-subtle">Permissions</p>
          <p className="mt-0.5 text-xl font-semibold text-text">
            {held.length} <span className="text-sm font-normal text-muted">of {matrix.filter((p) => p.group !== "Sections").length}</span>
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-subtle">Records it reaches</p>
          <p className="mt-0.5 text-xl font-semibold text-text">
            {(grid?.rows ?? []).filter((r) => (r.cells.view.stored ?? r.cells.view.derived) !== "NONE").length}{" "}
            <span className="text-sm font-normal text-muted">of {grid?.rows.length ?? 0} types</span>
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-subtle">Lead fields masked</p>
          <p className="mt-0.5 text-xl font-semibold text-text">
            {masked.length} <span className="text-sm font-normal text-muted">· {fields?.dailyLimit ? `${fields.dailyLimit}/day` : "no daily limit"}</span>
          </p>
        </Card>
      </div>
      {preview && (
        <Card>
          <CardContent className="pt-4">
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {preview.map((m) => (
                <li key={m.key} className="flex items-center justify-between rounded-base border border-line px-3 py-2 text-sm">
                  <span className="text-text">{m.label}</span>
                  <Badge tone={m.standing === "full" ? "green" : m.standing === "limited" ? "amber" : "red"}>{STANDING_WORDS[m.standing]}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <ChangeHistory rows={history} title="This role's history" />
    </div>
  );
}
