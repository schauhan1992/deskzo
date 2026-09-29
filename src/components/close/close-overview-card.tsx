import Link from "next/link";
import { Clock, ListChecks, Lock } from "lucide-react";
import type { closeOverview } from "@/actions/close";
import { Card } from "@/components/ui/card";
import { dayShort } from "@/components/close/format";

type Overview = NonNullable<Awaited<ReturnType<typeof closeOverview>>>;

/**
 * The Accounting overview's line about last month's close: "September close: 9 of 14 · due 3 Oct".
 * Read-only — it never makes a checklist; one that hasn't been opened says so.
 */
export function CloseOverviewCard({ overview }: { overview: Overview }) {
  const { progress } = overview;
  const finished = progress.done + progress.notApplicable;
  const href = `/accounting/close?month=${overview.month}`;
  const closed = overview.status === "CLOSED";
  return (
    <Card className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm text-muted">
      {closed ? <Lock className="h-3.5 w-3.5 text-success" aria-hidden /> : <ListChecks className="h-3.5 w-3.5 text-brand" aria-hidden />}
      <span>
        <span className="font-medium text-text">{overview.name} close:</span>{" "}
        {closed
          ? `closed · ${finished} of ${progress.total}`
          : !overview.started
            ? "not started yet"
            : `${finished} of ${progress.total}${progress.nextDue ? ` · due ${dayShort(progress.nextDue)}` : ""}`}
      </span>
      {!closed && progress.overdue > 0 && (
        <span className="inline-flex items-center gap-1 font-medium text-warning">
          <Clock className="h-3.5 w-3.5" aria-hidden />
          {progress.overdue} overdue
        </span>
      )}
      <Link href={href} className="ml-auto text-brand hover:underline">
        {closed ? "View" : overview.started ? "Open the checklist" : "Start it"}
      </Link>
    </Card>
  );
}
