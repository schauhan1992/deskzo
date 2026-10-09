/** Re-exports plus the leave-calendar cases, kept apart so check-payroll.ts stays readable. */
export { computeEsi, computePf, computePayslip, computeProfessionalTax, employmentInMonth } from "../src/lib/hr/payroll";
import { countLeaveDays } from "../src/lib/hr/calendar";

type Eq = (label: string, actual: number, expected: number, why: string) => void;
type Truthy = (label: string, ok: boolean, why: string) => void;

export function countLeaveDaysProbe(eq: Eq, truthy: Truthy) {
  // Mon 5 Jan 2026 – Fri 9 Jan 2026 is a full working week.
  const week = countLeaveDays({ from: "2026-01-05", to: "2026-01-09" }, []);
  eq("Mon–Fri", week.days, 5, "five working days");

  // Fri 9 Jan – Mon 12 Jan spans a weekend.
  const overWeekend = countLeaveDays({ from: "2026-01-09", to: "2026-01-12" }, []);
  eq("Fri–Mon", overWeekend.days, 2, "the Saturday and Sunday between are free");
  truthy(
    "...and the weekend is reported as skipped",
    overWeekend.skipped.filter((s) => s.why === "week off").length === 2,
    "so the employee can see why it cost two days",
  );

  const withHoliday = countLeaveDays({ from: "2026-01-05", to: "2026-01-09" }, [{ date: "2026-01-07" }]);
  eq("a holiday inside the span", withHoliday.days, 4, "Republic-Day-style holiday does not consume leave");

  const optional = countLeaveDays({ from: "2026-01-05", to: "2026-01-09" }, [{ date: "2026-01-07", optional: true }]);
  eq("a restricted holiday inside the span", optional.days, 5, "the office is open, so it costs a day");

  const halfStart = countLeaveDays({ from: "2026-01-05", to: "2026-01-06", fromHalfDay: true }, []);
  eq("half day at the start", halfStart.days, 1.5, "afternoon of Monday plus all of Tuesday");

  const bothHalves = countLeaveDays({ from: "2026-01-05", to: "2026-01-07", fromHalfDay: true, toHalfDay: true }, []);
  eq("half days at both ends", bothHalves.days, 2, "three days less two halves");

  const singleHalf = countLeaveDays({ from: "2026-01-05", to: "2026-01-05", fromHalfDay: true, toHalfDay: true }, []);
  eq("one day, both boxes ticked", singleHalf.days, 0.5, "it is one half day, not zero");

  const halfOnWeekend = countLeaveDays({ from: "2026-01-10", to: "2026-01-12", fromHalfDay: true }, []);
  eq("half day starting on a Saturday", halfOnWeekend.days, 1, "the half comes off nothing, Monday is the only cost");
}
