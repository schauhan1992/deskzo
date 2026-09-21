import Link from "next/link";
import type { myPayslips } from "@/actions/payroll";
import { Badge, Card, CardHeader } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/utils";
import { monthLabel } from "@/lib/hr/calendar";

type Slip = Awaited<ReturnType<typeof myPayslips>>[number];

const num = (v: unknown) => Number(v ?? 0);

/**
 * Your own payslips.
 *
 * Only ever shows months that have been locked: a draft is a working figure payroll is still
 * arguing with itself about, and seeing one change between Tuesday and Friday would be worse than
 * not seeing it at all.
 */
export function MyPayslips({ payslips }: { payslips: Slip[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <CardHeader className="text-sm font-medium text-text">Your payslips</CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Month</th>
              <th className="px-3 py-2.5 text-right">Paid days</th>
              <th className="px-3 py-2.5 text-right">Gross</th>
              <th className="px-3 py-2.5 text-right">Deductions</th>
              <th className="px-3 py-2.5 text-right">Net</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {payslips.map((s) => (
              <tr key={s.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5 text-text">{monthLabel(s.run.month, s.run.year)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted">
                  {num(s.paidDays)}/{num(s.monthDays)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted">{formatCurrency(num(s.grossEarnings))}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted">
                  {formatCurrency(num(s.totalDeductions))}
                </td>
                <td className="px-3 py-2.5 text-right font-medium tabular-nums text-text">
                  {formatCurrency(num(s.netPay))}
                </td>
                <td className="px-3 py-2.5">
                  <Badge tone={s.run.status === "PAID" ? "green" : "blue"}>
                    {s.run.status === "PAID" && s.run.paidAt ? `Paid ${formatDate(s.run.paidAt)}` : "Locked"}
                  </Badge>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Link href={`/payslips/${s.id}/print`} target="_blank" className="text-xs text-brand hover:underline">
                    Download
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
