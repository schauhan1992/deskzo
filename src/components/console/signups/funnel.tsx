import Link from "next/link";
import { UserPlus } from "lucide-react";
import { ChartFrame, ChartTable } from "@/components/console/charts/chart-frame";
import type { ChartTone } from "@/components/console/charts/chart-utils";
import { ColumnChart } from "@/components/console/charts/column-chart";
import { HBarChart } from "@/components/console/charts/hbar-chart";
import { StatusBar } from "@/components/console/charts/status-bar";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { dayKeyLabel, monthLabel, percent, plural } from "@/lib/console-shared/format";
import type { SignupFunnel } from "@/lib/platform/signups";

/**
 * The signups page's charts (spec §3.6): how far people get from "start" to "paying", signups over
 * the range, where they come from, and how many came with an invitation. Server-safe; every chart
 * keeps its exact figures under "Show as table".
 *
 * Each funnel step is scaled to the people who started, and says what share of the step before it
 * got through — the drop between two steps is the number worth acting on.
 */

/** Past this many days a column a day is a comb; the chart counts by month instead. */
const DAILY_MAX = 92;
const TOP_COUNTRIES = 10;

export function SignupFunnelCharts({ funnel }: { funnel: SignupFunnel }) {
  const range = `${dayKeyLabel(funnel.from)} – ${dayKeyLabel(funnel.to)}`;
  if (funnel.started === 0) {
    return (
      <Panel padded={false}>
        <EmptyState icon={<UserPlus className="h-5 w-5" />} title="No signups in this period." body={`Nobody started signing up between ${range}. Try a wider range.`} />
      </Panel>
    );
  }
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <FunnelChart funnel={funnel} />
      <PerDayChart funnel={funnel} />
      <CountryChart funnel={funnel} />
      <InviteChart funnel={funnel} />
    </div>
  );
}

function FunnelChart({ funnel: f }: { funnel: SignupFunnel }) {
  const steps: { key: string; label: string; value: number; tone?: ChartTone }[] = [
    { key: "started", label: "Started", value: f.started },
    { key: "verified", label: "Verified email", value: f.verified },
    { key: "ready", label: "Workspace ready", value: f.ready },
    { key: "signed-in", label: "Signed in", value: f.handedOff },
    { key: "paying", label: "Paying", value: f.paying, tone: "chart-2" },
  ];
  const bars = steps.map((s, i) => ({ ...s, tone: s.tone ?? ("chart-1" as const), note: i === 0 ? undefined : percent(s.value, steps[i - 1]!.value) }));
  return (
    <ChartFrame
      title="Signup funnel"
      description={`${percent(f.paying, f.started)} of the people who started now pay · each step as a share of the one before`}
      table={
        <ChartTable
          columns={["Step", "People", "Of the step before", "Of all who started"]}
          rows={steps.map((s, i) => [s.label, s.value, i === 0 ? "—" : percent(s.value, steps[i - 1]!.value), percent(s.value, f.started)])}
        />
      }
    >
      <HBarChart bars={bars} label="Signup funnel" max={f.started} />
      <p className="mt-3 text-xs text-muted">
        {`${plural(f.provisioned, "workspace")} requested`}
        {f.failed > 0 && (
          <>
            {" · "}
            <Link href="/provisioning?filter=attention" className="font-medium text-danger hover:underline">
              {`${plural(f.failed, "setup")} failed and not tried again`}
            </Link>
          </>
        )}
      </p>
    </ChartFrame>
  );
}

function PerDayChart({ funnel: f }: { funnel: SignupFunnel }) {
  const monthly = f.byDay.length > DAILY_MAX;
  const points = monthly ? byMonth(f.byDay) : f.byDay.map((d) => ({ key: d.day, label: dayKeyLabel(d.day, false), full: dayKeyLabel(d.day), n: d.n }));
  const busiest = points.reduce((best, p) => (p.n > best.n ? p : best), points[0] ?? { key: "", label: "", full: "", n: 0 });
  return (
    <ChartFrame
      title={monthly ? "Signups per month" : "Signups per day"}
      description={busiest.n > 0 ? `Busiest ${monthly ? "month" : "day"}: ${busiest.full}, ${plural(busiest.n, "signup")}` : undefined}
      table={<ChartTable columns={[monthly ? "Month" : "Day", "Signups"]} rows={points.map((p) => [p.full, p.n])} />}
    >
      <ColumnChart columns={points.map((p) => ({ key: p.key, label: p.label, value: p.n }))} label={monthly ? "Signups per month" : "Signups per day"} />
    </ChartFrame>
  );
}

function byMonth(days: SignupFunnel["byDay"]): { key: string; label: string; full: string; n: number }[] {
  const months = new Map<string, number>();
  for (const d of days) months.set(d.day.slice(0, 7), (months.get(d.day.slice(0, 7)) ?? 0) + d.n);
  return [...months].map(([key, n]) => ({ key, label: monthLabel(key), full: monthLabel(key), n }));
}

function CountryChart({ funnel: f }: { funnel: SignupFunnel }) {
  const top = f.byCountry.slice(0, TOP_COUNTRIES);
  const rest = f.byCountry.length - top.length;
  return (
    <ChartFrame
      title="By country"
      description={`${plural(f.byCountry.length, "country", "countries")}${rest > 0 ? ` · the top ${TOP_COUNTRIES} shown` : ""}`}
      table={
        <ChartTable columns={["Country", "Signups", "Share"]} rows={f.byCountry.map((c) => [c.country, c.n, percent(c.n, f.started)])} />
      }
    >
      <HBarChart bars={top.map((c) => ({ key: c.country, label: c.country, value: c.n, tone: "chart-6" as const, note: percent(c.n, f.started) }))} label="Signups by country" />
    </ChartFrame>
  );
}

function InviteChart({ funnel: f }: { funnel: SignupFunnel }) {
  const segments = [
    { key: "invited", label: "With an invitation", value: f.byInvite.invited, tone: "chart-5" as const },
    { key: "open", label: "Without one", value: f.byInvite.open, tone: "chart-1" as const },
  ];
  const total = f.byInvite.invited + f.byInvite.open;
  return (
    <ChartFrame
      title="Invited vs open"
      description={`${percent(f.byInvite.invited, total)} came with an invitation code`}
      table={<ChartTable columns={["Signed up", "People", "Share"]} rows={segments.map((s) => [s.label, s.value, percent(s.value, total)])} />}
    >
      <StatusBar segments={segments} label="Signups with and without an invitation" />
    </ChartFrame>
  );
}
