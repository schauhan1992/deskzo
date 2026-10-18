/**
 * Short leave by the hour (owner, 18 Oct 2026) — pure, for the actions, the form and the checks alike.
 *
 *   · Up to two hours each, two a month, set company-wide beside the office hours.
 *   · Free within the month's limit; past it the request is refused, with a note to take a half day.
 *   · Asked for before or after the day, as long as the day is in the current month or later.
 *   · The reporting manager approves it, like leave.
 *
 * An approved short leave excuses the day's Late or Left early mark. It changes neither the minutes
 * worked nor loss-of-pay. Times are minutes from midnight on the workspace's clock, like office hours.
 */

import { clockWordsOfMinute, minuteOfTime, type DayTiming, type OfficeHours } from "@/lib/hr/office-hours-rules";

export type ShortLeavePolicy = { maxMinutes: number; perMonth: number };

/** What a workspace that has never set its own rules gets: two hours, twice a month. */
export const DEFAULT_SHORT_LEAVE_POLICY: ShortLeavePolicy = { maxMinutes: 120, perMonth: 2 };

/** The shortest short leave worth asking for. */
export const SHORT_LEAVE_MIN_MINUTES = 15;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** 120 → "2 hours", 90 → "1 hour 30 minutes", 45 → "45 minutes". */
export function durationWords(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h ? `${h} hour${h === 1 ? "" : "s"}` : "";
  const mins = m ? `${m} minute${m === 1 ? "" : "s"}` : "";
  return [hours, mins].filter(Boolean).join(" ") || "0 minutes";
}

/** The rules as HR typed them, or why they can't be kept. The database checks the same bounds. */
export function policyOrRefusal(input: { maxMinutes: unknown; perMonth: unknown }): { ok: true; policy: ShortLeavePolicy } | { ok: false; error: string } {
  const maxMinutes = Number(input.maxMinutes);
  const perMonth = Number(input.perMonth);
  if (!Number.isInteger(maxMinutes) || maxMinutes < SHORT_LEAVE_MIN_MINUTES || maxMinutes > 480) {
    return { ok: false, error: "A short leave can be from 15 minutes to 8 hours long." };
  }
  if (!Number.isInteger(perMonth) || perMonth < 0 || perMonth > 31) {
    return { ok: false, error: "Short leaves a month is a whole number, from 0 to 31." };
  }
  return { ok: true, policy: { maxMinutes, perMonth } };
}

export type ShortLeaveDraft = { date: string; from: string; to: string; reason: string };
export type ParsedShortLeave = { date: string; fromMinute: number; toMinute: number; reason: string };

/**
 * The form's own checks: a real day in this month or later, a span inside the limit and the office
 * hours, and a reason. `today` is the workspace's day as "yyyy-mm-dd".
 */
export function draftOrRefusal(
  draft: ShortLeaveDraft,
  ctx: { today: string; policy: ShortLeavePolicy; hours: OfficeHours | null },
): { ok: true; value: ParsedShortLeave } | { ok: false; error: string } {
  if (ctx.policy.perMonth === 0) return { ok: false, error: "Your company doesn't offer short leave — apply for a half day instead." };

  const date = String(draft.date ?? "").trim();
  const real = /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  if (!real) return { ok: false, error: "Pick the day." };
  // Before or after the day, but never for a month that has closed (owner, 18 Oct 2026).
  if (date.slice(0, 7) < ctx.today.slice(0, 7)) {
    return { ok: false, error: "That day is in a past month — short leave can only be asked for this month or later." };
  }

  const fromMinute = minuteOfTime(String(draft.from ?? ""));
  const toMinute = minuteOfTime(String(draft.to ?? ""));
  if (fromMinute === null || toMinute === null) return { ok: false, error: "Give the times, like 09:30 and 11:00." };
  if (toMinute <= fromMinute) return { ok: false, error: "It has to end after it starts." };
  const length = toMinute - fromMinute;
  if (length < SHORT_LEAVE_MIN_MINUTES) return { ok: false, error: `A short leave is at least ${SHORT_LEAVE_MIN_MINUTES} minutes.` };
  if (length > ctx.policy.maxMinutes) {
    return { ok: false, error: `A short leave is at most ${durationWords(ctx.policy.maxMinutes)} — for longer, apply for a half day.` };
  }
  if (ctx.hours && (fromMinute < ctx.hours.startMinute || toMinute > ctx.hours.endMinute)) {
    return {
      ok: false,
      error: `Keep it inside office hours, ${clockWordsOfMinute(ctx.hours.startMinute)} to ${clockWordsOfMinute(ctx.hours.endMinute)}.`,
    };
  }

  const reason = String(draft.reason ?? "").trim();
  if (reason.length < 3) return { ok: false, error: "Say why — your manager has to decide on something." };
  if (reason.length > 500) return { ok: false, error: "Keep the reason under 500 characters." };
  return { ok: true, value: { date, fromMinute, toMinute, reason } };
}

