import type { ReactNode } from "react";
import type { Metadata } from "next";
import { CircleCheck, CirclePause, DatabaseZap, History, Terminal } from "lucide-react";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { Meter } from "@/components/console/charts/meter";
import { Banner } from "@/components/console/kit/banner";
import { CopyField } from "@/components/console/kit/copy-field";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField } from "@/components/console/kit/filter-controls";
import { FilterBar, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { BehindTable } from "@/components/console/migrations/behind-table";
import { RunsList } from "@/components/console/migrations/runs-list";
import { Disclosure } from "@/components/ui/disclosure";
import { Pagination } from "@/components/ui/pagination";
import { plural } from "@/lib/console-shared/format";
import { runOutcome, schemaLabel } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { parseMigrationFilters, withParams } from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { migrationsBoard, type MigrationsBoard } from "@/lib/platform/console-data";
import { consoleClock } from "@/lib/platform/console-clock";
import { consoleStaff } from "@/lib/platform/console-page";
import type { Clock } from "@/lib/time/zone";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Migrations" };

const PATH = "/migrations";
/** Run groups a page — the loader's page size (migrationsBoard). */
const RUNS_PAGE = 20;
const SCRIPT = "npm run tenants:migrate";
const num = (n: number) => n.toLocaleString("en-IN");

/**
 * Migrations (spec §3.13): the schema every workspace database should be on, the workspaces that are
 * not — held ones first, since their users see a maintenance page — and the runs, grouped, newest
 * first. A full run is `npm run tenants:migrate` on the server, before new code is deployed; from here
 * a manager migrates or retries one workspace at a time. Bulk migration is not offered here.
 *
 * Every role reads it. The page refreshes itself every few seconds while a run is going, and each
 * run's output arrives redacted from the loader.
 */
export default async function ConsoleMigrationsPage({ searchParams }: PageProps<"/platform-console/migrations">) {
  // First: signed out, the page ends here with a redirect to /login.
  const staff = await consoleStaff(PAGE_ROLES.migrations);
  const caps = capsFor(staff.role);
  const sp = await searchParams;
  const f = parseMigrationFilters(sp);
  const [board, clock] = await Promise.all([migrationsBoard(f), consoleClock()]);
  const c = board.counts;

  const narrowed = Boolean(f.q) || f.outcome !== "all";
  const totalPages = Math.max(1, Math.ceil(board.runsTotal / RUNS_PAGE));
  const clearHref = withParams(PATH, sp, { outcome: null, q: null });

  const subtitle = board.latest ? (
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-1.5">
      Latest migration
      <CopyField value={board.latest} label="the latest migration name" />
    </span>
  ) : (
    "This version of the code carries no workspace migrations."
  );

  return (
    <>
      <PageHeader
        title="Migrations"
        chips={
          <StatusPill tone={board.latest ? "brand" : "neutral"} title={board.latest ?? undefined}>
            {`Latest: ${schemaLabel(board.latest)}`}
          </StatusPill>
        }
        subtitle={subtitle}
        asOf={board.asOf}
        autoRefreshSeconds={5}
        live={board.live}
      />

      <div className="space-y-6">
        <Disclosure summary="How this works">
          A full run is <code className="font-mono text-xs text-text">{SCRIPT}</code>, started on the server before new code is deployed. It migrates the
          control plane, the reference data and the warm pool, then the platform&apos;s own workspace as a canary — if that fails nobody else is touched —
          then every other workspace, eight at a time. A workspace whose migration fails is held, and its users see a maintenance page, until a later run
          brings it through; every run retries the held ones.
          {caps.manage && " From here you can migrate one workspace, or retry a held one, without waiting for the next full run."}
        </Disclosure>

        <KpiGrid>
          <UpToDateTile counts={c} />
          <KpiTile
            label="Behind"
            value={num(c.behind)}
            icon={<History className="h-4 w-4" />}
            href="#behind"
            tone={c.behind > 0 ? "warning" : "neutral"}
            secondary={c.behind > 0 ? "Not on the latest schema, or held" : "Every open workspace is current"}
          />
          <KpiTile
            label="Migration held"
            value={num(c.held)}
            icon={<CirclePause className="h-4 w-4" />}
            href="#behind"
            tone={c.held > 0 ? "danger" : "neutral"}
            secondary={c.held > 0 ? "Users see a maintenance page" : "None held"}
          />
          <LastFullRunTile run={board.lastFullRun} clock={clock} />
        </KpiGrid>

        {c.held > 0 && (
          <Banner tone="danger" title={`${plural(c.held, "workspace")} held by a failed migration`}>
            {`${c.held === 1 ? "Its users see" : "Their users see"} a maintenance page until a migration succeeds. ${
              caps.manage ? `Retry ${c.held === 1 ? "it" : "each"} below, or run ${SCRIPT} on the server.` : `A manager can retry ${c.held === 1 ? "it" : "each"} below.`
            }`}
          </Banner>
        )}

        <Panel
          id="behind"
          title="Behind the latest"
          description={
            c.behind > 0
              ? `${plural(c.behind, "workspace")} — held ones first. The next full run covers every one.`
              : "Open workspaces not on the latest schema, and any held since a migration failed"
          }
          padded={false}
        >
          {board.behind.length > 0 ? (
            <BehindTable rows={board.behind} caps={caps} />
          ) : (
            <EmptyState icon={<CircleCheck className="h-5 w-5" />} title="Every open workspace is up to date." body={`On ${schemaLabel(board.latest)}, with none held.`} />
          )}
        </Panel>

        <section aria-labelledby="runs-heading">
          <div className="mb-3">
            <h2 id="runs-heading" className="text-sm font-semibold text-text">
              Runs
            </h2>
            <p className="mt-0.5 text-xs text-muted">Each run and the databases it covered, newest first. Open one for its databases and their output.</p>
          </div>

          <FilterBar trailing={<SearchField label="Search runs by database" placeholder="Workspace address or database" />}>
            <ViewTabs
              label="Run outcome"
              items={[
                { key: "all", label: "All runs", href: withParams(PATH, sp, { outcome: null }), active: f.outcome === "all", count: f.outcome === "all" ? board.runsTotal : null },
                {
                  key: "failed",
                  label: "With failures",
                  href: withParams(PATH, sp, { outcome: "failed" }),
                  active: f.outcome === "failed",
                  count: f.outcome === "failed" ? board.runsTotal : null,
                },
              ]}
            />
          </FilterBar>

          {board.runs.length > 0 ? (
            <>
              <Panel padded={false}>
                <RunsList runs={board.runs} />
              </Panel>
              {totalPages > 1 && (
                <Pagination page={board.page} pageSize={RUNS_PAGE} total={board.runsTotal} totalPages={totalPages} pageSizes={[RUNS_PAGE]} label="runs" />
              )}
            </>
          ) : (
            <Panel padded={false}>
              {narrowed ? (
                <EmptyState
                  variant="filtered"
                  title={f.q ? `No run covered a database matching “${f.q}”.` : "No run has had a failure."}
                  body={f.q ? "Search by a workspace's address, or control, reference or a warm database's name." : "Runs where any database failed are listed here."}
                  clearHref={clearHref}
                />
              ) : (
                <EmptyState
                  icon={<DatabaseZap className="h-5 w-5" />}
                  title="No migration run has been recorded yet."
                  body={`Runs appear here once ${SCRIPT} has run on the server, or a workspace has been migrated from this page.`}
                />
              )}
            </Panel>
          )}
        </section>
      </div>
    </>
  );
}

// The same card as KpiTile (src/components/console/charts/kpi-tile.tsx). KpiTile's meter colours by
// how close a value is to a limit — right for seats, wrong here, where a full bar is the good news —
// so this tile passes the meter's tone itself.
function UpToDateTile({ counts }: { counts: MigrationsBoard["counts"] }) {
  const { total, upToDate, behind } = counts;
  const tone = total === 0 ? "neutral" : behind > 0 ? "warning" : "success";
  let value: ReactNode = "—";
  if (total > 0) {
    value = (
      <>
        {num(upToDate)}
        <span className="text-base font-medium text-muted">{` of ${num(total)}`}</span>
      </>
    );
  }
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            "grid h-8 w-8 shrink-0 place-items-center rounded-lg",
            tone === "success" ? "bg-success-bg text-success" : tone === "warning" ? "bg-warning-bg text-warning" : "bg-surface-sunken text-muted",
          )}
        >
          <CircleCheck className="h-4 w-4" />
        </span>
        <p className="min-w-0 text-xs font-medium text-muted">Up to date</p>
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight text-text tabular-nums">{value}</div>
      {total > 0 && (
        <div className="mt-2.5">
          <Meter value={upToDate} max={total} label="Open workspaces on the latest schema" tone={tone === "success" ? "success" : "warning"} />
        </div>
      )}
      <p className="mt-2 text-xs text-muted">{total === 0 ? "No open workspaces yet" : behind > 0 ? `${num(behind)} behind the latest` : "Every open workspace"}</p>
    </div>
  );
}

function LastFullRunTile({ run, clock }: { run: MigrationsBoard["lastFullRun"]; clock: Clock }) {
  if (!run) {
    return <KpiTile label="Last full run" value="Never" icon={<Terminal className="h-4 w-4" />} secondary={`Started on the server with ${SCRIPT}`} />;
  }
  const outcome = runOutcome(run.ok);
  const tone = run.ok === false ? "danger" : run.ok === null ? "info" : "success";
  return (
    <KpiTile
      label="Last full run"
      value={clock.dayMonth(run.startedAt)}
      icon={<Terminal className="h-4 w-4" />}
      tone={tone}
      secondary={
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <StatusPill tone={outcome.tone}>{outcome.label}</StatusPill>
          <RelativeTime at={run.startedAt} />
          {run.by && run.by !== SCRIPT && <span>{`· by ${run.by}`}</span>}
        </span>
      }
    />
  );
}
