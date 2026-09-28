import type { ReactNode } from "react";
import Link from "next/link";
import { Building2, CirclePause, CreditCard, DatabaseZap, Hourglass, LifeBuoy, Repeat, Rocket, Server, Timer, Wallet, Webhook } from "lucide-react";
import type { ChartTone } from "@/components/console/charts/chart-utils";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { Meter } from "@/components/console/charts/meter";
import { MoneyList } from "@/components/console/charts/money-list";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { formatMoney } from "@/lib/billing/money";
import { plural } from "@/lib/console-shared/format";
import type { Caps } from "@/lib/console-shared/roles";
import type { OverviewData } from "@/lib/platform/console-data";
import type { CollectedByMonth, MrrSummary } from "@/lib/platform/revenue";
import type { TickSummary } from "@/lib/platform/tick-summary";
import { cn } from "@/lib/utils";
import { tickHealth } from "./side-panels";

/**
 * The Overview's headline figures, in three rows: customers, revenue (only for the staff who sell —
 * nobody else is sent the numbers) and the platform itself. Every tile is one link to the list behind
 * its number. Money is one line per currency, never a sum.
 */

type Tone = "neutral" | "success" | "info" | "warning" | "danger";

const num = (n: number) => n.toLocaleString("en-IN");
const ICON = "h-4 w-4";

export function OverviewKpis({
  data,
  mrr,
  collected,
  tick,
  caps,
}: {
  data: OverviewData;
  mrr: MrrSummary | null;
  collected: CollectedByMonth | null;
  tick: TickSummary | null;
  caps: Caps;
}) {
  const c = data.counts;
  const held = c.heldStaff + c.heldBilling;
  const setupParts = [`${num(c.runningJobs)} running`, `${num(c.failedJobs)} failed`, c.pendingJobs > 0 ? `${num(c.pendingJobs)} waiting` : null].filter(Boolean);

  return (
    <div className="space-y-6">
      <KpiGroup id="overview-customers" title="Customers">
        <KpiTile
          label="Active workspaces"
          value={num(c.byStatus.ACTIVE)}
          icon={<Building2 className={ICON} />}
          href="/workspaces?status=ACTIVE"
          trend={{ values: data.openByWeek, label: "Open workspaces at the end of each of the last 12 weeks" }}
          delta={data.createdThisWeek > 0 ? { text: `+${num(data.createdThisWeek)} this week`, direction: "up", good: true } : undefined}
          secondary={data.createdThisWeek > 0 ? undefined : "None new this week"}
        />
        <KpiTile
          label="In trial"
          value={num(c.trials)}
          icon={<Hourglass className={ICON} />}
          href="/trials"
          tone={c.trialsEnding7d > 0 ? "info" : "neutral"}
          secondary={c.trialsEnding7d === 0 ? "None end within 7 days" : `${num(c.trialsEnding7d)} ${c.trialsEnding7d === 1 ? "ends" : "end"} within 7 days`}
        />
        <KpiTile
          label="Held"
          value={num(held)}
          icon={<CirclePause className={ICON} />}
          href="/workspaces?view=held"
          tone={held > 0 ? "warning" : "neutral"}
          secondary={`${num(c.heldStaff)} staff · ${num(c.heldBilling)} billing`}
        />
        <KpiTile
          label="Setting up"
          value={num(c.byStatus.PROVISIONING)}
          icon={<Rocket className={ICON} />}
          href="/provisioning"
          tone={c.failedJobs > 0 ? "danger" : c.runningJobs > 0 ? "info" : "neutral"}
          secondary={setupParts.join(" · ")}
        />
      </KpiGroup>

      {caps.viewBilling && mrr && collected && <RevenueRow data={data} mrr={mrr} collected={collected} />}

      <KpiGroup id="overview-platform" title="Platform">
        <SchemaTile data={data} />
        <WarmPoolTile data={data} />
        <TickTile data={data} tick={tick} />
        <GrantsTile data={data} />
      </KpiGroup>
    </div>
  );
}

function KpiGroup({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">
        {title}
      </h2>
      <KpiGrid>{children}</KpiGrid>
    </section>
  );
}

function RevenueRow({ data, mrr, collected }: { data: OverviewData; mrr: MrrSummary; collected: CollectedByMonth }) {
  const c = data.counts;
  const owed = collected.outstanding.map((m) => formatMoney(m.minor, m.currency));
  const atRisk = mrr.rows.filter((r) => r.pastDue > 0).map((r) => formatMoney(r.pastDue, r.currency));
  return (
    <KpiGroup id="overview-revenue" title="Revenue">
      <KpiTile
        label="MRR"
        value={<MoneyList amounts={mrr.rows.map((r) => ({ currency: r.currency, minor: r.mrr }))} />}
        icon={<Repeat className={ICON} />}
        href="/billing"
        secondary="estimated from gateway subscriptions"
      />
      <KpiTile
        label="Collected this month"
        value={<MoneyList amounts={collected.thisMonth} />}
        icon={<Wallet className={ICON} />}
        href="/billing?tab=invoices&status=PAID"
        secondary={owed.length ? `${owed.join(" · ")} still owed` : "Nothing outstanding"}
      />
      <KpiTile
        label="Past due"
        value={num(c.pastDue)}
        icon={<CreditCard className={ICON} />}
        href="/workspaces?view=past-due"
        tone={c.pastDue > 0 ? "danger" : "neutral"}
        secondary={atRisk.length ? `${atRisk.join(" · ")} a month at risk` : c.pastDue > 0 ? "Payments being retried" : "No failed payments"}
      />
      <KpiTile
        label="Webhooks failing"
        value={num(c.failingWebhooks)}
        icon={<Webhook className={ICON} />}
        href="/billing?tab=events&state=failed"
        tone={c.failingWebhooks > 0 ? "danger" : "neutral"}
        secondary={c.failingWebhooks > 0 ? "Gateway events not processed" : "No gateway event has failed"}
      />
    </KpiGroup>
  );
}