/**
 * The checks that need the database's answers: the day itself, and the month's count. `usedInMonth`
 * counts pending and approved short leaves in the day's month — pending ones too, or two asked for at
 * once would both pass.
 */
export function limitsRefusal(ctx: {
  date: string;
  today: string;
  perMonth: number;
  offDay: "week off" | "holiday" | null;
  onLeave: boolean;
  sameDay: boolean;
  usedInMonth: number;
}): string | null {
  if (ctx.offDay) return `That day is a ${ctx.offDay} — there's nothing to excuse.`;
  if (ctx.onLeave) return "You already have leave that day.";
  if (ctx.sameDay) return "You already have a short leave that day.";
  if (ctx.usedInMonth >= ctx.perMonth) {
    const which = ctx.date.slice(0, 7) === ctx.today.slice(0, 7) ? "this month's" : `${MONTHS[Number(ctx.date.slice(5, 7)) - 1]}'s`;
    return `You've had ${which} ${ctx.perMonth} short leave${ctx.perMonth === 1 ? "" : "s"} — apply for a half day instead.`;
  }
  return null;
}

export type ShortLeaveSpan = { fromMinute: number; toMinute: number };

/** "9:30 am – 11:00 am". */
export const spanWords = (span: ShortLeaveSpan) => `${clockWordsOfMinute(span.fromMinute)} – ${clockWordsOfMinute(span.toMinute)}`;

/**
 * Whether an approved short leave covers a late clock-in: it starts by the office start (plus the
 * grace), and runs to within the grace of when they came in.
 */
export function excusesLate(span: ShortLeaveSpan, inMinute: number, hours: OfficeHours): boolean {
  return span.fromMinute <= hours.startMinute + hours.graceMinutes && span.toMinute + hours.graceMinutes >= inMinute;
}

/** Whether it covers an early clock-out: it runs to the office end (less the grace), from within the grace of when they left. */
export function excusesEarly(span: ShortLeaveSpan, outMinute: number, hours: OfficeHours): boolean {
  return span.toMinute >= hours.endMinute - hours.graceMinutes && span.fromMinute - hours.graceMinutes <= outMinute;
}

/**
 * A day's timing once its short leave is counted: an approved one clears the Late or Left early mark
 * it covers; a pending one clears nothing. `excused` says whether it cleared anything.
 */
export function timingWithShortLeave(
  timing: DayTiming,
  day: { checkInAt: Date | string | null; checkOutAt: Date | string | null },
  leave: (ShortLeaveSpan & { approved: boolean }) | null,
  hours: OfficeHours | null,
  minuteOf: (at: Date) => number,
): DayTiming & { excused: boolean } {
  if (!leave || !leave.approved || !hours) return { ...timing, excused: false };
  const late = timing.late && day.checkInAt ? !excusesLate(leave, minuteOf(new Date(day.checkInAt)), hours) : timing.late;
  const early = timing.early && day.checkOutAt ? !excusesEarly(leave, minuteOf(new Date(day.checkOutAt)), hours) : timing.early;
  return { late, early, overtime: timing.overtime, excused: late !== timing.late || early !== timing.early };
}
