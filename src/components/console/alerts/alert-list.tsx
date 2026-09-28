import type { ReactNode } from "react";
import Link from "next/link";
import { BellOff, CircleAlert, Info, MessageSquareText, TriangleAlert } from "lucide-react";
import { AlertActions } from "@/components/console/alerts/alert-actions";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill, TONE_DOT } from "@/components/console/kit/status";
import { dayMonth, istDaysBetween, plural } from "@/lib/console-shared/format";
import { ALERT_CATEGORY_LABELS, ALERT_SEVERITY } from "@/lib/console-shared/labels";
import type { AlertSeverity } from "@/lib/console-shared/params";
import type { Caps } from "@/lib/console-shared/roles";
import { formatIstTime } from "@/lib/india-time";
import type { Alert } from "@/lib/platform/alerts";
import { cn } from "@/lib/utils";

/**
 * The Alerts page's list (spec §3.2): cards grouped by severity — critical, warning, info — and, when
 * the page asks for them (`?acked=1`), the acknowledged and snoozed ones in a group of their own with
 * who handled each and until when. Every alert says what is wrong, where (the workspace), since when,
 * and links to the page that fixes it; staff who change things also get acknowledge and snooze.
 *
 * `alerts` arrives filtered and sorted by the loader (severity, standing conditions, newest). `asOf` is
 * the loader's clock, so "until 6:30 pm tomorrow" never depends on the reader's.
 */

const SEVERITIES: AlertSeverity[] = ["critical", "warning", "info"];
const ICON = { critical: CircleAlert, warning: TriangleAlert, info: Info } as const;
const CHIP: Record<AlertSeverity, string> = {
  critical: "bg-danger-bg text-danger",
  warning: "bg-warning-bg text-warning",
  info: "bg-info-bg text-info",
};

const REVIEW =
  "inline-flex h-8 shrink-0 items-center rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium whitespace-nowrap text-text shadow-sm hover:bg-surface-sunken";

/** "6:30 pm today", "9:00 am tomorrow", "3 Oct, 9:00 am" — counted in India's days from the loader's clock. */
function untilText(until: Date, asOf: Date): string {
  const days = istDaysBetween(asOf, until);
  const time = formatIstTime(until);
  if (days === 0) return `${time} today`;
  if (days === 1) return `${time} tomorrow`;
  return `${dayMonth(until)}, ${time}`;
}

export function AlertList({ alerts, caps, asOf }: { alerts: Alert[]; caps: Caps; asOf: Date }) {
  const open = alerts.filter((a) => a.ack === null);
  const handled = alerts.filter((a) => a.ack !== null);

  return (
    <div className="space-y-6">
      {SEVERITIES.map((severity) => {
        const group = open.filter((a) => a.severity === severity);
        if (group.length === 0) return null;
        const label = ALERT_SEVERITY[severity];
        return (
          <AlertGroup
            key={severity}
            id={`alerts-${severity}`}
            title={
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", TONE_DOT[label.tone])} />
                {label.label}
              </span>
            }
            count={group.length}
          >
            {group.map((alert) => (
              <AlertRow key={alert.key} alert={alert} caps={caps} asOf={asOf} />
            ))}
          </AlertGroup>
        );
      })}

      {handled.length > 0 && (
        <AlertGroup
          id="alerts-handled"
          title={
            <span className="inline-flex items-center gap-2">
              <BellOff aria-hidden="true" className="h-4 w-4 text-subtle" />
              Acknowledged and snoozed
            </span>
          }
          description="Off the open list until a snooze runs out, or somebody reopens it."
          count={handled.length}
        >
          {handled.map((alert) => (
            <AlertRow key={alert.key} alert={alert} caps={caps} asOf={asOf} />
          ))}
        </AlertGroup>
      )}
    </div>
  );
}

function AlertGroup({ id, title, description, count, children }: { id: string; title: ReactNode; description?: string; count: number; children: ReactNode }) {
  return (
    <Panel
      id={id}
      title={title}
      description={description}
      padded={false}
      actions={<span className="text-xs text-muted tabular-nums">{plural(count, "alert")}</span>}
    >
      <ul className="divide-y divide-line">{children}</ul>
    </Panel>
  );
}

function AlertRow({ alert, caps, asOf }: { alert: Alert; caps: Caps; asOf: Date }) {
  const Icon = ICON[alert.severity] ?? Info;
  const severity = ALERT_SEVERITY[alert.severity] ?? ALERT_SEVERITY.info;
  const ack = alert.ack;
  const category = ALERT_CATEGORY_LABELS[alert.category] ?? alert.category;

  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 gap-3">
        <span
          aria-hidden="true"
          className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg", ack ? "bg-surface-sunken text-subtle" : (CHIP[alert.severity] ?? CHIP.info))}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-medium break-words text-text">
              {/* The group heading says the severity to the eye; this says it to a screen reader, row by row. */}
              {!ack && <span className="sr-only">{`${severity.label}: `}</span>}
              {alert.title}
            </p>
            {ack && <StatusPill tone={severity.tone}>{severity.label}</StatusPill>}
          </div>
          {alert.detail && <p className="mt-1 text-[13px] break-words text-muted">{alert.detail}</p>}

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-subtle">
            {alert.tenant && (
              <Link
                href={`/workspaces/${encodeURIComponent(alert.tenant.slug)}`}
                title={alert.tenant.name}
                className="inline-flex h-5 max-w-56 items-center rounded-full border border-line bg-surface-sunken px-2 font-mono text-[11px] text-muted hover:text-text"
              >
                <span className="truncate">{alert.tenant.slug}</span>
              </Link>
            )}
            <span>{category}</span>
            {alert.since && (
              <>
                <span aria-hidden="true">·</span>
                <RelativeTime at={alert.since} />
              </>
            )}
            {!alert.instance && (
              <>
                <span aria-hidden="true">·</span>
                <span>Clears when fixed</span>
              </>
            )}
          </div>

          {ack && (
            <div className="mt-3 space-y-1 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-xs text-muted">
              <p>
                {ack.snoozeUntil ? (
                  `Snoozed by ${ack.byName} until ${untilText(ack.snoozeUntil, asOf)}`
                ) : (
                  <>
                    {`Acknowledged by ${ack.byName} · `}
                    <RelativeTime at={ack.at} />
                  </>
                )}
              </p>
              {ack.note && (
                <p className="flex items-start gap-1.5 break-words text-text">
                  <MessageSquareText aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
                  <span>
                    <span className="sr-only">Note: </span>
                    {ack.note}
                  </span>
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1 pl-11 sm:justify-end sm:pl-0">
        {caps.ackAlerts && <AlertActions alertKey={alert.key} instance={alert.instance} acked={ack !== null} title={alert.title} />}
        <Link href={alert.href} className={cn(REVIEW, caps.ackAlerts && "ml-1")}>
          Review<span className="sr-only">{`: ${alert.title}`}</span>
        </Link>
      </div>
    </li>
  );
}
