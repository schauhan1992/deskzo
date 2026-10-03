import type { TargetMetric, TargetPeriod, TargetScope } from "@prisma/client";

/**
 * What a target means, and how it is doing.
 *
 * Pure, because the arithmetic here is what people argue about. Two things in particular:
 *
 * The *definition* of each metric is written down and shown on the page, because the first argument
 * anybody has about a target is what counts — does a cancelled invoice still count, is it billed or
 * collected, does a lead won last month count this month. Leaving that implicit is how a target
 * becomes a source of resentment rather than direction.
 *
 * And *pace* matters more than progress. "60% achieved" says almost nothing on its own; "60% with a
 * fifth of the month left" and "60% with half the month left" are a crisis and a good week
 * respectively. Everything below is built so the page can say which.
 */

export type MetricUnit = "CURRENCY" | "COUNT" | "MINUTES";

/**
 * Every metric this code can measure. `PURCHASE_SAVINGS` is defined and measured here ahead of the
 * database: it joins Prisma's `TargetMetric` enum in its own migration (see the ORD-HANDOFF report), and
 * until that is applied a target can't be *stored* on it. Once the client is regenerated this union is
 * exactly `TargetMetric`, and nothing here needs to change.
 */
export type MetricKey = TargetMetric | "PURCHASE_SAVINGS";

export type MetricDefinition = {
  key: MetricKey;
  label: string;
  unit: MetricUnit;
  /** Which team this is usually for — used to group the picker, not to restrict it. */
  team: string;
  /** Exactly what is counted, in words. Shown wherever the number is. */
  counts: string;
  /** What is deliberately left out, where that is the contentious part. */
  excludes?: string;
};

