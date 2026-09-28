import Link from "next/link";
import { ArrowRight, Banknote, CircleCheck, CirclePause, Hourglass, ReceiptText, Repeat, TriangleAlert } from "lucide-react";
import { ChartEmpty, ChartFrame, ChartTable } from "@/components/console/charts/chart-frame";
import type { ChartTone } from "@/components/console/charts/chart-utils";
import { ColumnChart } from "@/components/console/charts/column-chart";
import { HBarChart } from "@/components/console/charts/hbar-chart";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { MoneyList } from "@/components/console/charts/money-list";
import { EmptyState } from "@/components/console/kit/empty-state";
import { ViewTabs } from "@/components/console/kit/filters";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { formatMoney } from "@/lib/billing/money";
import { monthLabel, plural } from "@/lib/console-shared/format";
import { ALERT_SEVERITY, SUBSCRIPTION_STATUS } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { GatewayKey, SubscriptionStatusKey } from "@/lib/console-shared/types";
import type { Alert } from "@/lib/platform/alerts";
import type { BillingOverviewData } from "@/lib/platform/console-data";
import type { CollectedByMonth, MrrByPlan, MrrSummary, SubscriptionStatusCount } from "@/lib/platform/revenue";
import type { TickSummary } from "@/lib/platform/tick-summary";
import { GatewayConnections } from "./gateway-connections";

/**
 * The Billing hub's default tab: the revenue picture, what needs a person, and whether the gateways
 * and the scheduler are connected.
 *
 * Money is per currency, always: a tile lists one line per currency, and each chart draws one
 * currency at a time with a switch between them (`?currency=`). Every figure is what the gateways'
 * webhooks recorded, before tax — the page says so once, above the figures, and means it for all
 * of them.
 */

const INTEGER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const ATTENTION_LIMIT = 10;

const STATUS_ORDER: SubscriptionStatusKey[] = ["ACTIVE", "TRIALING", "PAST_DUE", "INCOMPLETE", "CANCELLED"];
const STATUS_TONE: Record<SubscriptionStatusKey, ChartTone> = {
  ACTIVE: "success",
  TRIALING: "info",
  PAST_DUE: "danger",
  INCOMPLETE: "muted",
  CANCELLED: "muted",
};
const GATEWAY_COLUMNS: { key: GatewayKey; label: string }[] = [
  { key: "STRIPE", label: "Stripe" },
  { key: "RAZORPAY", label: "Razorpay" },
  { key: "MANUAL", label: "Trial or by hand" },
];

/** "Sep" under a column, with the year where it turns ("Jan '27") and on the first column. */
function shortMonth(key: string, first: boolean): string {
  const [name = key] = monthLabel(key).split(" ");
  return first || key.endsWith("-01") ? `${name} '${key.slice(2, 4)}` : name;
}

/** Amounts in several currencies as one line of text: "₹17,988.00 · $2,388.00". */
function moneyLine(amounts: { currency: string; minor: number }[]): string {
  return amounts.map((a) => formatMoney(a.minor, a.currency)).join(" · ");
}

