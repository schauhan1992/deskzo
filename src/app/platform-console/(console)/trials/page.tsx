import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, Hourglass, Percent, TimerReset } from "lucide-react";
import { ChartEmpty, ChartFrame, ChartTable } from "@/components/console/charts/chart-frame";
import type { ChartTone } from "@/components/console/charts/chart-utils";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { StackedColumns } from "@/components/console/charts/stacked-columns";
import { EmptyState } from "@/components/console/kit/empty-state";
import { ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { TrialsTable } from "@/components/console/trials/trials-table";
import { monthLabel, percent, plural } from "@/lib/console-shared/format";
import { TRIAL_VIEW_LABELS } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { TRIAL_VIEWS, parseTrialView, withParams, type TrialView } from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { consoleStaff } from "@/lib/platform/console-page";
import { trialCohorts, type TrialCohort } from "@/lib/platform/revenue";
import { trialRowsFor, trialsBoard, type TrialsBoard } from "@/lib/platform/trials";

export const metadata: Metadata = { title: "Trials" };

const PATH = "/trials";
const COHORT_MONTHS = 6;
const num = (n: number) => n.toLocaleString("en-IN");

/** A view with nothing in it says so in its own words. */
const EMPTY_VIEW: Record<Exclude<TrialView, "all">, { title: string; body: string }> = {
  ending: { title: "No trial ends in the next 7 days.", body: "Trials ending within a week are listed here, soonest first, with the reminders already sent." },
  later: { title: "No trial ends more than 7 days from now.", body: "Trials with more than a week to go are listed here." },
  grace: { title: "No trial is in its grace days.", body: "A trial that has ended is listed here until it pays or billing holds its workspace." },
  held: { title: "No workspace is held because its trial ran out.", body: "Extending a held trial reopens its workspace." },
};

// What became of each month's new workspaces — paying first, the ones lost last.
const OUTCOMES: { key: keyof Pick<TrialCohort, "paying" | "given" | "trialing" | "lapsed" | "closed">; label: string; tone: ChartTone }[] = [
  { key: "paying", label: "Paying", tone: "chart-2" },
  { key: "given", label: "Given free", tone: "chart-5" },
  { key: "trialing", label: "Still trialing", tone: "chart-1" },
  { key: "lapsed", label: "Lapsed", tone: "chart-3" },
  { key: "closed", label: "Closed", tone: "muted" },
];

/**
 * Trials (spec §3.5): every workspace on a free trial, the ones about to end first, and what the last
 * six months of new workspaces went on to become. Viewing is open to all staff; extending a trial is
 * for the staff who sell, keeping a trial's plan free for managers (the table draws only those).
 */
export default async function ConsoleTrialsPage({ searchParams }: PageProps<"/platform-console/trials">) {
  const staff = await consoleStaff(PAGE_ROLES.trials);
  const caps = capsFor(staff.role);
  const sp = await searchParams;
  const view = parseTrialView(sp);
  const [board, cohorts] = await Promise.all([trialsBoard(), trialCohorts(COHORT_MONTHS)]);
  const rows = trialRowsFor(board, view);
  const c = board.counts;

  const paying = cohorts.reduce((sum, m) => sum + m.paying, 0);
  const decided = cohorts.reduce((sum, m) => sum + Math.max(0, m.started - m.trialing), 0);
  const ending = c["3d"] + c["7d"];
  const viewCounts: Record<TrialView, number> = { ending, later: c.later, grace: c.grace, held: c.held, all: board.rows.length };

  const subtitle = (
    <>
      {`Trials last ${plural(board.trialDays, "day")} · ${plural(board.graceDays, "day")}' grace before a hold`}
      {caps.owner && (
        <>
          {" · "}
          <Link href="/settings#signup" className="font-medium text-brand hover:underline">
            Change trial length
          </Link>
        </>
      )}
    </>
  );

  return (
    <>
      <PageHeader title="Trials" subtitle={subtitle} asOf={board.asOf} />

      <div className="space-y-6">
        <KpiGrid>
          <KpiTile
            label="Active trials"
            value={num(c.active)}
            icon={<Hourglass className="h-4 w-4" />}
            secondary={c.held > 0 ? `${num(c.held)} held after the trial ran out` : "Still running, not yet ended"}
          />
          <KpiTile
            label="Ending within 7 days"
            value={num(ending)}
            icon={<CalendarClock className="h-4 w-4" />}
            href={PATH}
            tone={c["3d"] > 0 ? "warning" : "neutral"}
            secondary={`${num(c["3d"])} within 3 days`}
          />
          <KpiTile
            label="In grace (awaiting hold)"
            value={num(c.grace)}
            icon={<TimerReset className="h-4 w-4" />}
            href={withParams(PATH, {}, { view: "grace" })}
            tone={c.grace > 0 ? "warning" : "neutral"}
            secondary={`Held ${plural(board.graceDays, "day")} after the trial ends`}
          />
          <KpiTile
            label={`Conversion (last ${COHORT_MONTHS} months)`}
            value={percent(paying, decided)}
            icon={<Percent className="h-4 w-4" />}
            secondary={decided > 0 ? `${num(paying)} paying of ${num(decided)} decided` : "No trial has been decided yet"}
          />
        </KpiGrid>

        <section aria-label="Trials">
          <div className="mb-4">
            <ViewTabs
              label="Trial views"
              items={TRIAL_VIEWS.map((key) => ({
                key,
                label: TRIAL_VIEW_LABELS[key],
                href: withParams(PATH, sp, { view: key === "ending" ? null : key }),
                active: view === key,
                count: viewCounts[key],
              }))}
            />
          </div>

          {rows.length > 0 ? (
            <TrialsTable rows={rows} caps={caps} asOf={board.asOf} />
          ) : (
            <Panel padded={false}>
              {board.rows.length === 0 || view === "all" ? (
                <EmptyState
                  icon={<Hourglass className="h-5 w-5" />}
                  title="No workspaces are on a trial."
                  body={`A workspace made by signing up starts a ${board.trialDays}-day trial, and is listed here until it pays.`}
                />
              ) : (
                <EmptyState
                  title={EMPTY_VIEW[view].title}
                  body={EMPTY_VIEW[view].body}
                  action={
                    <Link href={withParams(PATH, {}, { view: "all" })} className="text-[13px] font-medium text-brand hover:underline">
                      Show all trials
                    </Link>
                  }
                />
              )}
            </Panel>
          )}
        </section>

        <div className="grid items-start gap-6 lg:grid-cols-3">
          <div className="min-w-0 lg:col-span-2">
            <OutcomesChart cohorts={cohorts} paying={paying} decided={decided} />
          </div>
          <TrialLifecycle board={board} />
        </div>
      </div>
    </>
  );
}

/** "Apr 2026", "May", "Jun"… — the year only where the run starts or a new one begins. */
function monthTick(key: string, index: number): string {
  const label = monthLabel(key);
  return index === 0 || key.endsWith("-01") ? label : label.slice(0, 3);
}

function OutcomesChart({ cohorts, paying, decided }: { cohorts: TrialCohort[]; paying: number; decided: number }) {
  const started = cohorts.reduce((sum, m) => sum + m.started, 0);
  return (
    <ChartFrame
      title="Trial outcomes by month"
      description={
        started === 0
          ? "Workspaces by the month they were made"
          : `${plural(started, "workspace")} made in ${COHORT_MONTHS} months · ${percent(paying, decided)} of decided trials now pay`
      }
      table={
        started > 0 ? (
          <ChartTable
            columns={["Month", "Made", ...OUTCOMES.map((o) => o.label), "Converted"]}
            rows={cohorts.map((m) => [monthLabel(m.month), m.started, ...OUTCOMES.map((o) => m[o.key]), m.rate === null ? "—" : `${Math.round(m.rate * 100)}%`])}
          />
        ) : undefined
      }
    >
      {started === 0 ? (
        <ChartEmpty>No workspace was made in the last {COHORT_MONTHS} months.</ChartEmpty>
      ) : (
        <StackedColumns
          columns={cohorts.map((m, i) => ({
            key: m.month,
            label: monthTick(m.month, i),
            segments: Object.fromEntries(OUTCOMES.map((o) => [o.key, m[o.key]])),
          }))}
          series={OUTCOMES}
          label="Trial outcomes by the month each workspace was made"
        />
      )}
    </ChartFrame>
  );
}

/** How a trial runs its course, in this installation's numbers — the rules the table's dates follow. */
function TrialLifecycle({ board }: { board: TrialsBoard }) {
  const steps = [
    { term: "Starts", text: `A workspace made by signing up tries its plan free for ${plural(board.trialDays, "day")}.` },
    { term: "Reminders", text: "A reminder is emailed 7, 3 and 1 days before the end." },
    { term: "Grace", text: `Once it ends there are ${plural(board.graceDays, "day")} to start paying.` },
    { term: "Hold", text: "After the grace, billing holds the workspace until it pays or its trial is extended." },
  ];
  return (
    <Panel title="How a trial ends" description="The rules behind the dates above">
      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={step.term} className="flex gap-3">
            <span aria-hidden="true" className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-sunken text-[11px] font-medium text-muted tabular-nums">
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-text">{step.term}</p>
              <p className="text-xs text-muted">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
