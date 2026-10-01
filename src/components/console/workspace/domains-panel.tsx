import { Globe } from "lucide-react";
import { consoleCheckDomain, consoleClearDomainPrimary, consoleMakeDomainPrimary } from "@/actions/platform/console-domains";
import { ActionButton } from "@/components/console/kit/action-button";
import { CopyField } from "@/components/console/kit/copy-field";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import type { Caps } from "@/lib/console-shared/roles";
import type { Tone } from "@/lib/console-shared/types";
import type { DomainView, WorkspaceDomains } from "@/lib/platform/domains";
import { AddDomainButton, RemoveDomainButton } from "./domain-actions";

/**
 * Workspace 360's Domains panel, on the Overview and the Operations tabs alike: its own subdomain,
 * then each address of its own with its state in words, the last check and what it found wrong, since
 * when it has been failing, and the TXT record that proves it.
 *
 * Owners and admins add, make primary and remove (with a reason); support checks DNS too; everybody
 * else reads. A closed workspace has none. Every action checks the role again itself.
 */

const TONE: Record<DomainView["tone"], Tone> = { waiting: "info", live: "success", failing: "warning", stopped: "danger" };

const dateTime = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export function DomainsPanel({
  domains,
  tenant,
  caps,
  className,
}: {
  domains: WorkspaceDomains & { offered: boolean };
  tenant: { id: string; slug: string; status?: string };
  caps: Caps;
  className?: string;
}) {
  const closed = tenant.status === "DEPROVISIONED";
  const manage = caps.manage && !closed;
  const check = caps.enter && !closed;
  const ownPrimary = domains.primaryHost === domains.ownHost;
  const customPrimary = domains.domains.some((d) => d.isPrimary);

  return (
    <Panel
      title="Domains"
      description="Its own subdomain, and addresses of its own."
      actions={manage ? <AddDomainButton tenantId={tenant.id} slug={tenant.slug} /> : undefined}
      padded={false}
      className={className}
      footer={
        <span>
          {`Custom domains: ${domains.allowanceText}. `}
          {domains.offered ? "Owners can add them from Settings › Domain." : "Not offered to workspaces yet — the switch is under Settings › Custom domains."}
        </span>
      }
    >
      <ul className="divide-y divide-line">
        <li className="space-y-1 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Globe aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
              <span className="min-w-0 font-mono text-xs break-all text-text">{domains.ownHost}</span>
              <StatusPill tone="neutral">Own subdomain</StatusPill>
              {ownPrimary && <StatusPill tone="brand">Primary</StatusPill>}
            </span>
            {manage && customPrimary && (
              <ActionButton
                action={consoleClearDomainPrimary.bind(null, tenant.id)}
                label="Use for links"
                variant="ghost"
                confirm={{
                  title: "Use its own address for links",
                  body: `Links in emails and documents go back to ${domains.ownHost}. Its other addresses keep working.`,
                  confirmLabel: "Use its own address",
                }}
                success="Links use its own address again."
              />
            )}
          </div>
          {domains.domains.length === 0 && <p className="text-xs text-muted">Reached at its own subdomain only.</p>}
        </li>
        {domains.domains.map((d) => (
          <DomainItem key={d.id} d={d} tenantId={tenant.id} ownHost={domains.ownHost} manage={manage} check={check} />
        ))}
      </ul>
    </Panel>
  );
}

function DomainItem({ d, tenantId, ownHost, manage, check }: { d: DomainView; tenantId: string; ownHost: string; manage: boolean; check: boolean }) {
  const txt = d.records.find((r) => r.type === "TXT") ?? null;
  return (
    <li className="space-y-2 px-5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 font-mono text-xs break-all text-text">{d.host}</span>
          <StatusPill tone={TONE[d.tone]}>{d.statusText}</StatusPill>
          {d.isPrimary && <StatusPill tone={d.status === "ACTIVE" ? "brand" : "neutral"}>{d.status === "ACTIVE" ? "Primary" : "Primary when live"}</StatusPill>}
          <StatusPill tone="neutral">{d.kind === "CUSTOM" ? "Custom" : "Legacy"}</StatusPill>
        </span>
        {(check || manage) && (
          <span className="flex flex-wrap items-center gap-1.5">
            {check && d.kind === "CUSTOM" && (
              <ActionButton action={consoleCheckDomain.bind(null, tenantId, d.id)} label="Check now" variant="secondary" success={`${d.host} checked — its state is below.`} />
            )}
            {manage && d.status === "ACTIVE" && !d.isPrimary && (
              <ActionButton
                action={consoleMakeDomainPrimary.bind(null, tenantId, d.id)}
                label="Make primary"
                variant="ghost"
                confirm={{
                  title: `Make ${d.host} primary`,
                  body: `Links in emails and documents use ${d.host} instead of ${ownHost}. People sign in separately at each address.`,
                  confirmLabel: "Make primary",
                }}
                success={`${d.host} is the primary address.`}
              />
            )}
            {manage && <RemoveDomainButton tenantId={tenantId} domainId={d.id} host={d.host} primary={d.isPrimary} ownHost={ownHost} />}
          </span>
        )}
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex min-w-0 gap-1.5">
          <dt className="shrink-0 text-muted">Last check</dt>
          <dd className="min-w-0 text-text">{d.lastCheckedAt ? <RelativeTime at={d.lastCheckedAt} /> : d.kind === "CUSTOM" ? "Never" : "Not checked — needs no records"}</dd>
        </div>
        {d.failingSince && (
          <div className="flex min-w-0 gap-1.5">
            <dt className="shrink-0 text-muted">Failing since</dt>
            <dd className="min-w-0 text-warning">
              {dateTime.format(d.failingSince)}
              {d.stopsAt ? ` — stops ${dateTime.format(d.stopsAt)}` : ""}
            </dd>
          </div>
        )}
        {d.verifiedAt && (
          <div className="flex min-w-0 gap-1.5">
            <dt className="shrink-0 text-muted">Verified</dt>
            <dd className="min-w-0 text-text">
              <RelativeTime at={d.verifiedAt} />
            </dd>
          </div>
        )}
        {d.addedBy && (
          <div className="flex min-w-0 gap-1.5">
            <dt className="shrink-0 text-muted">Added by</dt>
            <dd className="min-w-0 break-all text-text">{d.addedBy}</dd>
          </div>
        )}
      </dl>
      {d.problems.length > 0 && (
        <ul aria-label={`What the last check of ${d.host} found`} className={d.status === "ACTIVE" ? "space-y-0.5 text-xs text-warning" : "space-y-0.5 text-xs text-danger"}>
          {d.problems.map((p) => (
            <li key={p} className="break-words">
              {p}
            </li>
          ))}
        </ul>
      )}
      {txt && (
        <div className="space-y-0.5 text-xs">
          <p className="text-muted">TXT record</p>
          <CopyField value={txt.name} label={`the TXT record's name for ${d.host}`} />
          <CopyField value={txt.value} label={`the TXT record's value for ${d.host}`} className="block" />
        </div>
      )}
      {d.apex && <p className="text-xs text-warning">A bare domain: many DNS providers can&apos;t point one with a CNAME — an ALIAS or flattened record is needed.</p>}
    </li>
  );
}
