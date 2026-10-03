import { financialYearBounds, financialYearStartOf, financialYearWindow } from "@/lib/india-time";
import { indiaClock } from "@/lib/time/zone";
import { MONTH_NAMES } from "@/lib/ledger/period";

/**
 * The windows a finance card can be looked at through.
 *
 * Quarters are **fiscal** quarters, not calendar ones: Q1 is April to June, because the year these
 * books are kept on starts in April. A card offering "this quarter" that meant January to March
 * would disagree with every quarterly filing the business makes, and would do it quietly — the
 * number would just be different from the one in the return.
 */

export type PeriodKey =
  | "thisFiscalYear"
  | "lastFiscalYear"
  | "thisQuarter"
  | "lastQuarter"
  | "thisMonth"
  | "lastMonth"
  | "last6Months"
  | "last12Months";

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "thisFiscalYear", label: "This fiscal year" },
  { key: "lastFiscalYear", label: "Last fiscal year" },
  { key: "thisQuarter", label: "This quarter" },
  { key: "lastQuarter", label: "Last quarter" },
  { key: "thisMonth", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "last6Months", label: "Last 6 months" },
  { key: "last12Months", label: "Last 12 months" },
];

export type ResolvedPeriod = { key: PeriodKey; from: Date; to: Date; label: string };

/**
 * Every bound here is on India's calendar (`indiaClock`, src/lib/time/zone.ts), in every workspace:
 * the cards show the books' figures, and the books keep India's calendar. They were built with
 * `new Date(y, m, d)` and `getMonth()`, which read the host's clock: on a server in UTC "this month"
 * began at 05:30 IST on the 1st and ran into the morning of the next month's 1st.
 *
 * `to` stays inclusive, as its callers compare with `lte` and the cards print it as the last day:
 * the millisecond before the next Indian midnight. Timestamps are stored to the millisecond, so that
 * is the same set of instants as `lt` the next midnight, with no gap for one to fall through.
 */
const inclusive = (exclusiveEnd: Date) => new Date(exclusiveEnd.getTime() - 1);

/** The first month (0-based) of the fiscal quarter a date sits in, in the date's calendar year. */
function fiscalQuarterStart(date: Date): { year: number; month: number } {
  const { year, month } = indiaClock.parts(date);
  // April, July, October and January each open a quarter. A quarter never straddles a calendar
  // year, so its start is in the same calendar year as the date.
  const shifted = (month - 3 + 12) % 12;
  return { year, month: (Math.floor(shifted / 3) * 3 + 3) % 12 };
}

function fiscalYear(date: Date): { from: Date; to: Date; label: string } {
  const window = financialYearWindow(financialYearStartOf(date));
  return { from: window.from, to: inclusive(window.to), label: `FY ${window.label}` };
}

const QUARTER_LABEL = ["Q1", "Q2", "Q3", "Q4"];

export function resolvePeriod(key: PeriodKey, now: Date): ResolvedPeriod {
  const today = indiaClock.parts(now);
  switch (key) {
    case "thisFiscalYear": {
      const fy = fiscalYear(now);
      return { key, ...fy };
    }
    case "lastFiscalYear": {
      const fy = fiscalYear(indiaClock.midnight(today.year - 1, today.month, 1));
      return { key, ...fy };
    }
    case "thisQuarter":
    case "lastQuarter": {
      const q = fiscalQuarterStart(now);
      const shift = key === "lastQuarter" ? -3 : 0;
      const start = indiaClock.midnight(q.year, q.month + shift, 1);
      const index = ((indiaClock.parts(start).month - 3 + 12) % 12) / 3;
      return {
        key,
        from: start,
        to: inclusive(indiaClock.midnight(q.year, q.month + shift + 3, 1)),
        label: `${QUARTER_LABEL[index] ?? "Q"} ${financialYearBounds(start).label}`,
      };
    }
    case "thisMonth":
    case "lastMonth": {
      const month = indiaClock.monthWindow(now, key === "lastMonth" ? -1 : 0);
      return { key, from: month.from, to: inclusive(month.to), label: monthLabel(month.from) };
    }
    case "last6Months":
    case "last12Months": {
      const back = key === "last6Months" ? 5 : 11;
      // From the *start* of the month that many back, so the window is whole months and the last
      // bar is the month in progress rather than a fortnight of an extra one.
      const from = indiaClock.monthWindow(now, -back).from;
      return { key, from, to: now, label: key === "last6Months" ? "Last 6 months" : "Last 12 months" };
    }
  }
}

/** "September 2026": India's month, in words spelled here rather than asked of Intl (src/lib/time/zone.ts). */
function monthLabel(d: Date) {
  const { year, month } = indiaClock.parts(d);
  return `${MONTH_NAMES[month]} ${year}`;
}
