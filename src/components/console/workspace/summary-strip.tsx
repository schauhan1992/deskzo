import type { ReactNode } from "react";
import { ChevronRight, CreditCard, DatabaseZap, Layers, LifeBuoy, Sparkles, Users } from "lucide-react";
import { Meter } from "@/components/console/charts/meter";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { SchemaPill, StandingPill, StatusDot, StatusPill } from "@/components/console/kit/status";
import { compactNumber, monthLabel, plural } from "@/lib/console-shared/format";
import { gatewayLabel, schemaLabel } from "@/lib/console-shared/labels";
import { consoleClock } from "@/lib/platform/console-clock";
import type { PlanPanel, SupportPanel, UsagePanel, WorkspaceHeader } from "@/lib/platform/workspace-data";
import { cn } from "@/lib/utils";
import { TabLink } from "./header-actions";

/**
 * Six small cards under the header — its plan, seats, copilot, billing, support access and schema —
 * each the short answer to "how is it doing on this", and each a way into the tab with the long
 * one. Figures come from the loaders (the usage snapshot, the plan's limits, the standing worked
 * out at `asOf`), never from the reader's clock; times are on the console's.
 */

const INTEGER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const PLANS_SHOWN = 2;

function MiniCard({ tab, href, title, icon, children }: { tab: string; href: string; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="group relative flex min-w-0 flex-col rounded-xl border border-line bg-surface px-4 py-3 shadow-sm transition-colors hover:border-line-strong focus-within:border-line-strong">
      <h2 className="flex items-center gap-1.5 text-xs font-medium text-muted">
        <span aria-hidden="true" className="inline-flex shrink-0 text-subtle">
          {icon}
        </span>
        {/* The whole card follows this link; it is the card's one tab stop and its name. */}
        <TabLink tab={tab} href={href} className="min-w-0 truncate rounded-base group-hover:text-text after:absolute after:inset-0 after:rounded-xl after:content-['']">
          {title}
        </TabLink>
        <ChevronRight aria-hidden="true" className="ml-auto h-3.5 w-3.5 shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
      </h2>
      <div className="mt-2 min-w-0 flex-1 space-y-1.5">{children}</div>
    </div>
  );
}

function Value({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("truncate text-sm font-semibold text-text tabular-nums", className)}>{children}</p>;
}