export const METRICS: MetricDefinition[] = [
  {
    key: "INVOICED_VALUE",
    label: "Invoiced value",
    unit: "CURRENCY",
    team: "Sales",
    counts:
      "Tax invoices issued in the period where you are the salesperson, less any credit notes raised against that customer in the same period.",
    excludes: "Drafts, cancelled invoices, proformas and quotes — none of those is a sale.",
  },
  {
    key: "COLLECTED_VALUE",
    label: "Collected",
    unit: "CURRENCY",
    team: "Sales",
    counts:
      "Money actually received in the period, against invoices where you are the salesperson — whenever those invoices were raised.",
    excludes: "Invoices still outstanding, however old.",
  },
  {
    key: "ORDER_VALUE",
    label: "Order value",
    unit: "CURRENCY",
    team: "Sales",
    counts:
      "Orders you punched, at the selling price, once they are past approval — counted on the day they were booked: when punched, or for an in-hand order, its first payment or the day it went to purchase.",
    excludes: "Orders still awaiting approval, cancelled ones, and in-hand orders with no payment that sales hasn't sent to purchase yet.",
  },
  {
    key: "ORDER_MARGIN",
    label: "Order margin",
    unit: "CURRENCY",
    team: "Sales",
    counts: "Selling price less the purchase price and any order expenses, on the orders you punched — counted on the day each was booked.",
    excludes: "Orders where the purchase price hasn't been filled in yet — the margin isn't known — and in-hand orders not yet booked.",
  },
  {
    key: "PURCHASE_SAVINGS",
    label: "Purchase savings",
    unit: "CURRENCY",
    team: "Purchase",
    counts:
      "What you bought for below the salesperson's distributor price, times the quantity, on the orders you processed in the period — less what it cost where sales accepted a higher price.",
    excludes:
      "Orders with no distributor price from sales (there is nothing to have saved against), prices you entered yourself, and cancelled orders.",
  },
  {
    key: "LEADS_WON",
    label: "Leads won",
    unit: "COUNT",
    team: "Sales",
    counts: "Leads you own that reached Won during the period.",
  },
  {
    key: "LEAD_VALUE_WON",
    label: "Value of leads won",
    unit: "CURRENCY",
    team: "Sales",
    counts: "The estimated value of the leads you own that were won in the period.",
    excludes: "Leads won with no value recorded — they count towards the number, not the value.",
  },
  {
    key: "LEADS_CREATED",
    label: "Leads created",
    unit: "COUNT",
    team: "Calling",
    counts: "Leads you sourced or qualified in the period — a requirement you turned into an opportunity.",
  },
  {
    key: "CALLS_CONNECTED",
    label: "Calls connected",
    unit: "COUNT",
    team: "Calling",
    counts: "Calls you logged that actually reached somebody.",
    excludes: "No answer, busy, switched off and wrong numbers — dialling is not calling.",
  },
  {
    key: "CALL_MINUTES",
    label: "Time on the phone",
    unit: "MINUTES",
    team: "Calling",
    counts: "Total duration of the calls you logged in the period.",
  },
  {
    key: "COMPANIES_ADDED",
    label: "Companies added",
    unit: "COUNT",
    team: "Profiling",
    counts: "Companies you added to the directory in the period.",
  },
  {
    key: "CONTACTS_ADDED",
    label: "Contacts added",
    unit: "COUNT",
    team: "Profiling",
    counts: "Contacts you added in the period, across every company.",
  },
  {
    key: "NEW_CUSTOMERS",
    label: "New customers won",
    unit: "COUNT",
    team: "Sales",
    counts:
      "Companies you own that placed their first order in the period — the moment somebody stops being a prospect.",
    excludes:
      "Companies already buying before the period, and directory entries that never ordered. A second order from an existing customer is growth, not a new customer.",
  },
  {
    key: "ADDON_VALUE",
    label: "Added seats",
    unit: "CURRENCY",
    team: "Sales",
    counts:
      "Seats added to subscriptions already running, at the pro-rated price actually charged for the remaining term.",
    excludes: "The original subscription, and renewals — both are counted under their own measures.",
  },
  {
    key: "VISITS_COMPLETED",
    label: "Visits completed",
    unit: "COUNT",
    team: "Field",
    counts: "Visits recorded as done in the period.",
    excludes: "Planned and cancelled visits.",
  },
  {
    key: "TICKETS_RESOLVED",
    label: "Tickets resolved",
    unit: "COUNT",
    team: "Support",
    counts: "Tickets assigned to you that were resolved in the period.",
  },
];

export const metricByKey = Object.fromEntries(METRICS.map((m) => [m.key, m])) as Record<
  MetricKey,
  MetricDefinition
>;

export const periodLabels: Record<TargetPeriod, string> = {
  MONTH: "Monthly",
  QUARTER: "Quarterly",
  YEAR: "Yearly",
};

export const scopeLabels: Record<TargetScope, string> = {
  USER: "One person",
  DEPARTMENT: "A team",
  COMPANY: "The whole company",
};

// ─── Periods ──────────────────────────────────────────────────────────────────

export type PeriodWindow = { fromDate: string; toDate: string; label: string; period: TargetPeriod };

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The Indian financial year a date falls in, as "2026-27".
 *
 * April to March, so a quarter here is never the calendar quarter — Q1 is April to June. Getting
 * this wrong would put a target in the wrong year on the one page where the year matters.
 */