function SchemaTile({ data }: { data: OverviewData }) {
  const { upToDate, migratable, drift } = data.counts;
  if (migratable === 0) {
    return <GaugeTile label="Schema" icon={<DatabaseZap className={ICON} />} href="/migrations" value="—" secondary="No open workspaces yet" />;
  }
  return (
    <GaugeTile
      label="Schema"
      icon={<DatabaseZap className={ICON} />}
      href="/migrations"
      tone={drift > 0 ? "warning" : "success"}
      value={<OfValue value={upToDate} max={migratable} />}
      meter={{ value: upToDate, max: migratable, label: "Workspaces on the latest schema", tone: drift > 0 ? "warning" : "success" }}
      secondary={drift > 0 ? `up to date · ${num(drift)} behind` : "up to date"}
    />
  );
}

function WarmPoolTile({ data }: { data: OverviewData }) {
  const { warm, warmTarget } = data.counts;
  if (warmTarget <= 0) {
    return <GaugeTile label="Warm pool" icon={<Server className={ICON} />} href="/provisioning#warm-pool" value="Off" secondary="No databases are kept ready" />;
  }
  // A full pool is the healthy state, so the meter is coloured by how empty it is, not how full.
  const tone: Tone = warm === 0 ? "danger" : warm < warmTarget ? "warning" : "success";
  return (
    <GaugeTile
      label="Warm pool"
      icon={<Server className={ICON} />}
      href="/provisioning#warm-pool"
      tone={tone}
      value={<OfValue value={warm} max={warmTarget} />}
      meter={{ value: warm, max: warmTarget, label: "Warm databases ready", tone }}
      secondary={warm === 0 ? "None ready — a new workspace waits for a fresh database" : "databases ready for new workspaces"}
    />
  );
}

function TickTile({ data, tick }: { data: OverviewData; tick: TickSummary | null }) {
  const health = tickHealth(data.tick, data.asOf);
  // The lease says when it last finished; the recorded summary stands in while the lease has no time.
  const lastAt = health.lastAt ?? tick?.at ?? null;
  const outcome = data.tick.lastOk === false ? "failed" : data.tick.lastOk === true ? "ok" : null;
  return (
    <KpiTile
      label="Platform tick"
      value={health.label}
      icon={<Timer className={ICON} />}
      href="/health"
      tone={health.tone}
      secondary={
        lastAt ? (
          <>
            last ran <RelativeTime at={lastAt} />
            {outcome && ` · ${outcome}`}
          </>
        ) : (
          "No finished run yet"
        )
      }
    />
  );
}

function GrantsTile({ data }: { data: OverviewData }) {
  const n = data.counts.grants;
  const admin = data.liveGrants.filter((g) => g.level === "ADMIN").length;
  // The list is capped; split it only when it holds every grant.
  const split = data.liveGrants.length === n ? `${num(admin)} administrator · ${num(n - admin)} read-only` : plural(n, "workspace");
  return (
    <KpiTile
      label="Support grants live"
      value={num(n)}
      icon={<LifeBuoy className={ICON} />}
      href="/workspaces?grant=live"
      tone={n > 0 ? "info" : "neutral"}
      secondary={n > 0 ? split : "No workspace has let staff in"}
    />
  );
}

/** "138 of 142": the count at full size, its whole a step down. */
function OfValue({ value, max }: { value: number; max: number }) {
  return (
    <>
      {num(value)}
      <span className="text-base font-medium text-muted">{` of ${num(max)}`}</span>
    </>
  );
}

// The same card as KpiTile (src/components/console/charts/kpi-tile.tsx). KpiTile's meter colours by
// how close a value is to a limit — right for seats, wrong here, where a full bar is the good news —
// so these two tiles pass the meter's tone themselves.
const CHIP: Record<Tone, string> = {
  neutral: "bg-surface-sunken text-muted",
  success: "bg-success-bg text-success",
  info: "bg-info-bg text-info",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
};
const VALUE: Record<Tone, string> = {
  neutral: "text-text",
  success: "text-text",
  info: "text-text",
  warning: "text-warning",
  danger: "text-danger",
};

function GaugeTile({
  label,
  icon,
  href,
  tone = "neutral",
  value,
  meter,
  secondary,
}: {
  label: string;
  icon: ReactNode;
  href: string;
  tone?: Tone;
  value: ReactNode;
  meter?: { value: number; max: number; label: string; tone: ChartTone };
  secondary: ReactNode;
}) {
  return (
    <Link href={href} className="block rounded-xl border border-line bg-surface p-4 shadow-sm transition-colors hover:border-line-strong">
      <div className="flex items-center gap-2.5">
        <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", CHIP[tone])} aria-hidden="true">
          {icon}
        </span>
        <p className="min-w-0 text-xs font-medium text-muted">{label}</p>
      </div>
      <div className={cn("mt-3 text-2xl font-semibold tracking-tight tabular-nums", VALUE[tone])}>{value}</div>
      {meter && (
        <div className="mt-2.5">
          <Meter value={meter.value} max={meter.max} label={meter.label} tone={meter.tone} />
        </div>
      )}
      <p className="mt-2 text-xs text-muted">{secondary}</p>
    </Link>
  );
}