export function BillingOverviewTab({
  data,
  mrr,
  collected,
  mrrPlans,
  statuses,
  tick,
  alerts,
  currency,
  caps,
  tickBy = null,
}: {
  data: BillingOverviewData;
  mrr: MrrSummary;
  collected: CollectedByMonth;
  mrrPlans: MrrByPlan;
  statuses: SubscriptionStatusCount[];
  tick: TickSummary | null;
  alerts: Alert[];
  currency: string | null;
  caps: Caps;
  /** The staff member who started the last lifecycle run, by name, when it was not the scheduler. */
  tickBy?: string | null;
}) {
  // Every currency anything is recorded in, the one most workspaces pay in first (the loaders' order).
  const currencies = [
    ...new Set([
      ...mrr.rows.map((r) => r.currency),
      ...collected.series.map((s) => s.currency),
      ...mrrPlans.map((p) => p.currency),
      ...collected.outstanding.map((o) => o.currency),
    ]),
  ];
  const selected = currency && currencies.includes(currency) ? currency : (currencies[0] ?? null);
  const currencyHref = (c: string) => (c === currencies[0] ? "/billing" : `/billing?currency=${c}`);

  const thisMonthKey = collected.months[collected.months.length - 1] ?? null;
  const pastDueMrr = mrr.rows.filter((r) => r.pastDue > 0).map((r) => ({ currency: r.currency, minor: r.pastDue }));
  const shownAlerts = alerts.slice(0, ATTENTION_LIMIT);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">Every figure here is as recorded from gateway webhooks, before tax — not accounting figures.</p>
        {currencies.length > 1 && selected && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Charts in</span>
            <ViewTabs label="Currency" items={currencies.map((c) => ({ key: c, label: c, href: currencyHref(c), active: c === selected }))} />
          </div>
        )}
      </div>

      <KpiGrid columns={3}>
        <KpiTile
          label="Monthly recurring revenue"
          icon={<Repeat className="h-4 w-4" />}
          href="/billing?tab=subscriptions"
          value={<MoneyList amounts={mrr.rows.map((r) => ({ currency: r.currency, minor: r.mrr }))} />}
          secondary={
            mrr.rows.length === 0
              ? "No paying subscriptions yet"
              : `ARR ${moneyLine(mrr.rows.map((r) => ({ currency: r.currency, minor: r.arr })))}${mrr.unpriced > 0 ? ` · ${plural(mrr.unpriced, "item")} without a price left out` : ""}`
          }
        />
        <KpiTile
          label="Collected this month"
          icon={<Banknote className="h-4 w-4" />}
          href="/billing?tab=invoices&status=PAID"
          value={<MoneyList amounts={collected.thisMonth.filter((m) => m.minor > 0)} empty="Nothing yet" />}
          secondary={thisMonthKey ? `Paid invoices, ${monthLabel(thisMonthKey)}` : "Paid invoices"}
        />
        <KpiTile
          label="Outstanding"
          icon={<ReceiptText className="h-4 w-4" />}
          href="/billing?tab=invoices&status=OPEN"
          value={<MoneyList amounts={collected.outstanding} empty="Nothing owed" />}
          secondary="Open and uncollectible invoices"
        />
        <KpiTile
          label="Past due"
          icon={<TriangleAlert className="h-4 w-4" />}
          tone={data.counts.pastDue > 0 ? "danger" : "neutral"}
          href="/workspaces?view=past-due"
          value={INTEGER.format(data.counts.pastDue)}
          secondary={pastDueMrr.length > 0 ? `${moneyLine(pastDueMrr)} a month at risk` : "Workspaces whose last payment failed"}
        />
        <KpiTile
          label="Held for billing"
          icon={<CirclePause className="h-4 w-4" />}
          tone={data.counts.heldBilling > 0 ? "warning" : "neutral"}
          href="/workspaces?view=held&heldFor=BILLING"
          value={INTEGER.format(data.counts.heldBilling)}
          secondary="Held until a payment goes through"
        />
        <KpiTile
          label="In trial"
          icon={<Hourglass className="h-4 w-4" />}
          tone="info"
          href="/trials"
          value={INTEGER.format(data.counts.trials)}
          secondary={`Trials last ${plural(data.trialDays, "day")}`}
        />
      </KpiGrid>

      {selected ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="min-w-0 lg:col-span-2">
            <CollectedChart collected={collected} currency={selected} />
          </div>
          <MrrByPlanChart mrrPlans={mrrPlans} currency={selected} />
        </div>
      ) : (
        <Panel title="Revenue">
          <EmptyState
            icon={<Banknote className="h-5 w-5" />}
            title="No paying subscriptions yet"
            body="Revenue appears here once a workspace pays through Stripe or Razorpay. The gateway connections below show whether each one is ready."
          />
        </Panel>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <NeedsAttention alerts={shownAlerts} more={alerts.length - shownAlerts.length} />
        </div>
        <StatusChart statuses={statuses} />
      </div>

      <GatewayConnections data={data} owner={caps.owner} manage={caps.manage} tickBy={tick && tick.by !== "tick" ? tickBy : null} />
    </div>
  );
}

