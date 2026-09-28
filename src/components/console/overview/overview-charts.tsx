import { ChartEmpty, ChartFrame, ChartTable } from "@/components/console/charts/chart-frame";
import { shareOf, type ChartTone } from "@/components/console/charts/chart-utils";
import { ColumnChart } from "@/components/console/charts/column-chart";
import { StatusBar } from "@/components/console/charts/status-bar";
import { ViewTabs } from "@/components/console/kit/filters";
import { formatMoney } from "@/lib/billing/money";
import { dayKeyLabel, monthLabel, plural } from "@/lib/console-shared/format";
import { TENANT_STATUS } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { TenantStatusKey } from "@/lib/console-shared/types";
import type { OverviewData } from "@/lib/platform/console-data";
import type { CollectedByMonth } from "@/lib/platform/revenue";

/**
 * The Overview's charts: new workspaces a week, the fleet split by status, and — for the staff who
 * sell — money collected a month, one currency at a time (`?currency=`; the switcher appears only when
 * there is more than one). Every chart keeps its exact figures under "Show as table".
 *
 * Two column charts sit side by side, so they scale alike; the status bar, which reads best wide, takes
 * the full row when there are two of them and shares the row with new workspaces when there is one.
 */

const num = (n: number) => n.toLocaleString("en-IN");

// Status colours, not series colours: here the colour means what it means on the status pills.
const STATUS_SEGMENTS: { key: TenantStatusKey; tone: ChartTone; href: string }[] = [
  { key: "ACTIVE", tone: "success", href: "/workspaces?status=ACTIVE" },
  { key: "PROVISIONING", tone: "info", href: "/workspaces?status=PROVISIONING" },
  { key: "SUSPENDED", tone: "warning", href: "/workspaces?status=SUSPENDED" },
  { key: "MIGRATING", tone: "danger", href: "/workspaces?status=MIGRATING" },
  { key: "DEPROVISIONED", tone: "muted", href: "/workspaces?view=closed" },
];

export function OverviewCharts({
  data,
  collected,
  currency,
  caps,
}: {
  data: OverviewData;
  collected: CollectedByMonth | null;
  currency: string | null;
  caps: Caps;
}) {
  if (caps.viewBilling && collected) {
    return (
      <div className="space-y-6">
        <StatusChart data={data} />
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <NewWorkspacesChart data={data} />
          <CollectedChart collected={collected} currency={currency} />
        </div>
      </div>
    );
  }
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <NewWorkspacesChart data={data} />
      <StatusChart data={data} />
    </div>
  );
}

function NewWorkspacesChart({ data }: { data: OverviewData }) {
  const weeks = data.newByWeek;
  const total = weeks.reduce((sum, w) => sum + w.n, 0);
  return (
    <ChartFrame
      title="New workspaces"
      description={`${plural(total, "workspace")} in the last 12 weeks · weeks start on Monday`}
      table={<ChartTable columns={["Week starting", "New workspaces"]} rows={weeks.map((w) => [dayKeyLabel(w.weekStart), w.n])} />}
    >
      <ColumnChart columns={weeks.map((w) => ({ key: w.weekStart, label: w.label, value: w.n }))} label="New workspaces per week" />
    </ChartFrame>
  );
}

function StatusChart({ data }: { data: OverviewData }) {
  const c = data.counts;
  const segments = STATUS_SEGMENTS.map((s) => ({ key: s.key, label: TENANT_STATUS[s.key].label, value: c.byStatus[s.key] ?? 0, tone: s.tone, href: s.href }));
  const held = c.heldStaff + c.heldBilling;
  return (
    <ChartFrame
      title="Workspaces by status"
      description={c.total === 0 ? "None yet" : `${plural(c.total, "workspace")} in all · ${num(c.open)} open`}
      table={
        c.total > 0 ? <ChartTable columns={["Status", "Workspaces", "Share"]} rows={segments.map((s) => [s.label, s.value, `${shareOf(s.value, c.total)}%`])} /> : undefined
      }
    >
      {c.total === 0 ? (
        <ChartEmpty>No workspaces yet.</ChartEmpty>
      ) : (
        <>
          <StatusBar segments={segments} label="Workspaces by status" />
          {held > 0 && <p className="mt-3 text-xs text-muted">{`Held: ${num(c.heldStaff)} by staff · ${num(c.heldBilling)} for billing`}</p>}
        </>
      )}
    </ChartFrame>
  );
}

/** "Oct 2025", "Nov", "Dec", "Jan 2026", "Feb"… — the year only where it starts or changes, so twelve labels fit. */
function monthTick(key: string, index: number): string {
  const label = monthLabel(key);
  return index === 0 || key.endsWith("-01") ? label : label.slice(0, 3);
}

function CollectedChart({ collected, currency }: { collected: CollectedByMonth; currency: string | null }) {
  const series = collected.series;
  const selected = series.find((s) => s.currency === currency) ?? series[0] ?? null;
  if (!selected) {
    return (
      <ChartFrame title="Collected by month" description="Paid invoices over the last 12 months">
        <ChartEmpty>No invoice has been paid in the last 12 months.</ChartEmpty>
      </ChartFrame>
    );
  }

  const code = selected.currency;
  const value = (i: number) => selected.values[i] ?? 0;
  const total = collected.months.reduce((sum, _, i) => sum + value(i), 0);
  const switcher =
    series.length > 1 ? (
      <ViewTabs
        label="Currency"
        items={series.map((s) => ({ key: s.currency, label: s.currency, href: `/?currency=${encodeURIComponent(s.currency)}`, active: s.currency === code }))}
      />
    ) : undefined;

  return (
    <ChartFrame
      title="Collected by month"
      description={`${formatMoney(total, code)} in 12 months · by the month each invoice was paid`}
      actions={switcher}
      table={<ChartTable columns={["Month", `Collected (${code})`]} rows={collected.months.map((key, i) => [monthLabel(key), formatMoney(value(i), code)])} />}
    >
      <ColumnChart
        columns={collected.months.map((key, i) => ({ key, label: monthTick(key, i), value: value(i) }))}
        label={`Collected by month in ${code}`}
        format={{ currency: code }}
        tone="chart-2"
      />
    </ChartFrame>
  );
}
