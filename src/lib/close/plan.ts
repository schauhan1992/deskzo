import { addMonths, monthLabel } from "@/lib/close/months";

/**
 * A prepaid's or accrual's months: pure, so check:close-core proves the paisa.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** `amount` over `months` equal parts to the paisa, the last taking what rounding leaves. Never negative. */
export function spreadEvenly(amount: number, months: number): number[] {
  const paise = Math.round(amount * 100);
  const each = Math.floor(paise / months);
  return Array.from({ length: months }, (_, i) => (i === months - 1 ? paise - each * (months - 1) : each) / 100);
}

/** A schedule's months from its start, with their amounts. */
export function planLines(amount: number, startMonth: Date, months: number): { month: Date; amount: number }[] {
  return spreadEvenly(amount, months).map((a, i) => ({ month: addMonths(startMonth, i), amount: a }));
}

/**
 * The unposted months of a changed schedule: its new months from its start, less the ones already
 * posted, sharing what the posted ones haven't used, evenly with the rounding in the last. Posted months
 * never change.
 */
export function replanUnposted(input: {
  amount: number;
  startMonth: Date;
  months: number;
  posted: { month: Date; amount: number }[];
}): { ok: true; lines: { month: Date; amount: number }[] } | { ok: false; error: string } {
  const plan = Array.from({ length: input.months }, (_, i) => addMonths(input.startMonth, i));
  const planKeys = new Set(plan.map((m) => m.getTime()));
  const outside = input.posted.filter((p) => !planKeys.has(p.month.getTime()));
  if (outside.length) {
    return { ok: false, error: `${monthLabel(outside[0]!.month)} is already posted, so the schedule must still include it.` };
  }
  const postedKeys = new Set(input.posted.map((p) => p.month.getTime()));
  const open = plan.filter((m) => !postedKeys.has(m.getTime()));
  const used = round2(input.posted.reduce((t, p) => t + p.amount, 0));
  const left = round2(input.amount - used);
  if (left < 0) return { ok: false, error: `₹${used.toLocaleString("en-IN")} is already posted; the amount can't be less than that.` };
  if (open.length === 0) {
    if (left > 0) return { ok: false, error: "Every month is already posted. Add months to spread the rest over." };
    return { ok: true, lines: [] };
  }
  const parts = spreadEvenly(left, open.length);
  return { ok: true, lines: open.map((month, i) => ({ month, amount: parts[i]! })) };
}

