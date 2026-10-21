/**
 * Exact arithmetic for money and stock quantities (Finance → Accounts, owner, 22 Oct 2026).
 *
 * Amounts are carried as whole paise and quantities as whole thousandths, so adding up a voucher or a stock
 * ledger never drifts the way adding binary fractions does — 0.1 + 0.2 is 0.30000000000000004 in a float,
 * and 30 paise here. A product of a quantity and a cost can run past what a float holds exactly, so those
 * are done in BigInt and rounded once, half away from zero, at the end.
 *
 * Pure, and client-safe: the voucher form adds its lines with the same functions the server checks them by.
 */

/** Rupees to whole paise, rounded half away from zero. */
export function toPaise(rupees: number | string | { toString(): string } | null | undefined): number {
  const n = Number(rupees ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.sign(n) * Math.round(Math.abs(n) * 100);
}

export function fromPaise(paise: number): number {
  return paise / 100;
}

/** Rupees rounded to the paisa, through whole paise. */
export function round2(rupees: number | string | { toString(): string } | null | undefined): number {
  return fromPaise(toPaise(rupees));
}

/** A sum of rupee amounts, exact to the paisa. */
export function sumRupees(values: readonly (number | string | { toString(): string } | null | undefined)[]): number {
  return fromPaise(values.reduce<number>((total, v) => total + toPaise(v), 0));
}

/** A quantity in thousandths of a unit — the stock ledger's precision (Decimal(14, 3)). */
export function toMilli(quantity: number | string | { toString(): string } | null | undefined): number {
  const n = Number(quantity ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.sign(n) * Math.round(Math.abs(n) * 1000);
}

export function fromMilli(milli: number): number {
  return milli / 1000;
}

/** A quantity rounded to three decimals, through thousandths. */
export function round3(quantity: number | string | { toString(): string } | null | undefined): number {
  return fromMilli(toMilli(quantity));
}

/** A unit cost in ten-thousandths of a rupee — the ledger's unit-cost precision (Decimal(14, 4)). */
export function toCost4(unitCost: number | string | { toString(): string } | null | undefined): number {
  const n = Number(unitCost ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.sign(n) * Math.round(Math.abs(n) * 10000);
}

export function fromCost4(cost4: number): number {
  return cost4 / 10000;
}

/** Divides two BigInts, rounding half away from zero. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === BigInt(0)) return BigInt(0);
  const negative = numerator < BigInt(0) !== denominator < BigInt(0);
  const n = numerator < BigInt(0) ? -numerator : numerator;
  const d = denominator < BigInt(0) ? -denominator : denominator;
  const q = (n * BigInt(2) + d) / (d * BigInt(2));
  return negative ? -q : q;
}

/**
 * The value, in paise, of `qtyMilli` thousandths at `cost4` ten-thousandths of a rupee each:
 * qty × cost × 100 = milli/1000 × cost4/10000 × 100 = milli × cost4 / 100000.
 */
export function valuePaise(qtyMilli: number, cost4: number): number {
  return Number(divRound(BigInt(qtyMilli) * BigInt(cost4), BigInt(100000)));
}

/**
 * A share of a value in proportion to quantities: what `partMilli` of a holding of `wholeMilli` is worth,
 * when the whole is worth `wholePaise`. Taking all of it takes exactly all of the value, so a balance
 * that is emptied is left at nothing rather than a stray paisa.
 */
export function proportionPaise(wholePaise: number, partMilli: number, wholeMilli: number): number {
  if (wholeMilli === 0) return 0;
  if (partMilli === wholeMilli) return wholePaise;
  return Number(divRound(BigInt(wholePaise) * BigInt(partMilli), BigInt(wholeMilli)));
}

/** The cost of one unit, in ten-thousandths, of a holding worth `paise` for `qtyMilli` thousandths. */
export function unitCost4(paise: number, qtyMilli: number): number {
  if (qtyMilli === 0) return 0;
  // paise / 100 rupees ÷ milli / 1000 units = paise × 10 / milli rupees; × 10000 for cost4.
  return Number(divRound(BigInt(paise) * BigInt(100000), BigInt(qtyMilli)));
}

/** Debits and credits, in paise — whether an entry balances, without a float's rounding in the way. */
export function entryTotalsPaise(lines: readonly { debit: number | string; credit: number | string }[]) {
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    debit += toPaise(line.debit);
    credit += toPaise(line.credit);
  }
  return { debit, credit };
}

/** Indian digit grouping, "₹1,23,456.70". */
export function formatRupees(rupees: number, options: { decimals?: number } = {}): string {
  const decimals = options.decimals ?? 2;
  const sign = rupees < 0 ? "-" : "";
  return `${sign}₹${Math.abs(rupees).toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/** A quantity as it's shown: up to `decimals` places, trailing zeros dropped. */
export function formatQuantity(quantity: number, decimals = 3): string {
  return quantity.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}
