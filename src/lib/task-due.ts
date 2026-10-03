import { formatCalendarDay, type Clock } from "@/lib/time/zone";

/**
 * A task's due, which is one of two things: a day picked on the form, held as midnight UTC (`createTask`),
 * or the moment a callback was promised for (src/actions/call.ts). Exactly midnight UTC is the first —
 * shown as that day, whatever the zone; anything else is a moment, shown on the workspace's clock.
 * `key` is the day it falls on (`yyyy-mm-dd`), to compare with `clock.today()`. Pure: the task list, the
 * tool rail and HR's checklist all ask it.
 */
export function taskDue(at: Date | string, clock: Clock): { key: string; label: string } {
  const due = new Date(at);
  if (due.getTime() % 86_400_000 === 0) return { key: due.toISOString().slice(0, 10), label: formatCalendarDay(due) };
  return { key: clock.dateKey(due), label: clock.dateTimeShort(due) };
}
