"use client";

import { Label, Select } from "@/components/ui/input";

/**
 * "Find a partner"'s country: a plain GET form (`?country=`), so it works without script; with script,
 * choosing a country submits it — as the pricing page's country picker (../forms/country-picker.tsx).
 * Only countries some listed partner sells in are offered.
 */
export function PartnerCountryFilter({ countries, value }: { countries: { code: string; name: string }[]; value: string }) {
  return (
    <form method="get" className="flex w-full min-w-0 items-center gap-3 sm:w-auto">
      <Label htmlFor="partner-country-filter" className="shrink-0 whitespace-nowrap">
        Country
      </Label>
      <Select id="partner-country-filter" name="country" defaultValue={value} className="min-w-0 sm:w-60" onChange={(e) => e.currentTarget.form?.requestSubmit()}>
        <option value="">All countries</option>
        {countries.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </Select>
      <noscript>
        <button type="submit" className="h-9 rounded-base border border-line-strong bg-surface px-3 text-sm font-medium text-text">
          Show
        </button>
      </noscript>
    </form>
  );
}
