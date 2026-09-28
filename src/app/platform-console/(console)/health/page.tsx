import type { Metadata } from "next";
import Link from "next/link";
import { CheckGrid } from "@/components/console/health/check-grid";
import { FailingJobsTable } from "@/components/console/health/failing-jobs";
import { LeasesTable } from "@/components/console/health/leases-table";
import { Banner } from "@/components/console/kit/banner";
import { PageHeader } from "@/components/console/kit/page-header";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { durationText, plural } from "@/lib/console-shared/format";
import { HEALTH_STATUS } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import { staffNameMap } from "@/lib/platform/console-guard";
import { consoleStaff } from "@/lib/platform/console-page";
import { failingJobsSummary, platformLeases, systemHealth, type HealthCheck, type HealthStatus } from "@/lib/platform/health";
import { lastTick, type TickSummary } from "@/lib/platform/tick-summary";

export const metadata: Metadata = { title: "System health" };

/**
 * The platform's own health board (spec §3.11): whether the scheduled work runs, workspaces get set
 * up, every schema is current, the gateways are wired, the reference data syncs, staff sign-in is as
 * safe as it should be and the environment is complete — then the jobs workspaces run on a schedule,
 * the platform's own leases and what the last platform tick did.
 *
 * Everything is read from what the control plane records; nothing is probed from here, and nothing
 * changes. The billing card is for the staff who sell: for everybody else it is neither shown nor
 * counted in the verdict at the top. Every error text arrives redacted from the loaders.
 */
export default async function ConsoleHealthPage() {
  // First: signed out, the page ends here with a redirect to /login.
  const staff = await consoleStaff(PAGE_ROLES.health);
  const caps = capsFor(staff.role);

  const [health, jobs, leases, tick] = await Promise.all([systemHealth(), failingJobsSummary(), platformLeases(), lastTick()]);
  const startedBy = tick && tick.by !== "tick" ? tick.by : null;
  const tickBy = startedBy ? ((await staffNameMap([startedBy])).get(startedBy) ?? null) : null;

  const checks = caps.viewBilling ? health.checks : health.checks.filter((c) => c.group !== "billing");
  const counts: Record<HealthStatus, number> = { ok: 0, warn: 0, fail: 0, off: 0 };
  for (const check of checks) counts[check.status] += 1;
  const attention = counts.fail + counts.warn;
  const namesOf = (status: HealthStatus) => [...new Set(checks.filter((c) => c.status === status).map((c) => c.label))];

  const failingJobs = jobs.filter((j) => j.workspaces > 0).length;
  const jobsDescription =
    jobs.length === 0
      ? undefined
      : failingJobs > 0
        ? `${plural(failingJobs, "job")} failing in at least one workspace — open one for its last error and the workspaces`
        : "Every job's last run succeeded in every workspace";

  return (
    <>
      <PageHeader title="System health" subtitle="Read from what the platform records — this page runs no probes." asOf={health.asOf} autoRefreshSeconds={60} />

      <div className="space-y-6">
        {attention > 0 ? (
          <Banner
            tone={counts.fail > 0 ? "danger" : "warning"}
            title={`${plural(attention, "check")} ${attention === 1 ? "needs" : "need"} attention`}
            action={
              <Link href="/alerts" className="rounded-base text-sm font-medium underline underline-offset-2">
                Open alerts
              </Link>
            }
          >
            {[counts.fail ? `Failing: ${listed(namesOf("fail"))}.` : null, counts.warn ? `To check: ${listed(namesOf("warn"))}.` : null].filter(Boolean).join(" ")}
          </Banner>
        ) : (
          <Banner tone="success" title="All systems normal">
            {`${plural(counts.ok, "check")} OK${counts.off ? `; ${counts.off.toLocaleString("en-IN")} turned off or not set up` : ""}.`}
          </Banner>
        )}

        <CheckGrid checks={checks} />

        <div className="grid items-start gap-6 lg:grid-cols-3">
          <Panel id="scheduled-jobs" title="Scheduled jobs across workspaces" description={jobsDescription} padded={false} className="lg:col-span-2">
            <FailingJobsTable rows={jobs} />
          </Panel>
          <LastTickPanel tick={tick} by={tickBy} check={checks.find((c) => c.key === "tick") ?? null} showRevenue={caps.viewBilling} />
        </div>

        {/* Full width: six columns of times and holders scroll sideways in anything narrower. */}
        <Panel id="platform-leases" title="Platform leases" description="The platform's own jobs: which process holds each, and how its last run ended" padded={false}>
          <LeasesTable rows={leases} />
        </Panel>
      </div>
    </>
  );
}

