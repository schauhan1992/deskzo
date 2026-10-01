import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CopyField } from "@/components/console/kit/copy-field";
import { PageHeader } from "@/components/console/kit/page-header";
import { RememberWorkspace } from "@/components/console/kit/remember-workspace";
import { StandingPill, StatusPill, TenantStatusPill } from "@/components/console/kit/status";
import { TabPanel } from "@/components/console/kit/tab-panel";
import { ConsoleTabs } from "@/components/console/kit/tabs";
import { TagChips } from "@/components/console/kit/tag-chips";
import { TenantSupportRequests } from "@/components/console/support/tenant-requests";
import { ActivityTab } from "@/components/console/workspace/activity-tab";
import { AttributionPanel } from "@/components/console/workspace/attribution-panel";
import { WorkspaceBanners } from "@/components/console/workspace/banners";
import { BillingTab } from "@/components/console/workspace/billing-tab";
import { HeaderActions } from "@/components/console/workspace/header-actions";
import { NotesTab } from "@/components/console/workspace/notes-tab";
import { OpsTab } from "@/components/console/workspace/ops-tab";
import { OverviewTab } from "@/components/console/workspace/overview-tab";
import { PlanTab } from "@/components/console/workspace/plan-tab";
import { SummaryStrip } from "@/components/console/workspace/summary-strip";
import { SupportTab } from "@/components/console/workspace/support-tab";
import { UsageTab } from "@/components/console/workspace/usage-tab";
import { dayMonthYear } from "@/lib/console-shared/format";
import { WORKSPACE_TAB_LABELS } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { WORKSPACE_TABS, parseWorkspaceTab, type WorkspaceTab } from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { alertsForTenant } from "@/lib/platform/alerts";
import { workspaceAttribution } from "@/lib/partners/console-data";
import { consoleStaff } from "@/lib/platform/console-page";
import { workspaceBilling, workspaceHeader, workspaceNotes, workspaceOps, workspacePlan, workspaceSupport, workspaceTimeline, workspaceUsage } from "@/lib/platform/workspace-data";
import { supportRequestsForTenant } from "@/lib/support/console";

/** The tab bar's id prefix — `TabLink` (header-actions.tsx) finds the tabs by it. */
const TABS_ID = "ws";

export async function generateMetadata({ params }: PageProps<"/platform-console/workspaces/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${String(slug).slice(0, 64)} · Workspaces` };
}

/**
 * Workspace 360 (spec §3.4): everything the control plane knows about one workspace, and every
 * control over it a role may use. Nothing here is read from inside the workspace — staff who need
 * that go in as support, on its super admin's grant.
 *
 * The header loads first (an unknown slug is a 404), then every tab's loader at once. All eight tab
 * panels are rendered, the inactive ones `hidden`, so switching is instant and every tab's text is
 * in the first markup; `?tab=` picks the one shown. Every control is drawn per role — the Danger
 * zone only for owners and admins, Close only for owners — and each action checks again itself.
 */
