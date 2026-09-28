import type { ReactNode } from "react";
import Link from "next/link";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusDot, StatusPill } from "@/components/console/kit/status";
import { dayKeyLabel, durationText, plural } from "@/lib/console-shared/format";
import { SYNC_STATUS, grantLabel } from "@/lib/console-shared/labels";
import type { Tone } from "@/lib/console-shared/types";
import type { OverviewData } from "@/lib/platform/console-data";
import { HEALTH_LIMITS } from "@/lib/platform/health";
import type { TickSummary } from "@/lib/platform/tick-summary";

/**
 * The Overview's right-hand column: who has let staff into their workspace right now, and whether the
 * platform's own scheduled work is running. Server components; every time is a `RelativeTime`, so the
 * server prints the exact IST time and the browser turns it into "12 min ago".
 */

const LINK = "font-medium text-brand hover:underline";
/** Grants listed before the rest are left to the workspace list. */
const GRANTS_SHOWN = 8;

export function LiveGrantsPanel({ grants }: { grants: OverviewData["liveGrants"] }) {
  const shown = grants.slice(0, GRANTS_SHOWN);
  const more = grants.length - shown.length;
  return (
    <Panel
      id="support-access"
      title="Support access live"
      description="Workspaces whose super admin has let staff in"
      padded={false}
      footer={
        more > 0 ? (
          <Link href="/workspaces?grant=live" className={LINK}>
            {`All ${plural(grants.length, "workspace")} with access`}
            <span aria-hidden="true"> →</span>
          </Link>
        ) : undefined
      }
    >
      {shown.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-muted">No workspace has granted access.</p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((grant) => {
            const level = grantLabel("live", grant.level);
            return (
              <li key={grant.tenantId} className="flex items-start justify-between gap-3 px-5 py-2.5">
                <div className="min-w-0">
                  <Link href={`/workspaces/${encodeURIComponent(grant.slug)}?tab=support`} className="font-mono text-xs font-medium break-all text-text hover:text-brand">
                    {grant.slug}
                  </Link>
                  <p className="mt-0.5 truncate text-[11px] text-subtle" title={`${grant.name} · granted by ${grant.grantedByName}`}>
                    {`${grant.name} · by ${grant.grantedByName}`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusPill tone={level.tone}>{level.label}</StatusPill>
                  <span className="text-[11px] whitespace-nowrap text-subtle">
                    ends <RelativeTime at={grant.expiresAt} />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** The platform tick as the Overview reports it: the lines the System health board and the alerts draw. */
export type TickHealth = { label: string; tone: "neutral" | "success" | "info" | "warning" | "danger"; lastAt: Date | null };

/**
 * Worked out from the loader's `asOf`, never the reader's clock. A failed last run outranks lateness
 * (it names the cause); a run in progress outranks both.
 */
export function tickHealth(tick: OverviewData["tick"], asOf: Date): TickHealth {
  const lastAt = tick.lastFinishedAt;
  if (tick.runningNow) return { label: "Running", tone: "info", lastAt };
  if (!lastAt) return { label: "Never run", tone: "neutral", lastAt };
  if (tick.lastOk === false) return { label: "Failed", tone: "danger", lastAt };
  const age = asOf.getTime() - lastAt.getTime();
  if (age > HEALTH_LIMITS.tickStaleMs) return { label: "Stale", tone: "danger", lastAt };
  if (age > HEALTH_LIMITS.tickLateMs) return { label: "Late", tone: "warning", lastAt };
  return { label: "OK", tone: "success", lastAt };
}

type Row = { key: string; title: string; status: { label: string; tone: Tone }; line: ReactNode; detail?: ReactNode; problem?: string | null };

/** "20+ held": the tick keeps the first twenty slugs of each list, so twenty may mean more. */
const capped = (list: string[], word: string) => (list.length ? `${list.length}${list.length >= 20 ? "+" : ""} ${word}` : null);

function tickRow(data: OverviewData, summary: TickSummary | null): Row {
  const health = tickHealth(data.tick, data.asOf);
  const lastAt = health.lastAt;
  let line: ReactNode;
  if (data.tick.runningNow) line = data.tick.lastStartedAt ? <>Running now · started <RelativeTime at={data.tick.lastStartedAt} /></> : "Running now";
  else if (!lastAt) line = "Has not finished a run yet";
  else if (health.label === "Failed") line = <>Last run failed · <RelativeTime at={lastAt} /></>;
  else if (health.label === "OK") line = <>Last ran <RelativeTime at={lastAt} /></>;
  // Late or stale: the word is the news, so it leads.
  else line = <>{`${health.label} — last ran `}<RelativeTime at={lastAt} /></>;

  let detail: ReactNode = null;
  if (summary) {
    const did = [capped(summary.held, "held"), capped(summary.lifted, "lifted"), capped(summary.closed, "closed"), summary.reminded ? plural(summary.reminded, "reminder") + " sent" : null].filter(
      (part): part is string => part !== null,
    );
    const parts = [did.length ? did.join(" · ") : "Changed no workspace", `took ${durationText(summary.ms)}`];
    if (summary.by !== "tick") parts.push("started from the console");
    detail = `Last recorded run: ${parts.join(" · ")}`;
  }
  return { key: "tick", title: "Platform tick", status: { label: health.label, tone: health.tone }, line, detail, problem: health.label === "Failed" ? data.tick.lastError : null };
}

/** Whole days from one `yyyy-mm-dd` key to another, or null for a malformed one. */
function keyDays(from: string, to: string): number | null {
  const utc = (key: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const [a, b] = [utc(from), utc(to)];
  return a === null || b === null ? null : Math.round((b - a) / 86_400_000);
}

function dailyRow(data: OverviewData, summary: TickSummary | null): Row {
  const ranOn = data.dailyRanOn;
  const days = ranOn ? keyDays(ranOn, data.todayKey) : null;
  let status: Row["status"];
  let line: string;
  if (!ranOn || days === null) {
    status = { label: "Never run", tone: "neutral" };
    line = "Runs with the first platform tick of each day";
  } else if (days <= 0) {
    status = { label: "OK", tone: "success" };
    line = "Ran today";
  } else if (days === 1) {
    // Normal until today's first tick has been.
    status = { label: "Due today", tone: "neutral" };
    line = "Last ran yesterday · today's run comes with the next tick";
  } else {
    status = { label: "Late", tone: "warning" };
    line = `Late — last ran ${dayKeyLabel(ranOn, false)}`;
  }
  const d = summary?.daily;
  const detail = d
    ? [`${plural(d.reconciled, "subscription")} read back`, plural(d.usage, "usage snapshot"), d.failed ? `${d.failed} failed` : null].filter(Boolean).join(" · ")
    : null;
  return { key: "daily", title: "Daily billing chores", status, line, detail, problem: null };
}

function syncRow(key: string, title: string, sync: OverviewData["reference"]["pin"]): Row {
  if (!sync) return { key, title, status: { label: "Unknown", tone: "warning" }, line: "The reference database could not be read" };
  if (sync.stale) return { key, title, status: SYNC_STATUS.stale, line: "Stuck — a sync has been running far longer than it should" };
  switch (sync.status) {
    case "RUNNING":
      return { key, title, status: SYNC_STATUS.RUNNING, line: "Syncing now" };
    case "SUCCEEDED":
      return { key, title, status: SYNC_STATUS.SUCCEEDED, line: sync.finishedAt ? <>Up to date · synced <RelativeTime at={sync.finishedAt} /></> : "Up to date" };
    case "FAILED":
      return { key, title, status: SYNC_STATUS.FAILED, line: sync.finishedAt ? <>Last sync failed · <RelativeTime at={sync.finishedAt} /></> : "Last sync failed" };
    default:
      return { key, title, status: SYNC_STATUS.never, line: "Never synced" };
  }
}

export function BackgroundWorkPanel({ data, tick }: { data: OverviewData; tick: TickSummary | null }) {
  const rows = [tickRow(data, tick), dailyRow(data, tick), syncRow("pin", "PIN directory sync", data.reference.pin), syncRow("world", "World places sync", data.reference.world)];
  return (
    <Panel
      title="Background work"
      description="The platform's own scheduled jobs"
      padded={false}
      footer={
        <Link href="/health" className={LINK}>
          Open system health<span aria-hidden="true"> →</span>
        </Link>
      }
    >
      <ul className="divide-y divide-line">
        {rows.map((row) => (
          <li key={row.key} className="flex gap-3 px-5 py-3">
            <span className="mt-1.5">
              <StatusDot tone={row.status.tone} label={row.status.label} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text">{row.title}</p>
              <p className="mt-0.5 text-xs text-muted">{row.line}</p>
              {row.detail && <p className="mt-0.5 text-[11px] text-subtle">{row.detail}</p>}
              {row.problem && (
                <p className="mt-1 line-clamp-2 font-mono text-[11px] break-words text-danger" title={row.problem}>
                  {row.problem}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
