import type { DepreciationMethod } from "@prisma/client";

/**
 * Writing assets down.
 *
 * Pure, and worth being pure: depreciation is arithmetic that compounds. A rounding rule applied
 * slightly differently each month leaves an asset that never quite reaches its salvage value, or —
 * worse — one that quietly depreciates past it into a negative book value.
 *
 * Two methods, because Indian companies genuinely keep both: straight line for the accounts, as the
 * Companies Act schedule is usually applied, and written-down value for the tax computation, which
 * is how the Income Tax Act blocks work.
 */

export type AssetForDepreciation = {
  cost: number;
  salvageValue: number;
  usefulLifeYears: number;
  method: DepreciationMethod;
  /** Only used by the written-down-value method. */
  ratePercent: number | null;
  purchasedOn: Date;
  disposedOn: Date | null;
  /** Everything charged against it so far. */
  accumulated: number;
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** Whole months between two dates, counting the month a date falls in as started. */
export function monthsBetween(from: Date, to: Date) {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

/**
 * The most that may ever be written off: cost less what it will be worth at the end.
 *
 * Everything below is clamped to this. An asset depreciated past its salvage value shows a book
 * value lower than what it can be sold for, which makes the eventual disposal show a gain that
 * never happened.
 */
export function depreciableAmount(asset: Pick<AssetForDepreciation, "cost" | "salvageValue">) {
  return Math.max(0, round2(asset.cost - asset.salvageValue));
}

/** The annual rate, whichever method is in use — so a register can show them side by side. */
export function annualRate(asset: Pick<AssetForDepreciation, "method" | "ratePercent" | "usefulLifeYears">) {
  if (asset.method === "WRITTEN_DOWN_VALUE") return asset.ratePercent ?? 0;
  return asset.usefulLifeYears > 0 ? round2(100 / asset.usefulLifeYears) : 0;
}

/**
 * One month's charge.
 *
 * Monthly rather than annual because a P&L is read monthly, and an asset bought in January should
 * not put its whole year's depreciation into the month somebody happens to run it.
 *
 * Returns zero — not a negative, and not an error — for an asset bought after the period, already
 * disposed of, or already fully written down. Those are ordinary states, not failures, and a
 * depreciation run sweeps every asset every month.
 */
export function monthlyCharge(asset: AssetForDepreciation, periodEnd: Date): number {
  if (asset.disposedOn && asset.disposedOn <= periodEnd) return 0;
  // Nothing before it was owned.
  if (asset.purchasedOn > periodEnd) return 0;

  const ceiling = depreciableAmount(asset);
  const remaining = round2(ceiling - asset.accumulated);
  if (remaining <= 0) return 0;

  let charge: number;
  if (asset.method === "WRITTEN_DOWN_VALUE") {
    const rate = (asset.ratePercent ?? 0) / 100;
    // A percentage of what is left, which is what "written down value" means — the charge shrinks
    // every year rather than staying flat.
    const writtenDownValue = round2(asset.cost - asset.accumulated);
    charge = round2((writtenDownValue * rate) / 12);
  } else {
    if (asset.usefulLifeYears <= 0) return 0;
    charge = round2(ceiling / (asset.usefulLifeYears * 12));
  }

  // The last month is whatever is left, so the asset lands exactly on its salvage value instead of
  // a few paise above or below it.
  return round2(Math.min(charge, remaining));
}

/** What the asset is worth on the books right now. */
export function bookValue(asset: Pick<AssetForDepreciation, "cost" | "accumulated">) {
  return round2(asset.cost - asset.accumulated);
}

/**
 * A full schedule, for the register's drill-down.
 *
 * Capped at the useful life plus a year: a written-down-value asset approaches its salvage value
 * without ever arriving, so an uncapped loop would not terminate.
 */
export function schedule(asset: AssetForDepreciation, months: number): { month: number; charge: number; accumulated: number; closing: number }[] {
  const out: { month: number; charge: number; accumulated: number; closing: number }[] = [];
  let accumulated = asset.accumulated;
  const limit = Math.min(months, asset.usefulLifeYears * 12 + 12);

  for (let m = 1; m <= limit; m += 1) {
    const periodEnd = new Date(
      Date.UTC(asset.purchasedOn.getUTCFullYear(), asset.purchasedOn.getUTCMonth() + m, 0, 12),
    );
    const charge = monthlyCharge({ ...asset, accumulated }, periodEnd);
    if (charge <= 0) break;
    accumulated = round2(accumulated + charge);
    out.push({ month: m, charge, accumulated, closing: round2(asset.cost - accumulated) });
  }
  return out;
}

/** The last day of a month, which is the date every charge is dated to. */
export function endOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0, 12, 0, 0));
}

export function startOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
}

export const depreciationMethodLabels: Record<DepreciationMethod, string> = {
  STRAIGHT_LINE: "Straight line",
  WRITTEN_DOWN_VALUE: "Written down value",
};
