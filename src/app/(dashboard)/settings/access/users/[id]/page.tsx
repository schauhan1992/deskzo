import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, Phone } from "lucide-react";
import { currentUser } from "@/lib/session";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { roleGrants } from "@/lib/authz/role-permission";
import { getPermissionDefinition, PERMISSIONS } from "@/lib/permissions";
import { effectivePermissionsFor } from "@/actions/permission";
import { permissionChangeHistory, userPermissionOverrides } from "@/actions/access";
import { accessPreview, personAccessGrid } from "@/actions/person-access";
import { personFieldAccess } from "@/actions/field-access";
import { listUnmaskEvents } from "@/actions/unmask-log";
import { workspaceClock } from "@/lib/time/workspace";
import { Avatar } from "@/components/ui/avatar";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { ChangeHistory } from "@/components/settings/change-history";
import { PersonSignInRule } from "@/components/settings/staff/person-sign-in-rule";
import { FieldPolicyEditor } from "@/components/settings/access/field-policy-editor";
import { AccessPreview } from "@/components/settings/access/access-preview";
import { PersonAccessEditor, type PersonPermissionRow } from "@/components/settings/people/person-access-editor";
import { PersonHeaderActions } from "@/components/settings/people/person-header-actions";

export const metadata = { title: "Staff access" };

const TABS = [
  { key: "profile", label: "Profile" },
  { key: "role", label: "Role" },
  { key: "permissions", label: "Permissions" },
  { key: "records", label: "Record access" },
  { key: "fields", label: "Field permissions" },
  { key: "rules", label: "Business rules" },
  { key: "login", label: "Login & access" },
  { key: "activity", label: "Activity" },
] as const;

/**
 * One person's access — Staff & roles › a person. What their role gives, the exceptions made for them
 * alone (permissions, record access, field access, their daily unmask limit), and what applies once
 * everything is put together, with why. Opens on "Review who can do what"; changing anything takes
 * "Change roles and permissions", and every editor saves through actions that check it again.
 */
export default async function PersonAccessPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const [{ id }, sp, viewer] = await Promise.all([params, searchParams, currentUser()]);
  if (!viewer || !(await can(viewer.id, "permissions.view"))) notFound();

  const person = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      isSuperAdmin: true,
      phone: true,
      createdAt: true,
      twoFactorEnabledAt: true,
      lockedAt: true,
      department: { select: { name: true } },
      manager: { select: { id: true, name: true } },
      photo: { select: { updatedAt: true } },
      roleRef: { select: { name: true, description: true } },
      _count: { select: { permissionGrants: true, accessLevels: true, fieldPolicies: true } },
    },
  });
  if (!person) notFound();

  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "permissions";
  const [mayManage, viewAsAllowed, ownLimit] = await Promise.all([
    can(viewer.id, "permissions.manage"),
    can(viewer.id, "impersonation.use"),
    db.userUnmaskLimit.count({ where: { userId: person.id } }).catch(() => 0),
  ]);
  const exceptions = person._count.permissionGrants + person._count.accessLevels + person._count.fieldPolicies + ownLimit;
  const lockedWhy = !mayManage
    ? "You can review access but not change it."
    : person.isSuperAdmin
      ? "A super admin holds everything and sees every field. There is nothing to set for them."
      : person.id === viewer.id
        ? "Your own access is changed by another admin."
        : null;
  const canEdit = lockedWhy === null;

  return (
    <div className="animate-fade-rise space-y-5">
      <Link href="/settings/access?tab=staff" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Staff
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <Avatar user={{ id: person.id, name: person.name, photoUpdatedAt: person.photo?.updatedAt ?? null }} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-text">{person.name}</h1>
              {person.active ? <Badge tone="green">Active</Badge> : <Badge>Switched off</Badge>}
              {person.isSuperAdmin && <Badge tone="brand">Super admin</Badge>}
            </div>
            <p className="mt-0.5 text-sm text-muted">
              {person.roleRef.name}
              {person.department ? ` · ${person.department.name}` : ""}
              {person.manager ? ` · reports to ${person.manager.name}` : ""}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              <span className="inline-flex items-center gap-1">
                <Mail className="h-3.5 w-3.5" aria-hidden />
                {person.email}
              </span>
              {person.phone && (
                <span className="inline-flex items-center gap-1">
                  <Phone className="h-3.5 w-3.5" aria-hidden />
                  {person.phone}
                </span>
              )}
              <span className="text-xs text-subtle">{exceptions ? `${exceptions} exception${exceptions === 1 ? "" : "s"} to their role` : "Follows their role exactly"}</span>
            </p>
          </div>
        </div>
        <PersonHeaderActions
          userId={person.id}
          name={person.name}
          exceptions={exceptions}
          canReset={canEdit}
          canViewAs={viewAsAllowed && person.active && person.id !== viewer.id && !person.isSuperAdmin}
        />
      </div>

      <TabNav tabs={TABS.map((t) => ({ ...t }))} activeKey={tab} basePath={`/settings/access/users/${person.id}`} />

      <div className="grid grid-cols-1 items-start gap-5 2xl:grid-cols-[1fr_18rem]">
        <div className="min-w-0">
          {tab === "profile" && <ProfileTab person={person} />}
          {tab === "role" && <RoleTab person={person} />}
          {(tab === "permissions" || tab === "records") && <AccessTab view={tab} person={person} canEdit={canEdit} lockedWhy={lockedWhy} />}
          {tab === "fields" && <FieldsTab person={person} canEdit={canEdit} lockedWhy={lockedWhy} />}
          {tab === "rules" && <RulesTab person={person} />}
          {tab === "login" && <LoginTab person={person} viewerId={viewer.id} />}
          {tab === "activity" && <ActivityTab person={person} viewerId={viewer.id} />}
        </div>
        <AccessPreview title="Effective access" fixedUserId={person.id} initial={await accessPreview({ userId: person.id })} />
      </div>
    </div>
  );
}

