import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { Activity, CircleCheck, CircleX, Hourglass, Rocket, Server } from "lucide-react";
import { ChartEmpty, ChartFrame, ChartTable } from "@/components/console/charts/chart-frame";
import type { ChartTone } from "@/components/console/charts/chart-utils";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { Meter } from "@/components/console/charts/meter";
import { StackedColumns } from "@/components/console/charts/stacked-columns";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField } from "@/components/console/kit/filter-controls";
import { FilterBar, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { JobsTable } from "@/components/console/provisioning/jobs-table";
import { TopUpButton } from "@/components/console/provisioning/top-up-button";
import { WarmPool } from "@/components/console/provisioning/warm-pool";
import { Pagination } from "@/components/ui/pagination";
import { dayKeyLabel, plural } from "@/lib/console-shared/format";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { parseProvisioningFilters, withParams, type ProvisioningFilters } from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { provisioningBoard, type ProvisioningBoard } from "@/lib/platform/console-data";
import { consoleStaff } from "@/lib/platform/console-page";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Provisioning" };

const PATH = "/provisioning";
const num = (n: number) => n.toLocaleString("en-IN");

type Filter = ProvisioningFilters["filter"];

const FILTER_LABELS: Record<Filter, string> = { all: "All", attention: "Needs attention", progress: "In progress", done: "Done" };
const FILTERS = ["all", "attention", "progress", "done"] as const satisfies readonly Filter[];

/** A preset with nothing in it says so in its own words. */
const EMPTY_FILTER: Record<Exclude<Filter, "all">, { title: string; body: string }> = {
  attention: { title: "Nothing needs attention.", body: "Failed setups, and ones waiting past their start or running for over 30 minutes, are listed here." },
  progress: { title: "Nothing is being set up right now.", body: "Setups waiting for the worker or running are listed here." },
  done: { title: "No setup has finished yet.", body: "Workspaces set up successfully are listed here." },
};

const OUTCOMES: { key: "succeeded" | "failed"; label: string; tone: ChartTone }[] = [
  { key: "succeeded", label: "Done", tone: "success" },
  { key: "failed", label: "Failed", tone: "danger" },
];

/**
 * Provisioning (spec §3.12): the platform worker setting workspaces up — their database, first owner
 * and organisation — and the warm pool of databases it keeps ready. Failed setups come first; the
 * board refreshes itself every few seconds while anything waits or runs.
 *
 * Every role reads it; managers try a failed setup again and top the warm pool up (which starts the
 * worker). Errors arrive redacted, and no owner password or hash is ever loaded.
 */
export default async function ConsoleProvisioningPage({ searchParams }: PageProps<"/platform-console/provisioning">) {
  // First: signed out, the page ends here with a redirect to /login.
  const staff = await consoleStaff(PAGE_ROLES.provisioning);
  const caps = capsFor(staff.role);
  const sp = await searchParams;
  const f = parseProvisioningFilters(sp);
  const board = await provisioningBoard(f);
  const c = board.counts;

  // Stale running (over 30 minutes) and late waiting (10 minutes past its start) — the worker may have stopped.
  const stuck = Math.max(0, c.attention - c.failed);
  const totalPages = Math.max(1, Math.ceil(board.total / board.pageSize));
  const filterHref = (filter: Filter) => withParams(PATH, sp, { filter: filter === "all" ? null : filter, topup: null });
  // The tiles and the banner count every setup, so they open the unsearched list.
  const countHref = (filter: Exclude<Filter, "all">) => withParams(PATH, {}, { filter });
  // Counted across every setup, so a search hides them rather than showing totals it did not narrow.
  const tabCounts: Record<Filter, number> = { all: c.all, attention: c.attention, progress: c.progress, done: c.done };

  const subtitle = board.workerLastFinished ? (
    <>
      Worker last finished a job <RelativeTime at={board.workerLastFinished} />
    </>
  ) : (
    "The worker has not finished a job yet"
  );

  return (
    <>
      <PageHeader
        title="Provisioning"
        subtitle={subtitle}
        asOf={board.asOf}
        autoRefreshSeconds={5}
        live={board.live}
        actions={caps.manage ? <TopUpButton target={board.warm.target} /> : undefined}
      />

      <div className="space-y-6">
        <KpiGrid columns={5}>
          <KpiTile
            label="Running"
            value={num(c.running)}
            icon={<Activity className="h-4 w-4" />}
            href={countHref("progress")}
            tone={c.running > 0 ? "info" : "neutral"}
            secondary={c.running > 0 ? "Being set up now" : "Nothing running"}
          />
          <KpiTile
            label="Waiting"
            value={num(c.waiting)}
            icon={<Hourglass className="h-4 w-4" />}
            href={countHref("progress")}
            tone={stuck > 0 && c.waiting > 0 ? "warning" : "neutral"}
            secondary={c.waiting > 0 ? "Queued for the worker" : "Nothing queued"}
          />
          <KpiTile
            label="Failed"
            value={num(c.failed)}
            icon={<CircleX className="h-4 w-4" />}
            href={countHref("attention")}
            tone={c.failed > 0 ? "danger" : "neutral"}
            secondary={c.failed > 0 ? `${c.failed === 1 ? "Needs" : "Need"} trying again` : "No failed setup"}
          />
          <KpiTile
            label="Done in 24 h"
            value={num(c.doneToday)}
            icon={<CircleCheck className="h-4 w-4" />}
            href={countHref("done")}
            tone={c.doneToday > 0 ? "success" : "neutral"}
            secondary={`${num(c.done)} done in all`}
          />
          <WarmPoolTile warm={board.warm} />
        </KpiGrid>

        {stuck > 0 && (
          <Banner
            tone="warning"
            title={`${plural(stuck, "setup")} ${stuck === 1 ? "is" : "are"} stuck`}
            action={
              f.filter === "attention" ? undefined : (
                <Link href={countHref("attention")} className="rounded-base text-sm font-medium underline underline-offset-2">
                  Show {stuck === 1 ? "it" : "them"}
                </Link>
              )
            }
          >
            {`Waiting past ${stuck === 1 ? "its" : "their"} start or running for over 30 minutes — the worker may have stopped.`}
            {caps.manage && " Topping up the warm pool starts it again."}
          </Banner>
        )}

        <section aria-labelledby="setups-heading">
          <div className="mb-3">
            <h2 id="setups-heading" className="text-sm font-semibold text-text">
              Setups
            </h2>
            <p className="mt-0.5 text-xs text-muted">Failed first, then running, waiting and done — newest first in each. The worker takes one job at a time.</p>
          </div>

          <FilterBar trailing={<SearchField label="Search setups" placeholder="Workspace, address or company" />}>
            <ViewTabs
              label="Setup views"
              items={FILTERS.map((key) => ({ key, label: FILTER_LABELS[key], href: filterHref(key), active: f.filter === key, count: f.q ? null : tabCounts[key] }))}
            />
          </FilterBar>

          {board.rows.length > 0 ? (
            <>
              <Panel padded={false}>
                <JobsTable rows={board.rows} caps={caps} />
              </Panel>
              {totalPages > 1 && (
                <Pagination page={board.page} pageSize={board.pageSize} total={board.total} totalPages={totalPages} pageSizes={[board.pageSize]} label="setups" />
              )}
            </>
          ) : (
            <Panel padded={false}>
              <SetupsEmpty board={board} filters={f} clearHref={PATH} />
            </Panel>
          )}
        </section>

        <div className="grid items-start gap-6 xl:grid-cols-2">
          <SetupsChart byDay={board.byDay} />
          <WarmPool warm={board.warm} />
        </div>
      </div>
    </>
  );
}

function SetupsEmpty({ board, filters, clearHref }: { board: ProvisioningBoard; filters: ProvisioningFilters; clearHref: string }) {
  if (board.counts.all === 0) {
    return <EmptyState icon={<Rocket className="h-5 w-5" />} title="No setups yet." body="They appear here when someone signs up." />;
  }
  if (filters.q) {
    return <EmptyState variant="filtered" title={`No setup matches “${filters.q}”.`} body="Search by the workspace's address or name, or the company." clearHref={clearHref} />;
  }
  if (filters.filter === "all") return <EmptyState title="No setups on this page." body="Go back to the first page." variant="filtered" clearHref={clearHref} />;
  const copy = EMPTY_FILTER[filters.filter];
  return <EmptyState icon={filters.filter === "attention" ? <CircleCheck className="h-5 w-5" /> : undefined} title={copy.title} body={copy.body} variant="filtered" clearHref={clearHref} />;
}

/** Fourteen of India's days of finished setups, by how they ended. */
function SetupsChart({ byDay }: { byDay: ProvisioningBoard["byDay"] }) {
  const done = byDay.reduce((sum, d) => sum + d.succeeded, 0);
  const failed = byDay.reduce((sum, d) => sum + d.failed, 0);
  return (
    <ChartFrame
      title="Setups per day"
      description={
        done + failed === 0
          ? "Setups finished in the last 14 days, by outcome"
          : `${plural(done + failed, "setup")} finished in the last 14 days${failed > 0 ? ` · ${num(failed)} failed` : " · none failed"}`
      }
      table={done + failed > 0 ? <ChartTable columns={["Day", "Done", "Failed"]} rows={byDay.map((d) => [dayKeyLabel(d.day), d.succeeded, d.failed])} /> : undefined}
    >
      {done + failed === 0 ? (
        <ChartEmpty>No setup finished in the last 14 days.</ChartEmpty>
      ) : (
        <StackedColumns
          columns={byDay.map((d) => ({ key: d.day, label: dayKeyLabel(d.day, false), segments: { succeeded: d.succeeded, failed: d.failed } }))}
          series={OUTCOMES}
          label="Setups finished each day over the last 14 days, by outcome"
        />
      )}
    </ChartFrame>
  );
}

// The warm pool's tile. KpiTile's meter colours by how close a value is to a limit — right for seats,
// wrong here, where a full pool is the good news — so this one passes the meter's tone itself.
const TILE_CHIP = { success: "bg-success-bg text-success", warning: "bg-warning-bg text-warning", danger: "bg-danger-bg text-danger", neutral: "bg-surface-sunken text-muted" };

function WarmPoolTile({ warm }: { warm: ProvisioningBoard["warm"] }) {
  const ready = warm.ready.length;
  const off = warm.target <= 0;
  const tone = off ? "neutral" : ready === 0 ? "danger" : ready < warm.target ? "warning" : "success";
  let value: ReactNode = "Off";
  if (!off) {
    value = (
      <>
        {num(ready)}
        <span className="text-base font-medium text-muted">{` of ${num(warm.target)}`}</span>
      </>
    );
  }
  return (
    <Link href="#warm-pool" className="block rounded-xl border border-line bg-surface p-4 shadow-sm transition-colors hover:border-line-strong">
      <div className="flex items-center gap-2.5">
        <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", TILE_CHIP[tone])} aria-hidden="true">
          <Server className="h-4 w-4" />
        </span>
        <p className="min-w-0 text-xs font-medium text-muted">Warm pool</p>
      </div>
      <div className={cn("mt-3 text-2xl font-semibold tracking-tight tabular-nums", tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-text")}>
        {value}
      </div>
      {!off && (
        <div className="mt-2.5">
          <Meter value={ready} max={warm.target} label="Warm databases ready" tone={tone === "neutral" ? "muted" : tone} />
        </div>
      )}
      <p className="mt-2 text-xs text-muted">{off ? "No databases are kept ready" : ready === 0 ? "None ready — a signup waits for a fresh one" : "databases ready for signups"}</p>
    </Link>
  );
}
