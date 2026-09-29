import { Clock, History, Lock } from "lucide-react";
import type { closeMonthHistory, getCloseMonth } from "@/actions/close";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { CloseMonthActions } from "@/components/close/close-month-actions";
import { dayShort, whenLong } from "@/components/close/format";

type CloseMonthView = NonNullable<Awaited<ReturnType<typeof getCloseMonth>>>;
type HistoryRow = Awaited<ReturnType<typeof closeMonthHistory>>[number];

/**
 * The top of the close page: how far the month has got ("9 of 14 done"), when the next task falls due,
 * whether it is closed — and the button that closes or reopens it.
 */
export function CloseMonthSummary({
  view,
  inProgress,
  hardBlockers,
  lockDay,
  previousLockDay,
  laterClosed,
}: {
  view: CloseMonthView;
  /** The month hasn't ended yet. */
  inProgress: boolean;
  hardBlockers: string[];
  lockDay: string;
  previousLockDay: string;
  laterClosed: string[];
}) {
  const { progress } = view;
  const finished = progress.done + progress.notApplicable;
  const percent = progress.total ? Math.round((finished / progress.total) * 100) : 0;
  const closed = view.status === "CLOSED";
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold text-text">
              {view.label}
              {closed ? (
                <Badge tone="green">
                  <Lock className="h-3 w-3" aria-hidden />
                  Closed
                </Badge>
              ) : inProgress ? (
                <Badge tone="blue">In progress</Badge>
              ) : (
                <Badge tone="amber">Open</Badge>
              )}
            </h2>
            <p className="text-sm text-muted">
              <span className="font-medium text-text">
                {finished} of {progress.total} done
              </span>
              {progress.notApplicable > 0 && <span> ({progress.notApplicable} not applicable)</span>}
              {!closed && progress.nextDue && <span> · due {dayShort(progress.nextDue)}</span>}
            </p>
            {!closed && progress.overdue > 0 && (
              <p className="inline-flex items-center gap-1.5 text-sm font-medium text-warning">
                <Clock className="h-3.5 w-3.5" aria-hidden />
                {progress.overdue} task{progress.overdue === 1 ? " is" : "s are"} overdue
              </p>
            )}
          </div>
          <div className="min-w-0 max-w-full">
            <CloseMonthActions
              monthKey={view.month}
              name={view.name}
              label={view.label}
              status={view.status}
              canClose={view.permissions.close}
              canManage={view.permissions.manage}
              openTasks={progress.open}
              hardBlockers={hardBlockers}
              lockDay={lockDay}
              previousLockDay={previousLockDay}
              laterClosed={laterClosed}
            />
          </div>
        </div>

        <div
          role="progressbar"
          aria-label={`${view.label} close progress`}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={finished}
          aria-valuetext={`${finished} of ${progress.total} done`}
          className="h-2 overflow-hidden rounded-full bg-surface-sunken"
        >
          <div className={closed ? "h-full bg-success" : "h-full bg-brand"} style={{ width: `${percent}%` }} />
        </div>

        {(view.closedAt || view.reopenedAt || view.note) && (
          <div className="space-y-0.5 text-xs text-subtle">
            {closed && view.closedAt && (
              <p>
                Closed{view.closedBy ? ` by ${view.closedBy.name}` : ""} on {whenLong(view.closedAt)}.
              </p>
            )}
            {!closed && view.reopenedAt && <p>Reopened on {whenLong(view.reopenedAt)}.</p>}
            {view.note && <p className="whitespace-pre-wrap break-words">{view.note}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The month's history from the audit log: closed, closed with open tasks and why, reopened and why. */
export function CloseMonthHistory({ label, rows }: { label: string; rows: HistoryRow[] }) {
  return (
    <Card>
      <CardHeader className="flex items-center gap-1.5 text-sm font-medium text-text">
        <History className="h-3.5 w-3.5 text-subtle" aria-hidden />
        History
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-subtle">
            {label} has never been closed. Closing it, reopening it, and any reason given, are recorded here.
          </p>
        ) : (
          <ol className="space-y-2">
            {rows.map((row) => (
              <li key={row.id} className="text-sm">
                <p className="break-words text-text">{row.entityLabel}</p>
                <p className="text-xs text-subtle">
                  {row.user?.name ?? "Somebody"} · {whenLong(row.createdAt)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