type Person = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  isSuperAdmin: boolean;
  createdAt: Date;
  twoFactorEnabledAt: Date | null;
  lockedAt: Date | null;
  department: { name: string } | null;
  manager: { id: string; name: string } | null;
  roleRef: { name: string; description: string | null };
};

async function ProfileTab({ person }: { person: Person }) {
  const clock = await workspaceClock();
  const rows: [string, string][] = [
    ["Name", person.name],
    ["Email", person.email],
    ["Role", person.roleRef.name],
    ["Department", person.department?.name ?? "—"],
    ["Reports to", person.manager?.name ?? "—"],
    ["Account", person.active ? "Active" : "Switched off"],
    ["Added", clock.date(person.createdAt)],
  ];
  return (
    <Card>
      <CardHeader className="text-sm font-semibold text-text">Profile</CardHeader>
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
          Name, role, department and manager are changed from the pencil on their row under{" "}
          <Link href="/settings/access?tab=staff" className="text-brand hover:underline">
            Staff
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}

async function RoleTab({ person }: { person: Person }) {
  const preview = await accessPreview({ role: person.role });
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-text">{person.roleRef.name}</h2>
          <p className="mt-0.5 text-xs text-muted">{person.roleRef.description ?? "What everybody in this role gets by default."}</p>
        </div>
        <Link href={`/settings/access?tab=roles&role=${encodeURIComponent(person.role)}`} className="text-sm text-brand hover:underline">
          Open the role
        </Link>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted">What the role gives on its own, before anything made for {person.name} alone:</p>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {(preview ?? []).map((m) => (
            <li key={m.key} className="flex items-center justify-between rounded-base border border-line px-3 py-2 text-sm">
              <span className="text-text">{m.label}</span>
              <Badge tone={m.standing === "full" ? "green" : m.standing === "limited" ? "amber" : "red"}>{m.standing === "full" ? "Full access" : m.standing === "limited" ? "Limited" : "No access"}</Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

async function AccessTab({ view, person, canEdit, lockedWhy }: { view: "permissions" | "records"; person: Person; canEdit: boolean; lockedWhy: string | null }) {
  const [effective, overrides, grants, grid] = await Promise.all([
    effectivePermissionsFor(person.id),
    userPermissionOverrides(person.id),
    roleGrants(person.role),
    personAccessGrid(person.id),
  ]);
  const own = new Map(overrides.map((o) => [o.permission, o]));
  const permissions: PersonPermissionRow[] = (effective?.permissions ?? []).map((p) => {
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
  return <PersonAccessEditor key={`${person.id}:${view}`} view={view} userId={person.id} name={person.name} permissions={permissions} grid={grid ?? []} canEdit={canEdit} lockedWhy={lockedWhy} />;
}

async function FieldsTab({ person, canEdit, lockedWhy }: { person: Person; canEdit: boolean; lockedWhy: string | null }) {
  const data = await personFieldAccess(person.id);
  if (!data) return <p className="text-sm text-muted">Their field access can&apos;t be read.</p>;
  return <FieldPolicyEditor key={person.id} mode="person" userId={person.id} name={person.name} data={data} canEdit={canEdit && data.editable} lockedWhy={lockedWhy ?? data.why} />;
}

async function RulesTab({ person }: { person: Person }) {
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
          <Link href={`/settings/access/users/${person.id}?tab=fields`} className="text-brand hover:underline">
            Change it under Field permissions
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

async function LoginTab({ person, viewerId }: { person: Person; viewerId: string }) {
  const [seesSignIns, clock] = await Promise.all([can(viewerId, "access.viewSignIns"), workspaceClock()]);
  const last = seesSignIns ? await db.signIn.findFirst({ where: { userId: person.id }, orderBy: { at: "desc" }, select: { at: true, ip: true, city: true, country: true } }) : null;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="text-sm font-semibold text-text">Account</CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <p className="text-muted">
            Two-factor: <span className="text-text">{person.twoFactorEnabledAt ? `on since ${clock.date(person.twoFactorEnabledAt)}` : "not set up"}</span>
          </p>
          <p className="text-muted">
            Lock: <span className="text-text">{person.lockedAt ? `locked ${clock.dateTime(person.lockedAt)}` : "not locked"}</span>
          </p>
          {seesSignIns && (
            <p className="text-muted">
              Last sign-in:{" "}
              <span className="text-text">{last ? `${clock.dateTime(last.at)}${last.city ? ` · ${last.city}` : ""}${last.ip ? ` · ${last.ip}` : ""}` : "never"}</span>
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="text-sm font-semibold text-text">How they sign in</CardHeader>
        <CardContent>
          <PersonSignInRule userId={person.id} name={person.name} />
          <p className="mt-3 text-xs text-subtle">
            Devices, networks and the sign-in log are under{" "}
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

async function ActivityTab({ person, viewerId }: { person: Person; viewerId: string }) {
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
