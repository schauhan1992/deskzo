import Link from "next/link";
import type { CustomerRevenue } from "@/lib/revenue/reports";
import { monthLabel } from "@/lib/revenue/periods";
import { formatCurrency } from "@/lib/utils";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * A customer's revenue on the company page (spec §3.8): what was invoiced, how much of it is earned,
 * how much is still waiting in Deferred Revenue, what is scheduled for the next twelve months, and
 * this month's recurring revenue. Figures only — the page decides whether the viewer may see them.
 */
export function CustomerRevenueCard({ revenue }: { revenue: CustomerRevenue }) {
  const { schedules } = revenue;
  const live = schedules.active + schedules.pending;
  const figures: { label: string; value: number; hint: string }[] = [
    { label: "Invoiced", value: revenue.invoiced - revenue.credited, hint: revenue.credited > 0 ? `After ${formatCurrency(revenue.credited)} of credit notes` : "Issued invoices, before tax" },
    { label: "Recognised", value: revenue.recognised, hint: "Earned so far" },
    { label: "Deferred", value: revenue.deferred, hint: "Invoiced, not yet earned" },
    { label: "Next 12 months", value: revenue.next12Months, hint: `Scheduled from ${monthLabel(revenue.month)}` },
    { label: "MRR", value: revenue.mrr, hint: `Recurring revenue in ${monthLabel(revenue.month)}` },
  ];
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>Revenue</span>
        <Link href={`/accounting/revenue?customer=${encodeURIComponent(revenue.companyId)}`} className="text-xs font-medium text-muted hover:text-text hover:underline">
          {live > 0 ? `${live} live schedule${live === 1 ? "" : "s"}` : "Schedules"}
          {schedules.pending > 0 ? ` · ${schedules.pending} pending approval` : ""} →
        </Link>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {figures.map((f) => (
          <div key={f.label} className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-subtle">{f.label}</div>
            <div className="mt-1 whitespace-nowrap text-base font-semibold tabular-nums text-text">{formatCurrency(f.value)}</div>
            <div className="mt-0.5 text-xs text-muted">{f.hint}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
