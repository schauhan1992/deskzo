import { formatMoney } from "@/lib/billing/money";
import type { Money } from "@/lib/partners/types";
import { cn } from "@/lib/utils";

/**
 * Money in the partner portal: in the currency it was earned or billed in, one line per currency,
 * never added across currencies and never converted (₹12,000 and $300 are not "12,300" of anything).
 * Amounts are minor units, written out with `formatMoney`; figures are tabular so columns line up.
 *
 * Server-safe: no hooks, no directive.
 */

/** A whole number of minor units; anything else (NaN, a stray float, -0) reads as its nearest honest value. */
const clean = (minor: number) => (Number.isFinite(minor) ? Math.round(minor) : 0) || 0;

/**
 * One line per currency. Entries in the same currency are added together (that sum is real), in the
 * order each currency first appears — the loader decides which leads. Nothing to show is `empty`.
 */
export function MoneyStack({ items, empty = "—", className }: { items: Money[]; empty?: string; className?: string }) {
  const merged: Money[] = [];
  for (const item of items ?? []) {
    const currency = String(item.currency ?? "").toUpperCase();
    if (!currency) continue;
    const same = merged.find((m) => m.currency === currency);
    if (same) same.minor += clean(item.minor);
    else merged.push({ currency, minor: clean(item.minor) });
  }
  if (merged.length === 0) return <span className={cn("text-muted", className)}>{empty}</span>;
  return (
    <ul className={cn("space-y-0.5 tabular-nums", className)}>
      {merged.map((m) => (
        <li key={m.currency} className="whitespace-nowrap">
          {formatMoney(m.minor, m.currency)}
        </li>
      ))}
    </ul>
  );
}

/**
 * One amount. A clawback (a negative amount) carries its minus sign, as `formatMoney` writes it
 * ("-₹1,250.00"). `signed` also marks a positive amount with "+", for a column where both occur and
 * the direction is the point (earned against clawed back).
 */
export function Amount({ minor, currency, signed = false, className }: { minor: number; currency: string; signed?: boolean; className?: string }) {
  const value = clean(minor);
  const text = formatMoney(value, currency);
  return <span className={cn("whitespace-nowrap tabular-nums", className)}>{signed && value > 0 ? `+${text}` : text}</span>;
}