/** "Platform tick, Webhooks and 3 more". */
function listed(labels: string[], max = 5): string {
  const shown = labels.slice(0, max).join(", ");
  return labels.length > max ? `${shown} and ${labels.length - max} more` : shown;
}

const SLUG_CHIP = "inline-flex h-5 max-w-full items-center rounded-full border border-line bg-surface-sunken px-2 font-mono text-[11px] text-muted hover:text-text";

/** The tick keeps the first twenty slugs of each list; the audit log has every one. */
function SlugList({ slugs }: { slugs: string[] }) {
  if (slugs.length === 0) return <span className="text-muted">None</span>;
  return (
    <ul className="flex flex-wrap items-center gap-1">
      {slugs.map((slug) => (
        <li key={slug} className="min-w-0">
          <Link href={`/workspaces/${encodeURIComponent(slug)}`} className={SLUG_CHIP}>
            <span className="truncate">{slug}</span>
          </Link>
        </li>
      ))}
      {slugs.length >= 20 && (
        <li className="text-[11px] text-subtle">
          and perhaps more —{" "}
          <Link href="/audit" className="text-brand hover:underline">
            the audit log
          </Link>{" "}
          has every one
        </li>
      )}
    </ul>
  );
}

function LastTickPanel({ tick, by, check, showRevenue }: { tick: TickSummary | null; by: string | null; check: HealthCheck | null; showRevenue: boolean }) {
  const status = check ? (HEALTH_STATUS[check.status] ?? null) : null;
  const daily = tick?.daily ?? null;
  return (
    <Panel
      id="last-tick"
      title="Last platform tick"
      description="What the hourly run did the last time it finished"
      actions={
        status ? (
          <StatusPill tone={status.tone} dot>
            {status.label}
          </StatusPill>
        ) : undefined
      }
      footer="The first run of each Indian day also does the daily chores."
    >
      {tick ? (
        <DefinitionList
          items={[
            { term: "Finished", value: <RelativeTime at={tick.at} /> },
            { term: "Took", value: durationText(tick.ms) },
            { term: "Started by", value: tick.by === "tick" ? "The scheduler" : `${by ?? "A staff member"}, from the console`, wide: true },
            { term: "Workspaces held", value: <SlugList slugs={tick.held} />, wide: true },
            { term: "Holds lifted", value: <SlugList slugs={tick.lifted} />, wide: true },
            { term: "Workspaces closed", value: <SlugList slugs={tick.closed} />, wide: true },
            { term: "Reminders sent", value: tick.reminded.toLocaleString("en-IN") },
            {
              term: "Daily chores",
              wide: true,
              value: daily ? (
                <>
                  {[
                    `${plural(daily.reconciled, "subscription")} read back from the gateways`,
                    plural(daily.usage, "usage snapshot"),
                    showRevenue ? plural(daily.revenue, "revenue snapshot") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  {daily.failed > 0 && <span className="text-danger">{` · ${daily.failed.toLocaleString("en-IN")} failed`}</span>}
                </>
              ) : (
                <span className="text-muted">Not on this run</span>
              ),
            },
          ]}
        />
      ) : (
        <p className="text-sm text-muted">No run recorded yet. The scheduler should call /api/platform/tick every hour.</p>
      )}
    </Panel>
  );
}
