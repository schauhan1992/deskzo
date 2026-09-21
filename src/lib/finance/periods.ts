import { financialYearBounds } from "@/lib/ledger/period";

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

const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);

/** Which fiscal quarter a month sits in: April is the start of Q1. */
function fiscalQuarterStart(date: Date): Date {
  const shifted = (date.getMonth() - 3 + 12) % 12;
  const quarterIndex = Math.floor(shifted / 3);
  const month = (quarterIndex * 3 + 3) % 12;
  // A quarter beginning in January, February or March belongs to the fiscal year that started the
  // previous April, so its calendar year is the later one.
  const year = month >= 3 ? (date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1) : date.getFullYear();
  return new Date(year, month, 1);
}

function fiscalYear(date: Date): { from: Date; to: Date; label: string } {
  const bounds = financialYearBounds(date);
  return {
    from: new Date(`${bounds.from}T00:00:00`),
    to: new Date(`${bounds.to}T23:59:59.999`),
    label: `FY ${bounds.label}`,
  };
}

const QUARTER_LABEL = ["Q1", "Q2", "Q3", "Q4"];

export function resolvePeriod(key: PeriodKey, now: Date): ResolvedPeriod {
  switch (key) {
    case "thisFiscalYear": {
      const fy = fiscalYear(now);
      return { key, ...fy };
    }
    case "lastFiscalYear": {
      const fy = fiscalYear(new Date(now.getFullYear() - 1, now.getMonth(), 1));
      return { key, ...fy };
    }
    case "thisQuarter":
    case "lastQuarter": {
      const start = fiscalQuarterStart(now);
      if (key === "lastQuarter") start.setMonth(start.getMonth() - 3);
      const end = new Date(start.getFullYear(), start.getMonth() + 3, 0, 23, 59, 59, 999);
      const index = ((start.getMonth() - 3 + 12) % 12) / 3;
      return {
        key,
        from: start,
        to: end,
        label: `${QUARTER_LABEL[index] ?? "Q"} ${financialYearBounds(start).label}`,
      };
    }
    case "thisMonth":
      return { key, from: startOfMonth(now), to: endOfMonth(now), label: monthLabel(now) };
    case "lastMonth": {
      const m = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return { key, from: startOfMonth(m), to: endOfMonth(m), label: monthLabel(m) };
    }
    case "last6Months":
    case "last12Months": {
      const back = key === "last6Months" ? 5 : 11;
      // From the *start* of the month that many back, so the window is whole months and the last
      // bar is the month in progress rather than a fortnight of an extra one.
      const from = new Date(now.getFullYear(), now.getMonth() - back, 1);
      return { key, from, to: now, label: key === "last6Months" ? "Last 6 months" : "Last 12 months" };
    }
  }
}

function monthLabel(d: Date) {
  return d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}