function CollectedChart({ collected, currency }: { collected: CollectedByMonth; currency: string }) {
  const values = collected.series.find((s) => s.currency === currency)?.values ?? [];
  const columns = collected.months.map((key, i) => ({ key, label: shortMonth(key, i === 0), value: values[i] ?? 0 }));
  const total = values.reduce((sum, v) => sum + v, 0);
  return (
    <ChartFrame
      title="Collected by month"
      description={`Paid invoices in ${currency}, by the month they were paid — the last ${collected.months.length} months.`}
      table={
        <ChartTable
          columns={["Month", `Collected (${currency})`]}
          rows={collected.months.map((key, i) => [monthLabel(key), formatMoney(values[i] ?? 0, currency)])}
        />
      }
    >
      {total > 0 ? (
        <ColumnChart columns={columns} label={`Collected by month in ${currency}`} format={{ currency }} tone="chart-2" />
      ) : (
        <ChartEmpty>{`Nothing collected in ${currency} in the last ${collected.months.length} months.`}</ChartEmpty>
      )}
    </ChartFrame>
  );
}

function MrrByPlanChart({ mrrPlans, currency }: { mrrPlans: MrrByPlan; currency: string }) {
  const plans = mrrPlans.find((p) => p.currency === currency)?.plans ?? [];
  return (
    <ChartFrame
      title="MRR by plan"
      description={`What each plan brings in a month, in ${currency}.`}
      table={<ChartTable columns={["Plan", `A month (${currency})`]} rows={plans.map((p) => [p.name, formatMoney(p.mrr, currency)])} />}
    >
      {plans.length > 0 ? (
        <HBarChart bars={plans.map((p) => ({ key: p.key, label: p.name, value: p.mrr }))} label={`MRR by plan in ${currency}`} format={{ currency }} />
      ) : (
        <ChartEmpty>{`No plan is paid for in ${currency} yet.`}</ChartEmpty>
      )}
    </ChartFrame>
  );
}

function StatusChart({ statuses }: { statuses: SubscriptionStatusCount[] }) {
  const count = (status: SubscriptionStatusKey, gateway?: GatewayKey) =>
    statuses.filter((s) => s.status === status && (!gateway || s.gateway === gateway)).reduce((sum, s) => sum + s.n, 0);
  const total = statuses.reduce((sum, s) => sum + s.n, 0);
  return (
    <ChartFrame
      title="Subscriptions by status"
      description="Every subscription — at a gateway, on a trial or given by hand — the ended ones included."
      table={
        <ChartTable
          columns={["Status", ...GATEWAY_COLUMNS.map((g) => g.label), "All"]}
          rows={STATUS_ORDER.map((status) => [SUBSCRIPTION_STATUS[status].label, ...GATEWAY_COLUMNS.map((g) => count(status, g.key)), count(status)])}
        />
      }
    >
      {total > 0 ? (
        <HBarChart
          label="Subscriptions by status"
          bars={STATUS_ORDER.map((status) => ({
            key: status,
            label: SUBSCRIPTION_STATUS[status].label,
            value: count(status),
            tone: STATUS_TONE[status],
            href: `/billing?tab=subscriptions&status=${status}`,
          }))}
        />
      ) : (
        <ChartEmpty>No subscriptions yet.</ChartEmpty>
      )}
    </ChartFrame>
  );
}

function NeedsAttention({ alerts, more }: { alerts: Alert[]; more: number }) {
  return (
    <Panel
      title="Needs attention"
      description="Billing and trial alerts, the most serious first."
      padded={false}
      footer={
        <Link href="/alerts" className="inline-flex items-center gap-1 rounded-base font-medium text-brand hover:underline">
          {more > 0 ? `${plural(more, "more alert")} on the Alerts page` : "All alerts"}
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
      }
    >
      {alerts.length === 0 ? (
        <EmptyState icon={<CircleCheck className="h-5 w-5" />} title="Nothing needs attention" body="No billing or trial alert is open." />
      ) : (
        <ul className="divide-y divide-line">
          {alerts.map((a) => {
            const severity = ALERT_SEVERITY[a.severity];
            return (
              <li key={a.key} className="flex items-start gap-3 px-5 py-3">
                <StatusPill tone={severity.tone} className="mt-0.5">
                  {severity.label}
                </StatusPill>
                <div className="min-w-0 flex-1">
                  <Link href={a.href} className="font-medium text-text hover:text-brand hover:underline">
                    {a.title}
                  </Link>
                  {a.detail && <p className="mt-0.5 text-xs text-muted">{a.detail}</p>}
                </div>
                {a.since && (
                  <span className="shrink-0 text-xs whitespace-nowrap text-subtle">
                    <RelativeTime at={a.since} />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