export function financialYearLabel(date: Date) {
  const startYear = date.getUTCMonth() >= 3 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export function monthWindow(year: number, month: number): PeriodWindow {
  return {
    fromDate: iso(new Date(Date.UTC(year, month - 1, 1))),
    toDate: iso(new Date(Date.UTC(year, month, 0))),
    label: `${MONTHS[month - 1]} ${year}`,
    period: "MONTH",
  };
}

/** `quarter` is 1–4 of the *financial* year, so Q1 is April to June. */
export function quarterWindow(financialYearStart: number, quarter: number): PeriodWindow {
  const startMonth = 3 + (quarter - 1) * 3;
  const from = new Date(Date.UTC(financialYearStart, startMonth, 1));
  const to = new Date(Date.UTC(financialYearStart, startMonth + 3, 0));
  return {
    fromDate: iso(from),
    toDate: iso(to),
    label: `Q${quarter} ${financialYearStart}-${String((financialYearStart + 1) % 100).padStart(2, "0")}`,
    period: "QUARTER",
  };
}

export function yearWindow(financialYearStart: number): PeriodWindow {
  return {
    fromDate: iso(new Date(Date.UTC(financialYearStart, 3, 1))),
    toDate: iso(new Date(Date.UTC(financialYearStart + 1, 2, 31))),
    label: `FY ${financialYearStart}-${String((financialYearStart + 1) % 100).padStart(2, "0")}`,
    period: "YEAR",
  };
}

/**
 * The windows somebody would reasonably set a target for, around a given date. `now` is read by its
 * UTC parts, so pass the day as a date column holds it — the workspace's today is
 * `clock.calendarDate(new Date())`, not the moment, whose UTC month is the last one for the first
 * hours of a month in India.
 */
export function suggestedWindows(now: Date): PeriodWindow[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const fyStart = now.getUTCMonth() >= 3 ? year : year - 1;
  // Which financial quarter the month sits in: April is Q1.
  const fyQuarter = Math.floor(((month + 8) % 12) / 3) + 1;

  const next = month === 12 ? monthWindow(year + 1, 1) : monthWindow(year, month + 1);
  return [
    monthWindow(year, month),
    next,
    quarterWindow(fyStart, fyQuarter),
    quarterWindow(fyStart, fyQuarter === 4 ? 1 : fyQuarter + 1),
    yearWindow(fyStart),
  ];
}

// ─── Progress ─────────────────────────────────────────────────────────────────

export type ProgressStatus = "AHEAD" | "ON_TRACK" | "BEHIND" | "AT_RISK" | "MET" | "NOT_STARTED" | "MISSED";

export type Progress = {
  target: number;
  achieved: number;
  remaining: number;
  /** Achieved as a share of target, capped at nothing — 140% is a real and useful number. */
  percent: number;
  /** How much of the period has gone. */
  elapsedPercent: number;
  /** What would have been achieved by now at an even run rate. */
  expectedByNow: number;
  /** Achieved less expected. Negative is behind. */
  aheadBy: number;
  daysElapsed: number;
  daysTotal: number;
  daysLeft: number;
  /** What they now need per remaining day to finish on target. */
  requiredPerDay: number;
  /** What they have managed per day so far. */
  currentPerDay: number;
  status: ProgressStatus;
  label: string;
  tone: "green" | "amber" | "red" | "default";
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * How a target is doing, as at a point in time.
 *
 * The period is measured in whole days, and a period that has not started yet reports zero elapsed
 * rather than a negative — a target set for next month should read "not started", not "1,200%
 * behind".
 *
 * `status` is deliberately a judgement rather than a raw number, because the page has to say
 * something a person can act on. The thresholds are stated here so they can be argued with: more
 * than a tenth ahead of pace is ahead, within a tenth is on track, more than a quarter behind with
 * the period more than half gone is at risk.
 */
export function progressOf(params: {
  target: number;
  achieved: number;
  fromDate: Date | string;
  toDate: Date | string;
  now?: Date;
}): Progress {
  const now = params.now ?? new Date();
  const from = new Date(params.fromDate);
  const to = new Date(params.toDate);

  const day = 86400000;
  // Inclusive of both ends: a one-day target is one day, not zero.
  const daysTotal = Math.max(1, Math.round((to.getTime() - from.getTime()) / day) + 1);
  const rawElapsed = Math.round((now.getTime() - from.getTime()) / day) + 1;
  const daysElapsed = Math.min(daysTotal, Math.max(0, rawElapsed));
  const daysLeft = Math.max(0, daysTotal - daysElapsed);

  const target = round2(params.target);
  const achieved = round2(params.achieved);
  const remaining = round2(Math.max(0, target - achieved));
  const percent = target > 0 ? round2((achieved / target) * 100) : 0;
  const elapsedPercent = round2((daysElapsed / daysTotal) * 100);

  const expectedByNow = round2(target * (daysElapsed / daysTotal));
  const aheadBy = round2(achieved - expectedByNow);
  const requiredPerDay = daysLeft > 0 ? round2(remaining / daysLeft) : 0;
  const currentPerDay = daysElapsed > 0 ? round2(achieved / daysElapsed) : 0;

  const { status, label, tone } = judge({
    target,
    achieved,
    percent,
    expectedByNow,
    daysElapsed,
    daysLeft,
    elapsedPercent,
  });

  return {
    target,
    achieved,
    remaining,
    percent,
    elapsedPercent,
    expectedByNow,
    aheadBy,
    daysElapsed,
    daysTotal,
    daysLeft,
    requiredPerDay,
    currentPerDay,
    status,
    label,
    tone,
  };
}

function judge(p: {
  target: number;
  achieved: number;
  percent: number;
  expectedByNow: number;
  daysElapsed: number;
  daysLeft: number;
  elapsedPercent: number;
}): { status: ProgressStatus; label: string; tone: "green" | "amber" | "red" | "default" } {
  if (p.achieved >= p.target && p.target > 0) {
    return { status: "MET", label: p.percent > 100 ? `Met — ${Math.round(p.percent)}%` : "Met", tone: "green" };
  }
  // Not started yet: reporting anything else would be judging somebody on a period that hasn't begun.
  if (p.daysElapsed === 0) return { status: "NOT_STARTED", label: "Not started", tone: "default" };
  // Over, and short.
  if (p.daysLeft === 0) return { status: "MISSED", label: `Missed — ${Math.round(p.percent)}%`, tone: "red" };

  const pace = p.expectedByNow > 0 ? p.achieved / p.expectedByNow : p.achieved > 0 ? 2 : 0;
  if (pace >= 1.1) return { status: "AHEAD", label: "Ahead of pace", tone: "green" };
  if (pace >= 0.9) return { status: "ON_TRACK", label: "On track", tone: "green" };
  // More than a quarter behind, with the period past half way — the point where catching up stops
  // being a matter of a good week.
  if (pace < 0.75 && p.elapsedPercent > 50) return { status: "AT_RISK", label: "At risk", tone: "red" };
  return { status: "BEHIND", label: "Behind pace", tone: "amber" };
}

/** Formats a value the way its metric is read. */
export function formatMetric(value: number, unit: MetricUnit): string {
  if (unit === "CURRENCY") {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    }).format(value);
  }
  if (unit === "MINUTES") {
    const hours = Math.floor(value / 60);
    const minutes = Math.round(value % 60);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }
  return new Intl.NumberFormat("en-IN").format(Math.round(value));
}

/**
 * A plain sentence saying what has to happen from here.
 *
 * The thing a person actually wants from a target page — not the percentage, but what today has to
 * look like for the month to land.
 */
export function whatIsNeeded(progress: Progress, unit: MetricUnit): string {
  if (progress.status === "MET") return "Target met.";
  if (progress.status === "NOT_STARTED") return "This period hasn't started yet.";
  if (progress.status === "MISSED") {
    return `The period ended ${formatMetric(progress.remaining, unit)} short.`;
  }
  if (progress.daysLeft === 0) return "The period is over.";

  const perDay = formatMetric(progress.requiredPerDay, unit);
  const days = progress.daysLeft === 1 ? "the last day" : `each of the ${progress.daysLeft} days left`;
  const pace =
    progress.currentPerDay > 0
      ? ` You're averaging ${formatMetric(progress.currentPerDay, unit)} a day.`
      : "";
  return `${formatMetric(progress.remaining, unit)} to go — ${perDay} on ${days}.${pace}`;
}