function Secondary({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted">{children}</div>;
}

const overriddenPill = <StatusPill tone="warning">overridden</StatusPill>;

export async function SummaryStrip({ header, plan, usage, support }: { header: WorkspaceHeader; plan: PlanPanel; usage: UsagePanel; support: SupportPanel }) {
  const clock = await consoleClock();
  const { tenant, asOf } = header;
  const base = `/workspaces/${encodeURIComponent(tenant.slug)}`;
  const href = (tab: string) => (tab === "overview" ? base : `${base}?tab=${tab}`);
  const closed = tenant.status === "DEPROVISIONED";

  // Plan: what it is on, "CRM ×2, Payroll", and what that adds up to.
  const names = plan.items.map((i) => (i.quantity > 1 ? `${i.planName} ×${i.quantity}` : i.planName));
  const shownNames = names.slice(0, PLANS_SHOWN).join(", ");
  const moreNames = names.length - PLANS_SHOWN;
  const entitled = plan.modules.filter((m) => m.state === "plan" || m.state === "added").length;

  // Seats and copilot: the latest daily snapshot against the limits its plans (or staff) set.
  const latest = usage.latest;
  const seatLimit = plan.limits.seats;
  const tokenLimit = plan.limits.copilotTokens;
  const latestMonth = latest ? monthLabel(latest.day.toISOString().slice(0, 7)) : null;

  // Billing: how it pays, as a few words under the standing.
  const paysThrough = [...new Set(header.gatewayPaying.map((g) => gatewayLabel(g.gateway)))];
  const billingNote = closed
    ? "Closed — nothing is billed"
    : paysThrough.length > 0
      ? `Pays through ${paysThrough.join(" and ")}`
      : tenant.isDefault
        ? "The installation's own"
        : header.standing.kind === "exempt"
          ? "On a plan given by hand"
          : header.standing.kind === "trial" || header.standing.kind === "trial-over"
            ? "Free trial"
            : header.standing.kind === "none"
              ? "No subscription"
              : null;

  // Support access: the level and until when — the time alone when that is today.
  const grant = support.grant;
  const until = grant ? (clock.dateKey(grant.expiresAt) === clock.dateKey(asOf) ? clock.time(grant.expiresAt) : `${clock.dayMonth(grant.expiresAt)}, ${clock.time(grant.expiresAt)}`) : null;

  return (
    <section aria-label="Summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
      <MiniCard tab="plan" href={href("plan")} title="Plan" icon={<Layers className="h-3.5 w-3.5" />}>
        <Value>
          {names.length === 0 ? (
            <span className="font-medium text-muted">No plan</span>
          ) : (
            <span title={names.join(", ")}>
              {shownNames}
              {moreNames > 0 && <span className="font-medium text-muted">{` +${moreNames} more`}</span>}
            </span>
          )}
        </Value>
        <Secondary>
          {plan.entitlements.all ? "Every module" : plural(entitled, "module")}
          {plan.overrides.length > 0 && <span>{`· ${plural(plan.overrides.length, "override")}`}</span>}
        </Secondary>
      </MiniCard>

      <MiniCard tab="usage" href={href("usage")} title="Seats" icon={<Users className="h-3.5 w-3.5" />}>
        <Value>
          {latest ? INTEGER.format(latest.seatsUsed) : "—"}
          <span className="font-medium text-muted">{seatLimit === null ? " · no limit" : ` / ${INTEGER.format(seatLimit)}`}</span>
        </Value>
        {latest && seatLimit !== null && <Meter value={latest.seatsUsed} max={seatLimit} label="Seats in use against the seat limit" />}
        <Secondary>
          {latest ? "in use" : "No usage recorded yet"}
          {plan.limits.seatOverride !== null && overriddenPill}
        </Secondary>
      </MiniCard>

      <MiniCard tab="usage" href={href("usage")} title="Copilot" icon={<Sparkles className="h-3.5 w-3.5" />}>
        <Value>
          {tokenLimit === 0 ? (
            <span className="font-medium text-muted">Off</span>
          ) : (
            <>
              {latest ? compactNumber(latest.copilotTokens) : "—"}
              <span className="font-medium text-muted">{tokenLimit === null ? " · no limit" : ` / ${compactNumber(tokenLimit)}`}</span>
            </>
          )}
        </Value>
        {latest && tokenLimit !== null && tokenLimit > 0 && <Meter value={latest.copilotTokens} max={tokenLimit} label="Copilot tokens this month against the limit" />}
        <Secondary>
          {tokenLimit === 0 ? "No copilot on its plans" : latestMonth ? `tokens, ${latestMonth}` : "No usage recorded yet"}
          {plan.limits.copilotTokenOverride !== null && overriddenPill}
        </Secondary>
      </MiniCard>

      <MiniCard tab="billing" href={href("billing")} title="Billing" icon={<CreditCard className="h-3.5 w-3.5" />}>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {closed ? <StatusPill tone="neutral">Closed</StatusPill> : <StandingPill kind={header.standing.kind} at={header.standingAt} asOf={asOf} />}
          {tenant.status === "SUSPENDED" && tenant.suspendedFor === "BILLING" && <StatusPill tone="danger">Held</StatusPill>}
        </div>
        {billingNote && <Secondary>{billingNote}</Secondary>}
      </MiniCard>

      <MiniCard tab="support" href={href("support")} title="Support access" icon={<LifeBuoy className="h-3.5 w-3.5" />}>
        {grant ? (
          <>
            <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-text">
              <StatusDot tone={grant.level === "ADMIN" ? "warning" : "info"} label="Granted" />
              <span className="truncate">{`${grant.level === "ADMIN" ? "Administrator" : "Read-only"} until ${until}`}</span>
            </p>
            <Secondary>
              <span className="truncate">{`Granted by ${grant.grantedByName}`}</span>
            </Secondary>
          </>
        ) : (
          <>
            <Value className="font-medium text-muted">Not granted</Value>
            <Secondary>
              {support.lastRequest ? (
                <span>
                  Asked <RelativeTime at={support.lastRequest.at} />
                </span>
              ) : (
                "Only its super admin grants it"
              )}
            </Secondary>
          </>
        )}
      </MiniCard>

      <MiniCard tab="operations" href={href("operations")} title="Schema" icon={<DatabaseZap className="h-3.5 w-3.5" />}>
        <div>
          <SchemaPill version={tenant.schemaVersion} latest={header.latest} behindBy={header.behindBy} />
        </div>
        <Secondary>
          <span className="truncate" title={tenant.schemaVersion ?? undefined}>
            {tenant.schemaVersion ? schemaLabel(tenant.schemaVersion) : tenant.dbName ? "No schema recorded" : "The installation's own database"}
          </span>
        </Secondary>
      </MiniCard>
    </section>
  );
}
