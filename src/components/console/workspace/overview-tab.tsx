import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, CircleCheck, Globe, Pin } from "lucide-react";
import { consoleResume } from "@/actions/platform/console";
import { ActionButton } from "@/components/console/kit/action-button";
import { ActivityFeed } from "@/components/console/kit/activity-feed";
import { CopyField } from "@/components/console/kit/copy-field";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { dayMonthYear, gatewayDashboardUrl } from "@/lib/console-shared/format";
import { ALERT_SEVERITY, HELD_FOR } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { GatewayModes } from "@/lib/console-shared/types";
import type { Alert } from "@/lib/platform/alerts";
import type { NoteView, PlanPanel, SupportPanel, TimelinePage, WorkspaceHeader } from "@/lib/platform/workspace-data";
import { CloseWorkspaceButton } from "./close-dialog";
import { TabLink } from "./header-actions";
import { HoldButton } from "./hold-dialog";
import { SupportAccessCard } from "./support-tab";

/**
 * Workspace 360 › Overview (the default tab): what needs attention here, whether support may go in,
 * what happened lately, the facts about it, its domains and pinned notes — and, for owners and
 * admins only, the Danger zone.
 *
 * The Danger zone is not drawn at all for anyone else: no disabled buttons, no hidden rows. Hold is
 * offered on an open workspace or one held for billing (a staff hold replaces that); a staff hold
 * offers Reopen instead. Close is an owner's, never for the installation's own workspace.
 *
 * `modes` (an addition to spec §4.7): the gateways' test/live modes, so a customer id links to the
 * right dashboard — shown to sellers only, as on the Billing tab.
 */

const RECENT = 8;
const PINNED_SHOWN = 3;

const SEE_ALL = "inline-flex items-center gap-1 rounded-base text-xs font-medium text-brand hover:underline";

function DangerRow({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4">
      <div className="min-w-0 max-w-2xl">
        <h3 className="text-[13px] font-medium text-text">{title}</h3>
        <p className="mt-0.5 text-xs text-muted">{children}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </li>
  );
}

