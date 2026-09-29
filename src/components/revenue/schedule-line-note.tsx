import Link from "next/link";
import type { ScheduleListRow } from "@/lib/revenue/reports";
import { STATUS_LABELS, periodText } from "@/components/revenue/labels";

/**
 * Under an invoice line whose revenue is deferred: how it is recognised, and a link to its schedule
 * (spec §3.8, "Recognised over <period> — schedule →").
 */
export function ScheduleLineNote({ schedule }: { schedule: Pick<ScheduleListRow, "id" | "kind" | "status" | "startDate" | "endDate"> }) {
  const how =
    schedule.kind === "MILESTONE" && !schedule.startDate
      ? "Recognised when its delivery milestone is done"
      : `Recognised over ${periodText(schedule.startDate, schedule.endDate)}`;
  return (
    <div className="mt-0.5 text-xs text-muted">
      {how}
      {schedule.status !== "ACTIVE" && ` (${STATUS_LABELS[schedule.status].toLowerCase()})`} —{" "}
      <Link href={`/accounting/revenue/${schedule.id}`} className="text-brand hover:underline">
        schedule →
      </Link>
    </div>
  );
}
