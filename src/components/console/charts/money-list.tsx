import { formatMoney } from "@/lib/billing/money";
import { cn } from "@/lib/utils";
import { finiteValue } from "./chart-utils";

/**
 * Money in more than one currency, one line each — never summed.
 *
 * ₹12,000 and $300 are not "₹12,300" or "12,300" of anything, and converting them would need a rate,
 * a date and an opinion about both. So a figure that spans currencies is shown as the list it is.
 * Entries for the same currency are added together (that sum is real), in the order they first
 * appear — the loader decides which currency leads.
 *
 * `size="lg"` is a KPI value: a single currency at the tile's full size, several a step smaller so
 * three lines still fit a tile. `"sm"` sits in a table cell or a sentence.
 */
export function MoneyList({
  amounts,
  empty = "—",
  size = "lg",
}: {
  amounts: { currency: string; minor: number }[];
  empty?: string;
  size?: "sm" | "lg";
}) {
  const merged = amounts.reduce<{ currency: string; minor: number }[]>((acc, a) => {
    const currency = a.currency.toUpperCase();
    const minor = finiteValue(a.minor);
    return acc.some((x) => x.currency === currency)
      ? acc.map((x) => (x.currency === currency ? { currency, minor: x.minor + minor } : x))
      : [...acc, { currency, minor }];
  }, []);

  if (merged.length === 0) return <span className={cn("text-muted", size === "sm" && "text-sm")}>{empty}</span>;

  return (
    <ul
      className={cn(
        "tabular-nums",
        size === "sm" ? "space-y-0.5 text-sm" : merged.length === 1 ? "text-2xl font-semibold tracking-tight" : "space-y-0.5 text-lg leading-snug font-semibold tracking-tight",
      )}
    >
      {merged.map((a) => (
        <li key={a.currency} className="whitespace-nowrap">
          {formatMoney(Math.round(a.minor), a.currency)}
        </li>
      ))}
    </ul>
  );
}
