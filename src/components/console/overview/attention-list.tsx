import Link from "next/link";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { plural } from "@/lib/console-shared/format";
import { ALERT_CATEGORY_LABELS, ALERT_SEVERITY } from "@/lib/console-shared/labels";
import type { AlertSeverity } from "@/lib/console-shared/params";
import type { Alert, AlertList } from "@/lib/platform/alerts";
import { cn } from "@/lib/utils";

/** How many alerts the Overview lists; the rest are one link away. */
const SHOWN = 5;
const SEVERITIES: AlertSeverity[] = ["critical", "warning", "info"];

const ICON = { critical: CircleAlert, warning: TriangleAlert, info: Info } as const;
const CHIP: Record<AlertSeverity, string> = {
  critical: "bg-danger-bg text-danger",
  warning: "bg-warning-bg text-warning",
  info: "bg-info-bg text-info",
};

/**
 * "Needs attention": the most urgent open alerts (the loader already sorts them — severity, then
 * standing conditions, then newest), each with the one link that goes to its fix. The page's first
 * question is "is anything broken?", so an empty list says so in words rather than showing nothing.
 *
 * `alerts` may be the whole open list; only the first five are drawn. `total` is every open alert
 * (the list itself is capped), and `counts`, when given, splits it by severity for the header.
 */
export function AttentionList({ alerts, total, counts }: { alerts: Alert[]; total: number; counts?: AlertList["counts"] }) {
  const shown = alerts.slice(0, SHOWN);
  // Nothing to describe when the body already says "All clear".
  const description =
    total === 0 ? undefined : total > shown.length ? `The ${shown.length} most urgent of ${plural(total, "open alert")}` : `${plural(total, "open alert")}, most urgent first`;
  const pills = counts ? SEVERITIES.filter((s) => counts[s] > 0).map((s) => ({ severity: s, n: counts[s] })) : [];

  return (
    <Panel
      title="Needs attention"
      description={description}
      padded={false}
      actions={
        pills.length > 0 ? (
          <>
            {pills.map(({ severity, n }) => (
              <StatusPill key={severity} tone={ALERT_SEVERITY[severity].tone} dot>
                {`${n} ${ALERT_SEVERITY[severity].label.toLowerCase()}`}
              </StatusPill>
            ))}
          </>
        ) : undefined
      }
      footer={
        total > 0 ? (
          <Link href="/alerts" className="font-medium text-brand hover:underline">
            {`View all ${plural(total, "alert")}`}
            <span aria-hidden="true"> →</span>
          </Link>
        ) : undefined
      }
    >
      {shown.length === 0 ? (
        <div className="flex items-center gap-3 px-5 py-4">
          <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-success-bg text-success">
            <CircleCheck className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-text">All clear — nothing needs attention</p>
            <p className="mt-0.5 text-xs text-muted">This page checks again every minute while it is open.</p>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((alert) => (
            <AttentionRow key={alert.key} alert={alert} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function AttentionRow({ alert }: { alert: Alert }) {
  const Icon = ICON[alert.severity] ?? Info;
  const severity = ALERT_SEVERITY[alert.severity] ?? ALERT_SEVERITY.info;
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span aria-hidden="true" className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg", CHIP[alert.severity] ?? CHIP.info)}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium break-words text-text">
          <span className="sr-only">{`${severity.label}: `}</span>
          {alert.title}
        </p>
        {alert.detail && <p className="mt-0.5 line-clamp-2 text-xs break-words text-muted">{alert.detail}</p>}
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-subtle">
          <span>{ALERT_CATEGORY_LABELS[alert.category] ?? alert.category}</span>
          {alert.since && (
            <>
              <span aria-hidden="true">·</span>
              <RelativeTime at={alert.since} />
            </>
          )}
        </p>
      </div>
      <Link
        href={alert.href}
        className="inline-flex h-7 shrink-0 items-center rounded-base border border-line-strong bg-surface px-2.5 text-xs font-medium text-text shadow-sm hover:bg-surface-sunken"
      >
        Review<span className="sr-only">{`: ${alert.title}`}</span>
      </Link>
    </li>
  );
}
