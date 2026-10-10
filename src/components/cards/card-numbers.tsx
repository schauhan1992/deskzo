import type { CardNumbers } from "@/lib/cards/server";

const LABELS: { key: keyof CardNumbers; label: string }[] = [
  { key: "views", label: "Views" },
  { key: "saves", label: "Saved" },
  { key: "taps", label: "Link taps" },
  { key: "shared", label: "Shared back" },
];

/** A card's numbers: this week large, all time beneath. Counts only — nothing about who. */
export function CardNumbersStrip({ week, ever }: { week: CardNumbers; ever: CardNumbers }) {
  return (
    <div className="grid grid-cols-4 divide-x divide-line rounded-xl border border-line bg-surface">
      {LABELS.map(({ key, label }) => (
        <div key={key} className="px-2 py-3 text-center">
          <p className="text-lg font-semibold tabular-nums text-text">{week[key]}</p>
          <p className="text-[11px] text-muted">{label}</p>
          <p className="mt-0.5 text-[11px] tabular-nums text-subtle">{ever[key]} in all</p>
        </div>
      ))}
      <p className="col-span-4 border-t border-line px-3 py-1.5 text-center text-[11px] text-subtle">The last 7 days</p>
    </div>
  );
}
