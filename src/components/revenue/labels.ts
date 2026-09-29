import type { RevenueScheduleKind, RevenueScheduleStatus } from "@prisma/client";
import { addMonths, dayKeyAt, dayLabel, monthLabel, type DayKey, type MonthKey } from "@/lib/revenue/periods";

/**
 * The words the revenue screens use for a schedule, in one place so the list, the detail, the review
 * queue and the invoice agree. Dependency-free apart from the pure calendar, so client components use
 * it too.
 */

export const KIND_LABELS: Record<RevenueScheduleKind, string> = {
  RATABLE: "Over the period",
  MILESTONE: "On delivery",
};

export const STATUS_LABELS: Record<RevenueScheduleStatus, string> = {
  PENDING_APPROVAL: "Pending approval",
  ACTIVE: "Active",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const STATUS_TONES: Record<RevenueScheduleStatus, "amber" | "blue" | "green" | "default"> = {
  PENDING_APPROVAL: "amber",
  ACTIVE: "blue",
  COMPLETED: "green",
  CANCELLED: "default",
};

export const STATUS_ORDER: RevenueScheduleStatus[] = ["PENDING_APPROVAL", "ACTIVE", "COMPLETED", "CANCELLED"];

/** "1 Jul 2025 – 30 Jun 2026"; a milestone schedule has no dates until its delivery is done. */
export function periodText(start: DayKey | null, end: DayKey | null): string {
  if (start && end) return `${dayLabel(start)} – ${dayLabel(end)}`;
  if (start) return `From ${dayLabel(start)}`;
  return "When delivered";
}

/**
 * "15 Sep 2026": the Indian calendar day an instant falls on. Spelled out here rather than by Intl, whose
 * en-IN writes "Sept" on some runtimes and "Sep" on others — the months must read the same everywhere.
 */
export function istDay(instant: Date | string): string {
  return dayLabel(dayKeyAt(new Date(instant)));
}

/** Months as a picker offers them, newest first: `from` back `count` months. */
export function monthsBack(from: MonthKey, count: number): { value: MonthKey; label: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const month = addMonths(from, -i);
    return { value: month, label: monthLabel(month) };
  });
}

/** Every month from `from` to `to` (oldest first), for a range filter. */
export function monthRange(from: MonthKey, to: MonthKey): { value: MonthKey; label: string }[] {
  const out: { value: MonthKey; label: string }[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push({ value: m, label: monthLabel(m) });
  return out;
}
