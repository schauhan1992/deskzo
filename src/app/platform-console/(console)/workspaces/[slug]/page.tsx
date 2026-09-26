import { notFound } from "next/navigation";
import { consoleMigrateWorkspace, consoleResume } from "@/actions/platform/console";
import { AuditTable } from "@/components/console/audit-table";
import { ConsoleAction } from "@/components/console/console-action";
import { Cell, DataTable, PageTitle, Section, StatusBadge, when } from "@/components/console/console-ui";
import { DeprovisionForm, EnterAsSupport, SuspendForm } from "@/components/console/workspace-controls";
import { LimitOverridesForm, ModuleOverrideForm, RemoveOverride, WorkspacePlansForm } from "@/components/console/plan-forms";
import { consoleStaff, isOwner, mayEnterWorkspaces, mayManage } from "@/lib/platform/console-page";
import { plansList, staffNames, tenantDetail } from "@/lib/platform/console-data";
import { entitledModuleKeys } from "@/lib/entitlements";
import { getModuleDefinition } from "@/lib/modules";
import { moduleCatalogue } from "@/lib/platform/plans";

/**
 * One workspace, as the control plane knows it. Nothing here is read from inside the workspace — staff
 * who need that go in as support, on its super admin's grant.
 */
export default async function ConsoleWorkspacePage({ params }: PageProps<"/platform-console/workspaces/[slug]">) {
  const staff = await consoleStaff();
  const { slug } = await params;
  const [detail, names, plans] = await Promise.all([tenantDetail(slug), staffNames(), plansList()]);
  if (!detail) notFound();
  const { tenant, host, grant, grants, leases, latest, subscriptions, overrides, entitlements } = detail;
  const seller = ["OWNER", "ADMIN", "BILLING"].includes(staff.role);
  const liveItems = subscriptions.filter((s) => s.status !== "CANCELLED").flatMap((s) => s.items);
  const modulesNow = entitledModuleKeys(entitlements, tenant.country).filter((key) => !getModuleDefinition(key)?.core);
  const catalogue = moduleCatalogue();
  const open = tenant.status === "ACTIVE" || tenant.status === "MIGRATING";

  return (
    <>
      <PageTitle title={tenant.name}>
        {host} · <StatusBadge status={tenant.status} />
        {tenant.isDefault && " · the installation's first workspace"}
      </PageTitle>

      <Section title="About it">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {[
            ["Owner", tenant.ownerEmail ?? "—"],
            ["Country · currency · time zone", `${tenant.country} · ${tenant.currency} · ${tenant.timezone}`],
            ["Database", tenant.dbName ?? "the installation's own"],
            ["Region", tenant.region],
            ["Schema", `${tenant.schemaVersion ?? "—"}${tenant.schemaVersion !== latest ? ` (latest ${latest ?? "—"})` : ""}`],
            ["Created", when(tenant.createdAt)],
            ["Held since", when(tenant.suspendedAt)],
            ["Closed", when(tenant.deprovisionedAt)],
          ].map(([term, value]) => (
            <div key={term}>
              <dt className="text-xs text-muted">{term}</dt>
              <dd className="break-words text-text">{value}</dd>
            </div>
          ))}
        </dl>
        {tenant.domains.length > 0 && (
          <p className="mt-3 text-xs text-muted">
            Also reached at: {tenant.domains.map((d) => `${d.host} (${d.kind.toLowerCase()})`).join(", ")}
          </p>
        )}
      </Section>

      <Section title="Plan">
        <dl className="mb-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted">On</dt>
            <dd className="text-text">{liveItems.length ? liveItems.map((i) => (i.quantity > 1 ? `${i.plan.name} ×${i.quantity}` : i.plan.name)).join(", ") : "No plan — the core only"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Users</dt>
            <dd className="text-text">
              {entitlements.seats ?? "no limit"}
              {tenant.seatOverride !== null && <span className="ml-1 text-xs text-warning">overridden</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Copilot tokens a month</dt>
            <dd className="text-text">
              {entitlements.copilotTokens === null ? "no limit" : entitlements.copilotTokens === 0 ? "none" : entitlements.copilotTokens.toLocaleString("en-IN")}
              {tenant.copilotTokenOverride !== null && <span className="ml-1 text-xs text-warning">overridden</span>}
            </dd>
          </div>
        </dl>
        <p className="mb-4 text-xs text-muted">
          Modules: {entitlements.all ? "every module" : modulesNow.map((key) => getModuleDefinition(key)?.label ?? key).join(", ")}
          {tenant.country !== "IN" && " — India-only modules and features are left out in " + tenant.country + "."}
        </p>
        {overrides.length > 0 && (
          <div className="mb-4">
            <DataTable head={["Module", "Override", "Why", "When", ""]}>
              {overrides.map((o) => (
                <tr key={o.moduleKey}>
                  <Cell>{getModuleDefinition(o.moduleKey)?.label ?? o.moduleKey}</Cell>
                  <Cell className={o.granted ? "text-success" : "text-danger"}>{o.granted ? "added" : "taken away"}</Cell>
                  <Cell className="text-muted">{o.reason}</Cell>
                  <Cell className="whitespace-nowrap text-muted">{when(o.createdAt)}</Cell>
                  <Cell>{mayManage(staff) && <RemoveOverride tenantId={tenant.id} moduleKey={o.moduleKey} />}</Cell>
                </tr>
              ))}
            </DataTable>
          </div>
        )}
        {seller && tenant.status !== "DEPROVISIONED" && (
          <div className="space-y-5">
            <WorkspacePlansForm
              tenantId={tenant.id}
              country={tenant.country}
              owner={isOwner(staff)}
              current={liveItems.map((i) => ({ planKey: i.plan.key, quantity: i.quantity }))}
              plans={plans.map((p) => ({ key: p.key, name: p.name, kind: p.kind, active: p.active, countries: p.countries }))}
            />
            {mayManage(staff) && <ModuleOverrideForm tenantId={tenant.id} catalogue={catalogue} />}
            <LimitOverridesForm tenantId={tenant.id} seats={tenant.seatOverride} copilotTokens={tenant.copilotTokenOverride} />
          </div>
        )}
      </Section>

      <Section title="Support access">
        {grant ? (
          <p className="mb-3 text-sm text-text">
            Granted by {grant.grantedByName}: <span className="font-medium">{grant.level === "ADMIN" ? "administrator" : "read-only"}</span>, until {when(grant.expiresAt)}.
            <span className="block text-xs text-muted">Reason given: {grant.reason}</span>
          </p>
        ) : (
          <p className="mb-3 text-sm text-muted">Not granted. Only the workspace&apos;s super admin can grant it, from its Security settings.</p>
        )}
        {grant && mayEnterWorkspaces(staff) && tenant.status === "ACTIVE" && <EnterAsSupport tenantId={tenant.id} />}
        {grants.length > 0 && (
          <div className="mt-4">
            <DataTable head={["Granted", "Level", "By", "Until", "Ended"]}>
              {grants.map((g) => (
                <tr key={g.id}>
                  <Cell className="whitespace-nowrap text-muted">{when(g.createdAt)}</Cell>
                  <Cell>{g.level.toLowerCase()}</Cell>
                  <Cell>{g.grantedByName}</Cell>
                  <Cell className="whitespace-nowrap text-muted">{when(g.expiresAt)}</Cell>
                  <Cell className="whitespace-nowrap text-muted">{when(g.revokedAt)}</Cell>
                </tr>
              ))}
            </DataTable>
          </div>
        )}
      </Section>

      {mayManage(staff) && tenant.status !== "DEPROVISIONED" && (
        <Section title="Hold, reopen, migrate">
          <div className="space-y-3">
            {tenant.status === "SUSPENDED" ? (
              <ConsoleAction action={consoleResume.bind(null, tenant.id)} label="Reopen workspace" variant="primary" />
            ) : (
              tenant.status !== "PROVISIONING" && <SuspendForm tenantId={tenant.id} />
            )}
            {open && (
              <div>
                <ConsoleAction action={consoleMigrateWorkspace.bind(null, tenant.slug)} label="Migrate it now" done="Migrated." confirm={`Run the workspace migrations on ${tenant.slug} now?`} />
                <p className="mt-1 text-xs text-muted">Brings its database to the latest schema; one held for a failed migration is opened again when it works.</p>
              </div>
            )}
          </div>
        </Section>
      )}

      {isOwner(staff) && !tenant.isDefault && tenant.status !== "DEPROVISIONED" && (
        <Section title="Close workspace">
          <DeprovisionForm tenantId={tenant.id} slug={tenant.slug} />
        </Section>
      )}

      <Section title="Scheduled jobs">
        <DataTable head={["Job", "Last started", "Last finished", "Outcome"]} empty="No scheduled job has run for it yet.">
          {leases.map((l) => (
            <tr key={l.job}>
              <Cell className="font-mono text-xs">{l.job}</Cell>
              <Cell className="whitespace-nowrap text-muted">{when(l.lastStartedAt)}</Cell>
              <Cell className="whitespace-nowrap text-muted">{when(l.lastFinishedAt)}</Cell>
              <Cell>{l.lastOk === null ? "—" : l.lastOk ? "ok" : <span className="text-danger">{l.lastError?.split("\n")[0] ?? "failed"}</span>}</Cell>
            </tr>
          ))}
        </DataTable>
      </Section>

      <Section title="Terminals routed to it">
        <DataTable head={["Serial", "Added", "Last seen"]} empty="None.">
          {tenant.deviceRoutes.map((d) => (
            <tr key={d.serial}>
              <Cell className="font-mono text-xs">{d.serial}</Cell>
              <Cell className="text-muted">{when(d.createdAt)}</Cell>
              <Cell className="text-muted">{when(d.lastSeenAt)}</Cell>
            </tr>
          ))}
        </DataTable>
      </Section>

      <Section title="Migrations">
        <DataTable head={["Started", "From", "To", "Outcome"]} empty="None recorded.">
          {tenant.migrationRuns.map((m) => (
            <tr key={m.id}>
              <Cell className="whitespace-nowrap text-muted">{when(m.startedAt)}</Cell>
              <Cell className="font-mono text-xs">{m.fromVersion?.slice(0, 14) ?? "—"}</Cell>
              <Cell className="font-mono text-xs">{m.toVersion?.slice(0, 14) ?? "—"}</Cell>
              <Cell>{m.ok === null ? "running" : m.ok ? "ok" : <span className="text-danger">failed</span>}</Cell>
            </tr>
          ))}
        </DataTable>
      </Section>

      <Section title="Its audit log">
        <AuditTable rows={tenant.auditLog} names={names} showWorkspace={false} />
      </Section>
    </>
  );
}
