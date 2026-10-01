import type { FollowUpChannel, PromiseStatus } from "@prisma/client";
import { istCalendarDate, istMidnight } from "@/lib/india-time";

/**
 * Collections' rules, without a database: what a follow-up may say, when a promise to pay is due or
 * broken, and whether the money that came in kept it.
 *
 * Pure and dependency-light, so the dialog, the page, the actions, the daily job and `check:collections`
 * all read the same answers. Every date here is an Indian calendar day held the way a `@db.Date` column
 * holds one — midnight UTC of that day (`istCalendarDate`) — and days are compared as whole days.
 */

const DAY = 86_400_000;

export const FOLLOW_UP_CHANNELS = ["CALL", "WHATSAPP", "EMAIL", "VISIT", "MEETING", "OTHER"] as const satisfies readonly FollowUpChannel[];

export const followUpChannelLabels: Record<FollowUpChannel, string> = {
  CALL: "Call",
  WHATSAPP: "WhatsApp",
  EMAIL: "Email",
  VISIT: "Visit",
  MEETING: "Meeting",
  OTHER: "Other",
};

export const promiseStatusLabels: Record<PromiseStatus, string> = {
  OPEN: "Promised",
  KEPT: "Kept",
  BROKEN: "Broken",
  SUPERSEDED: "Replaced",
};

/** Remarks are what the client said — required, and at most this long (the table's CHECK agrees). */
export const REMARKS_MAX = 1000;

/** "No follow-up in 14 days": a due nobody has chased for this long is the one to pick up. */
export const STALE_DAYS = 14;

/** How far ahead a promised or next follow-up date may be set — anything further is a slipped year. */
export const MAX_DAYS_AHEAD = 366;

/** Today in India, as a date column holds it. */
export function istToday(now: Date = new Date()): Date {
  return istCalendarDate(now);
}

/** `yyyy-mm-dd` of a date-column value (midnight UTC of its day). */
export function dayKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, both calendar days (midnight UTC). */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY);
}

/** A calendar day `n` days after another. */
export function addDays(day: Date, n: number): Date {
  return new Date(day.getTime() + n * DAY);
}

/** The instant a calendar day (a date-column value) ends in India: midnight IST starting the next. */
export function endOfIstDay(day: Date): Date {
  return istMidnight(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
}

/**
 * A promised or next-follow-up date as typed (`yyyy-mm-dd`): a real day, today or later in India, and
 * within a year. Today is allowed — "they'll pay this evening" is a promise.
 */
export function checkFutureDay(
  value: string,
  now: Date,
  what: string,
): { ok: true; day: Date } | { ok: false; error: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return { ok: false, error: `Pick the ${what}.` };
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const day = new Date(Date.UTC(y, m - 1, d));
  // 31 February is not a day; Date.UTC would make it 3 March.
  if (Number.isNaN(day.getTime()) || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) {
    return { ok: false, error: `That ${what} isn't a date.` };
  }
  const ahead = daysBetween(istToday(now), day);
  if (ahead < 0) return { ok: false, error: `The ${what} can't be in the past — today in India is the earliest.` };
  if (ahead > MAX_DAYS_AHEAD) return { ok: false, error: `The ${what} is more than a year away.` };
  return { ok: true, day };
}

/** "15 Oct" — a promised day, short. Read as the calendar day it holds, whatever the reader's zone. */
export function shortDay(day: Date | string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(day));
}

/** "15 Oct 2026". */
export function longDay(day: Date | string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(day));
}

export type PromiseTone = "amber" | "red" | "green" | "default";
export type PromiseState = { state: "due" | "broken" | "kept" | "replaced"; tone: PromiseTone; text: string };

/**
 * How a promise reads today — always in words as well as a colour.
 *
 * An OPEN promise whose day has passed reads as broken before the daily job has got to it: it is, and
 * the job's only remaining question is whether money recorded late was received in time.
 */
export function promiseState(p: { promiseStatus: PromiseStatus; promisedOn: Date | string }, now: Date = new Date()): PromiseState {
  const promised = new Date(p.promisedOn);
  const ahead = daysBetween(istToday(now), promised);
  if (p.promiseStatus === "KEPT") return { state: "kept", tone: "green", text: "Kept" };
  if (p.promiseStatus === "SUPERSEDED") return { state: "replaced", tone: "default", text: "Replaced by a later promise" };
  if (p.promiseStatus === "BROKEN" || ahead < 0) {
    const ago = Math.max(-ahead, 1);
    return { state: "broken", tone: "red", text: `Broken ${ago} day${ago === 1 ? "" : "s"} ago` };
  }
  if (ahead === 0) return { state: "due", tone: "amber", text: "Due today" };
  if (ahead === 1) return { state: "due", tone: "amber", text: "Due tomorrow" };
  if (ahead <= 7) return { state: "due", tone: "amber", text: `Due in ${ahead} days` };
  return { state: "due", tone: "default", text: `Due ${shortDay(promised)}` };
}

/** "This week" for promises: today and the six days after it, in India. */
export function weekWindow(now: Date = new Date()): { from: Date; to: Date } {
  const from = istToday(now);
  return { from, to: addDays(from, 6) };
}

export function inWeek(day: Date | string, now: Date = new Date()): boolean {
  const { from, to } = weekWindow(now);
  const t = new Date(day).getTime();
  return t >= from.getTime() && t <= to.getTime();
}

/**
 * One settlement of the thing chased: a payment allocated to it (dated the day the money came in), or
 * a credit note applied (dated when it was applied). `recordedAt` is when it was entered here.
 */
export type SettlementEvent = { amount: number; recordedAt: Date; effectiveAt: Date };

/**
 * Whether a promise was kept.
 *
 * Kept when what was settled against the invoice (or order) **since the promise was logged**, and
 * received **on or before the promised day** (India), comes to the promised amount — or, with no amount
 * promised, to everything that was outstanding when it was logged. A promise of more than was owed is
 * kept by settling it in full. Money recorded late but received in time counts: the client kept their
 * word even if the receipt was entered on the 20th.
 *
 * Only what was entered after the promise counts, because anything entered before it is already in the
 * balance the salesperson was chasing.
 */
export function promiseOutcome(input: {
  loggedAt: Date;
  promisedOn: Date;
  promisedAmount: number | null;
  total: number;
  events: SettlementEvent[];
}): { kept: boolean; needed: number; settledSince: number; outstandingAtPromise: number } {
  const round = (n: number) => Math.round(n * 100) / 100;
  const deadline = endOfIstDay(input.promisedOn).getTime();
  const before = input.events.filter((e) => e.recordedAt.getTime() < input.loggedAt.getTime()).reduce((t, e) => t + e.amount, 0);
  const outstandingAtPromise = round(Math.max(input.total - before, 0));
  const settledSince = round(
    input.events
      .filter((e) => e.recordedAt.getTime() >= input.loggedAt.getTime() && e.effectiveAt.getTime() < deadline)
      .reduce((t, e) => t + e.amount, 0),
  );
  const needed = round(input.promisedAmount !== null ? Math.min(input.promisedAmount, outstandingAtPromise) : outstandingAtPromise);
  const kept = needed <= 0.005 ? outstandingAtPromise <= 0.005 : settledSince >= needed - 0.005;
  return { kept, needed, settledSince, outstandingAtPromise };
}