function AttentionPanel({ alerts }: { alerts: Alert[] }) {
  return (
    <Panel
      title="Needs attention here"
      description={alerts.length > 0 ? "Open alerts about this workspace, most serious first." : undefined}
      actions={
        <Link href="/alerts" className={SEE_ALL}>
          All alerts
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
      }
      padded={alerts.length === 0}
    >
      {alerts.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <CircleCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-success" />
          Nothing needs attention
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {alerts.map((alert) => {
            const severity = ALERT_SEVERITY[alert.severity] ?? { label: alert.severity, tone: "neutral" as const };
            return (
              <li key={alert.key} className="flex items-start gap-3 px-5 py-3">
                <StatusPill tone={severity.tone} className="mt-0.5">
                  {severity.label}
                </StatusPill>
                <div className="min-w-0 flex-1">
                  <Link href={alert.href} className="text-sm font-medium break-words text-text hover:text-brand">
                    {alert.title}
                  </Link>
                  {alert.detail && <p className="mt-0.5 text-xs break-words text-muted">{alert.detail}</p>}
                </div>
                {alert.since && <RelativeTime at={alert.since} className="shrink-0 text-xs whitespace-nowrap text-subtle" />}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function OverviewTab({
  header,
  support,
  timeline,
  alerts,
  notes,
  caps,
  modes,
}: {
  header: WorkspaceHeader;
  plan: PlanPanel;
  support: SupportPanel;
  timeline: TimelinePage;
  alerts: Alert[];
  notes: NoteView[];
  caps: Caps;
  modes?: GatewayModes;
}) {
  const { tenant } = header;
  const base = `/workspaces/${encodeURIComponent(tenant.slug)}`;
  const status = tenant.status;
  const heldByStaff = status === "SUSPENDED" && tenant.suspendedFor !== "BILLING";
  const heldForBilling = status === "SUSPENDED" && tenant.suspendedFor === "BILLING";
  const pinned = notes.filter((n) => n.pinned).slice(0, PINNED_SHOWN);
  const holdTenant = { id: tenant.id, slug: tenant.slug, name: tenant.name };
  const gatewayPaying = header.gatewayPaying.length > 0;

  const customer = (gateway: "STRIPE" | "RAZORPAY", id: string | null) => {
    if (!id) return <span className="text-muted">—</span>;
    const mode = gateway === "STRIPE" ? (modes?.stripe ?? null) : (modes?.razorpay ?? null);
    return caps.sell ? (
      <CopyField value={id} label={`${gateway === "STRIPE" ? "Stripe" : "Razorpay"} customer id`} href={gatewayDashboardUrl(gateway, "customer", id, mode)} hrefLabel="Dashboard" />
    ) : (
      <CopyField value={id} label={`${gateway === "STRIPE" ? "Stripe" : "Razorpay"} customer id`} />
    );
  };

  const details: { term: string; value: ReactNode }[] = [
    { term: "Owner email", value: tenant.ownerEmail ? <CopyField value={tenant.ownerEmail} label="owner email" /> : <span className="text-muted">—</span> },
    { term: "Billing email", value: tenant.billingEmail ?? <span className="text-muted">Not set — the owner&apos;s is used</span> },
    { term: "Tax ID", value: tenant.taxId ? <span className="font-mono text-xs">{tenant.taxId}</span> : <span className="text-muted">—</span> },
    { term: "Country · currency · time zone", value: `${tenant.country} · ${tenant.currency} · ${tenant.timezone}` },
    { term: "Region", value: tenant.region },
    { term: "Database", value: tenant.dbName ? <span className="font-mono text-xs break-all">{tenant.dbName}</span> : <span className="text-muted">The installation&apos;s own</span> },
    { term: "Created", value: dayMonthYear(tenant.createdAt) },
    { term: "Updated", value: <RelativeTime at={tenant.updatedAt} /> },
  ];
  if (status === "SUSPENDED") {
    const heldFor = tenant.suspendedFor ? HELD_FOR[tenant.suspendedFor] : null;
    details.push({
      term: "Held",
      value: (
        <span>
          {tenant.suspendedAt ? `Since ${dayMonthYear(tenant.suspendedAt)}` : "Yes"}
          {heldFor && <span className={heldFor.tone === "danger" ? "text-danger" : "text-warning"}>{` · ${heldFor.label}`}</span>}
        </span>
      ),
    });
  }
  if (header.closed) details.push({ term: "Closed on", value: dayMonthYear(header.closed.at) });
  if (tenant.stripeCustomerId) details.push({ term: "Stripe customer", value: customer("STRIPE", tenant.stripeCustomerId) });
  if (tenant.razorpayCustomerId) details.push({ term: "Razorpay customer", value: customer("RAZORPAY", tenant.razorpayCustomerId) });

  // The Danger zone's rows, for owners and admins.
  const canHold = status === "ACTIVE" || heldForBilling;
  const canClose = caps.owner && status !== "DEPROVISIONED";
  const showDanger = caps.manage && (canHold || heldByStaff || canClose);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <AttentionPanel alerts={alerts} />
          <SupportAccessCard header={header} support={support} caps={caps} />
          <Panel
            title="Recent activity"
            actions={
              <TabLink tab="activity" href={`${base}?tab=activity`} className={SEE_ALL}>
                See all activity
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </TabLink>
            }
          >
            <ActivityFeed items={timeline.events.slice(0, RECENT)} todayKey={timeline.todayKey} showWorkspace={false} empty="Nothing has happened here yet." />
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          <Panel title="Details">
            <DefinitionList columns={1} items={details} />
          </Panel>

          <Panel title="Domains" padded={tenant.domains.length === 0}>
            {tenant.domains.length === 0 ? (
              <p className="flex items-start gap-2 text-sm text-muted">
                <Globe aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
                <span>
                  Its own subdomain only: <span className="font-mono text-xs break-all text-text">{header.host}</span>
                </span>
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {tenant.domains.map((d) => (
                  <li key={d.host} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                    <span className="min-w-0 font-mono text-xs break-all text-text">{d.host}</span>
                    <span className="flex items-center gap-1.5">
                      {d.isPrimary && <StatusPill tone="brand">Primary</StatusPill>}
                      <StatusPill tone="neutral">{d.kind === "CUSTOM" ? "Custom" : "Legacy"}</StatusPill>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {pinned.length > 0 && (
            <Panel
              title="Pinned notes"
              padded={false}
              actions={
                <TabLink tab="notes" href={`${base}?tab=notes`} className={SEE_ALL}>
                  All notes
                  <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                </TabLink>
              }
            >
              <ul className="divide-y divide-line">
                {pinned.map((note) => (
                  <li key={note.id} className="px-5 py-3">
                    <p className="line-clamp-4 text-sm whitespace-pre-wrap break-words text-text">{note.body}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-subtle">
                      <Pin aria-hidden="true" className="h-3 w-3" />
                      <span>{note.author}</span>
                      <span aria-hidden="true">·</span>
                      <RelativeTime at={note.createdAt} />
                    </p>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      </div>

      {showDanger && (
        <Panel tone="danger" title="Danger zone" description="Changes that lock people out, or cannot be undone." padded={false}>
          <ul className="divide-y divide-line">
            {canHold && (
              <DangerRow title="Hold this workspace" action={<HoldButton tenant={holdTenant} gatewayPaying={gatewayPaying} />}>
                Staff and users are locked out until it is reopened. Billing never lifts a staff hold.
                {heldForBilling && " It is held for billing now — a staff hold replaces that one."}
                {gatewayPaying && " It pays at a gateway, so its address is asked for too."}
              </DangerRow>
            )}
            {heldByStaff && (
              <DangerRow
                title="Reopen this workspace"
                action={
                  <ActionButton
                    action={consoleResume.bind(null, tenant.id)}
                    label="Reopen workspace"
                    confirm={{ title: "Reopen workspace", body: "Its staff and users can sign in again at once.", confirmLabel: "Reopen workspace" }}
                    success="Workspace reopened."
                  />
                }
              >
                {`It is held by staff${header.hold?.by ? ` (${header.hold.by})` : ""}. Reopening lets its staff and users sign in again at once.`}
              </DangerRow>
            )}
            {canClose &&
              (tenant.isDefault ? (
                <DangerRow title="Close this workspace">The installation&apos;s own workspace is not closed from the console.</DangerRow>
              ) : (
                <DangerRow title="Close this workspace" action={<CloseWorkspaceButton tenant={holdTenant} />}>
                  Takes a final backup, drops its database and removes its domains and terminals. Keys are kept 90 days, then it can be purged on the server.
                </DangerRow>
              ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