export default async function ConsoleWorkspacePage({ params, searchParams }: PageProps<"/platform-console/workspaces/[slug]">) {
  const staff = await consoleStaff(PAGE_ROLES.workspaces);
  const caps = capsFor(staff.role);
  const { slug } = await params;
  const header = await workspaceHeader(slug, staff.id);
  if (!header) notFound();

  const { tenant } = header;
  const id = tenant.id;
  const [plan, billing, usage, support, ops, notes, timeline, alerts, supportRequests, attribution] = await Promise.all([
    workspacePlan(id),
    workspaceBilling(id),
    workspaceUsage(id, 90),
    workspaceSupport(id, staff.id),
    workspaceOps(id),
    workspaceNotes(id, staff.id),
    workspaceTimeline(id, { limit: 50 }),
    alertsForTenant(id, staff.role),
    // Its Contact Support requests, for the staff who may open the Support inbox.
    caps.viewSupport ? supportRequestsForTenant(id) : null,
    // Its partner (spec §9.2): every staff member reads it; SELLERS change it.
    workspaceAttribution(id),
  ]);
  const tab = parseWorkspaceTab(await searchParams);

  const base = `/workspaces/${encodeURIComponent(tenant.slug)}`;
  const tabHref = (key: WorkspaceTab) => (key === "overview" ? base : `${base}?tab=${key}`);
  const migrate = tenant.status === "MIGRATING" ? "retry" : tenant.status === "ACTIVE" && header.schemaBehind ? "migrate" : null;
  const closed = tenant.status === "DEPROVISIONED";

  const chips = (
    <>
      <TenantStatusPill status={tenant.status} suspendedFor={tenant.suspendedFor} />
      {!closed && <StandingPill kind={header.standing.kind} at={header.standingAt} asOf={header.asOf} />}
      {tenant.isDefault && <StatusPill tone="brand">Installation&apos;s own</StatusPill>}
      {tenant.tags.length > 0 && <TagChips tags={tenant.tags.map((t) => ({ tag: t, href: `/workspaces?tag=${encodeURIComponent(t)}` }))} />}
    </>
  );

  const subtitle = (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {closed ? (
        <span className="font-mono text-xs break-all text-muted">{header.primaryHost}</span>
      ) : (
        <CopyField value={header.primaryHost} label="address" href={tenant.status === "ACTIVE" ? header.hostUrl : undefined} hrefLabel="Open" />
      )}
      {header.primaryHost !== header.host && <span className="font-mono text-xs text-muted">{header.host}</span>}
      <span aria-hidden="true" className="text-subtle">
        ·
      </span>
      <span className="text-xs">{`${tenant.country} · ${tenant.currency} · ${tenant.timezone}`}</span>
      <span aria-hidden="true" className="text-subtle">
        ·
      </span>
      <span className="text-xs">{`created ${dayMonthYear(tenant.createdAt)}`}</span>
    </span>
  );

  return (
    <>
      <RememberWorkspace slug={tenant.slug} name={tenant.name} />
      <PageHeader
        title={tenant.name}
        crumbs={[{ label: "Workspaces", href: "/workspaces" }, { label: tenant.name }]}
        chips={chips}
        subtitle={subtitle}
        asOf={header.asOf}
        actions={
          caps.role === "READONLY" ? undefined : (
            <HeaderActions
              tenant={{ id, slug: tenant.slug, name: tenant.name, status: tenant.status, suspendedFor: tenant.suspendedFor }}
              caps={caps}
              grantLive={!!header.grant}
              migrate={migrate}
              gatewayPaying={header.gatewayPaying.length > 0}
              hostUrl={header.hostUrl}
              isDefault={tenant.isDefault}
            />
          )
        }
      />

      <div className="space-y-6">
        <WorkspaceBanners header={header} caps={caps} setup={ops.jobs[0] ?? null} />
        <SummaryStrip header={header} plan={plan} usage={usage} support={support} />

        <div>
          <ConsoleTabs
            label="Workspace sections"
            idPrefix={TABS_ID}
            active={tab}
            tabs={WORKSPACE_TABS.map((key) => ({
              key,
              label: WORKSPACE_TAB_LABELS[key],
              href: tabHref(key),
              count: key === "notes" && notes.length > 0 ? notes.length : undefined,
            }))}
          />
          <div className="mt-6">
            <TabPanel idPrefix={TABS_ID} tabKey="overview" active={tab === "overview"}>
              <OverviewTab header={header} plan={plan} support={support} timeline={timeline} alerts={alerts} notes={notes} caps={caps} modes={billing.modes} domains={ops.domains} />
              <AttributionPanel view={attribution} tenant={{ id, name: tenant.name }} caps={caps} />
            </TabPanel>
            <TabPanel idPrefix={TABS_ID} tabKey="plan" active={tab === "plan"}>
              <PlanTab header={header} plan={plan} caps={caps} />
            </TabPanel>
            <TabPanel idPrefix={TABS_ID} tabKey="billing" active={tab === "billing"}>
              <BillingTab header={header} billing={billing} caps={caps} />
            </TabPanel>
            <TabPanel idPrefix={TABS_ID} tabKey="usage" active={tab === "usage"}>
              <UsageTab usage={usage} />
            </TabPanel>
            <TabPanel idPrefix={TABS_ID} tabKey="support" active={tab === "support"}>
              <div className="space-y-6">
                <SupportTab header={header} support={support} caps={caps} />
                {supportRequests && <TenantSupportRequests slug={tenant.slug} rows={supportRequests} />}
              </div>
            </TabPanel>
            <TabPanel idPrefix={TABS_ID} tabKey="operations" active={tab === "operations"}>
              <OpsTab ops={ops} tenant={{ id, slug: tenant.slug, status: tenant.status }} caps={caps} />
            </TabPanel>
            <TabPanel idPrefix={TABS_ID} tabKey="activity" active={tab === "activity"}>
              <ActivityTab tenantId={id} slug={tenant.slug} initial={timeline} todayKey={timeline.todayKey} />
            </TabPanel>
            <TabPanel idPrefix={TABS_ID} tabKey="notes" active={tab === "notes"}>
              <NotesTab tenantId={id} notes={notes} tags={tenant.tags} caps={caps} />
            </TabPanel>
          </div>
        </div>
      </div>
    </>
  );
}
