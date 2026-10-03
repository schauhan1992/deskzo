import { CalendarX } from "lucide-react";
import type { HandoverEntry } from "@/actions/handover";
import { HandoverHistory } from "@/components/people/handover-history";
import { formatCalendarDay } from "@/lib/time/zone";

/**
 * What has moved on or off somebody's plate, on their own page.
 *
 * The same card that sits on their full record, with the reason for looking at it stated above.
 * Two people need this and neither of them is HR:
 *
 * The person leaving, during their notice period, because "what am I no longer responsible for,
 * and who has it" is the question they spend that month asking. Until now the only place that was
 * answered was a record they would not think to open about themselves.
 *
 * And whoever inherited the work, because forty accounts appearing overnight with no explanation is
 * how a handover becomes a fortnight of nothing happening.
 *
 * Absent entirely when there is nothing to show. A permanently empty "Handovers" card on every
 * employee's page is the kind of thing people learn to scroll past, and then miss on the one day it
 * has something in it.
 */
export function MyHandover({
  entries,
  userId,
  name,
  exitedOn,
}: {
  entries: HandoverEntry[];
  userId: string;
  name: string;
  exitedOn: Date | string | null;
}) {
  if (entries.length === 0) return null;

  // A `@db.Date` — the day itself, whatever zone the reader is in.
  const leaving = exitedOn ? formatCalendarDay(exitedOn) : null;
  const gave = entries.some((e) => e.direction === "given");

  return (
    <div className="space-y-2">
      {leaving && gave && (
        <div className="flex flex-wrap items-center gap-2 rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
          <CalendarX className="h-4 w-4 shrink-0" aria-hidden />
          <span>
            Your last working day is {leaving}. This is what has been handed on so far — anything
            still on your name is still yours.
          </span>
        </div>
      )}
      <HandoverHistory entries={entries} personId={userId} personName={name} canHandOver={false} />
    </div>
  );
}
