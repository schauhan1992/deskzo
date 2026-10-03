import { Activity, CalendarDays, Sparkles, Users } from "lucide-react";
import { AreaTrend } from "@/components/console/charts/area-trend";
import { ChartFrame, ChartTable } from "@/components/console/charts/chart-frame";
import { ColumnChart } from "@/components/console/charts/column-chart";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { compactNumber, dayKeyLabel, monthLabel, plural } from "@/lib/console-shared/format";
import type { UsagePanel, UsagePoint } from "@/lib/platform/workspace-data";

/**
 * Workspace 360 › Usage: seats in use against the seat limit and copilot tokens against theirs, as
 * the platform tick snapshots them once a day — the latest reading, 90 days of seats, copilot use by
 * month, and the last 30 days as numbers. Read-only for every role.
 */

const INTEGER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** A snapshot's calendar day: the column holds the date itself (the console's day it was taken on), so its UTC date is that date. */
const dayKeyOf = (p: UsagePoint) => p.day.toISOString().slice(0, 10);

const seatLimitText = (n: number | null) => (n === null ? "No limit" : INTEGER.format(n));

/** How close to a limit: over it, within 10% of it, or comfortably under (or no limit at all). */
function pressure(used: number, limit: number | null): "danger" | "warning" | "neutral" {
  if (limit === null) return "neutral";
  if (used > limit || (limit === 0 && used > 0)) return "danger";
  return limit > 0 && used / limit >= 0.9 ? "warning" : "neutral";
}

export function UsageTab({ usage }: { usage: UsagePanel }) {
  const { series, latest, copilotByMonth, limits } = usage;

  if (!latest) {
    return (
      <Panel title="Usage">
        <EmptyState icon={<Activity className="h-5 w-5" />} title="No usage recorded yet." body="Usage is snapshotted once a day by the platform tick." />
      </Panel>
    );
  }

  const latestKey = dayKeyOf(latest);
  const latestMonth = monthLabel(latestKey.slice(0, 7));
  const peak = series.reduce<UsagePoint | null>((best, p) => (best === null || p.seatsUsed > best.seatsUsed ? p : best), null);
  const seatTone = pressure(latest.seatsUsed, limits.seats);
  const tokenTone = pressure(latest.copilotTokens, limits.copilotTokens);
  const lastThirty = series.slice(-30).reverse();
  const newestFirst = [...series].reverse();

  return (
    <div className="space-y-6">
      <KpiGrid columns={4}>
        <KpiTile
          label="Seats in use"
          icon={<Users className="h-4 w-4" />}
          tone={seatTone}
          value={INTEGER.format(latest.seatsUsed)}
          meter={{ value: latest.seatsUsed, max: limits.seats, label: "Seats in use against the seat limit" }}
          secondary={
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {limits.seats === null ? "No seat limit" : `of ${INTEGER.format(limits.seats)}`}
              {limits.seatOverride !== null && <StatusPill tone="warning">overridden</StatusPill>}
            </span>
          }
        />
        <KpiTile
          label={`Copilot tokens, ${latestMonth}`}
          icon={<Sparkles className="h-4 w-4" />}
          tone={tokenTone}
          value={compactNumber(latest.copilotTokens)}
          meter={limits.copilotTokens === 0 ? undefined : { value: latest.copilotTokens, max: limits.copilotTokens, label: "Copilot tokens this month against the limit" }}
          secondary={
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {limits.copilotTokens === null ? "No token limit" : limits.copilotTokens === 0 ? "The copilot is off" : `of ${compactNumber(limits.copilotTokens)} a month`}
              {limits.copilotTokenOverride !== null && <StatusPill tone="warning">overridden</StatusPill>}
            </span>
          }
        />
        <KpiTile
          label="Busiest day, 90 days"
          icon={<Activity className="h-4 w-4" />}
          value={peak ? INTEGER.format(peak.seatsUsed) : "—"}
          secondary={peak ? `seats on ${dayKeyLabel(dayKeyOf(peak))}` : "No snapshot in the window"}
        />
        <KpiTile
          label="Latest snapshot"
          icon={<CalendarDays className="h-4 w-4" />}
          value={dayKeyLabel(latestKey, false)}
          secondary={`${plural(series.length, "day")} recorded in the last 90`}
        />
      </KpiGrid>

      {series.length === 0 ? (
        <Banner tone="info" title="No snapshot in the last 90 days.">
          {`The latest is from ${dayKeyLabel(latestKey)}. Usage is snapshotted once a day by the platform tick while the workspace is open.`}
        </Banner>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2">
              <ChartFrame
                title="Seats in use"
                description={limits.seats === null ? "Each day's snapshot over the last 90 days." : "Each day's snapshot over the last 90 days; the dashed line is the seat limit."}
                table={
                  <ChartTable
                    columns={["Day", "Seats in use", "Seat limit"]}
                    rows={newestFirst.map((p) => [dayKeyLabel(dayKeyOf(p)), p.seatsUsed, seatLimitText(p.seatsLimit)])}
                  />
                }
              >
                <AreaTrend
                  label="Seats in use per day"
                  points={series.map((p) => ({ key: dayKeyOf(p), label: dayKeyLabel(dayKeyOf(p), false), value: p.seatsUsed }))}
                  limit={limits.seats}
                  limitLabel="Seat limit"
                />
              </ChartFrame>
            </div>
            <ChartFrame
              title="Copilot tokens by month"
              description="Each month's highest reading — the count runs up through the month."
              table={<ChartTable columns={["Month", "Tokens"]} rows={copilotByMonth.map((m) => [monthLabel(m.month), m.tokens])} />}
            >
              <ColumnChart
                label="Copilot tokens by month"
                format="tokens"
                tone="chart-5"
                columns={copilotByMonth.map((m) => ({ key: m.month, label: monthLabel(m.month), value: m.tokens }))}
              />
            </ChartFrame>
          </div>

          <Panel title="Last 30 days" description="The daily snapshots, newest first. Copilot tokens count up through each month." padded={false}>
            <DataTable caption="Usage over the last 30 days" minWidth={560}>
              <THead>
                <Th>Day</Th>
                <Th numeric>Seats in use</Th>
                <Th numeric>Seat limit</Th>
                <Th numeric>Copilot tokens this month</Th>
              </THead>
              <TBody>
                {lastThirty.map((p) => {
                  const over = p.seatsLimit !== null && p.seatsUsed > p.seatsLimit;
                  return (
                    <Tr key={dayKeyOf(p)}>
                      <Td nowrap>{dayKeyLabel(dayKeyOf(p))}</Td>
                      <Td numeric className={over ? "font-medium text-danger" : undefined}>
                        {INTEGER.format(p.seatsUsed)}
                        {over && <span className="sr-only"> — over the limit</span>}
                      </Td>
                      <Td numeric muted>
                        {seatLimitText(p.seatsLimit)}
                      </Td>
                      <Td numeric>{INTEGER.format(p.copilotTokens)}</Td>
                    </Tr>
                  );
                })}
              </TBody>
            </DataTable>
          </Panel>
        </>
      )}

    </div>
  );
}
