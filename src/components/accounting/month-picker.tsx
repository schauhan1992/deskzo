"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Label, Select } from "@/components/ui/input";
import { MONTH_NAMES } from "@/lib/ledger/period";
import { indiaClock } from "@/lib/time/zone";


/**
 * The period selector for a monthly return.
 *
 * Months rather than a date range, because GST and TDS are filed monthly — offering an arbitrary
 * range would invite somebody to build a return for a period no return exists for.
 */
export function MonthPicker({ month, year }: { month: number; year: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function set(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.push(`${pathname}?${params.toString()}`);
  }

  // Far enough back to cover a business's history here, and no further forward than this month —
  // a return for a month that hasn't happened is not a thing.
  // India's year, whatever zone the workspace keeps — returns are filed for India's months: on 1 January
  // before 05:30 IST a browser or server on UTC is still in the old one.
  const thisYear = indiaClock.parts(new Date()).year;
  const years = Array.from({ length: 6 }, (_, i) => thisYear - 4 + i);

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="month">Month</Label>
        <Select id="month" value={String(month)} onChange={(e) => set("month", e.target.value)} className="w-40">
          {MONTH_NAMES.map((name, i) => (
            <option key={name} value={i + 1}>
              {name}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="year">Year</Label>
        <Select id="year" value={String(year)} onChange={(e) => set("year", e.target.value)} className="w-28">
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
