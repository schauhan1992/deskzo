"use client";

import { Label, Select } from "@/components/ui/input";

/**
 * Which country's prices: a plain GET form (`?country=`), so it works without script; with script,
 * choosing a country submits it. The interval chosen is kept.
 */
export function CountryPicker({ label, countries, value, interval }: { label: string; countries: { code: string; name: string }[]; value: string; interval: string | null }) {
  return (
    <form method="get" className="flex w-full min-w-0 items-center gap-3 sm:w-auto">
      <Label htmlFor="pricing-country" className="shrink-0 whitespace-nowrap">
        {label}
      </Label>
      <Select id="pricing-country" name="country" defaultValue={value} className="min-w-0 sm:w-60" onChange={(e) => e.currentTarget.form?.requestSubmit()}>
        {countries.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </Select>
      {interval && <input type="hidden" name="interval" value={interval} />}
      <noscript>
        <button type="submit" className="h-9 rounded-base border border-line-strong bg-surface px-3 text-sm font-medium text-text">
          Show
        </button>
      </noscript>
    </form>
  );
}
