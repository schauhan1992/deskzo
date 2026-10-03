import Link from "next/link";
import { listCommissionPartyEarnings } from "@/actions/commission-party";
import { formatCurrency } from "@/lib/utils";
import { formatOrderId } from "@/lib/order-id";
import { companyPath, orderPath } from "@/lib/record-links";
import { workspaceClock } from "@/lib/time/workspace";

type Earning = Awaited<ReturnType<typeof listCommissionPartyEarnings>>[number];

/** What this party has actually been paid, and which customer each payout came from. */
export async function CommissionPartyEarnings({ earnings }: { earnings: Earning[] }) {
  const total = earnings.reduce((sum, e) => sum + e.amount, 0);

  if (earnings.length === 0) {
    return (
      <p className="text-sm text-subtle">
        No commission recorded for this party yet. It&apos;s captured as an expense when an order is punched.
      </p>
    );
  }

  const clock = await workspaceClock();
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {earnings.length} payout(s) totalling <span className="font-semibold text-text">{formatCurrency(total)}</span>
      </p>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Order</th>
              <th className="px-3 py-2">Into account</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Recorded</th>
            </tr>
          </thead>
          <tbody>
            {earnings.map((earning) => (
              <tr key={earning.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2">
                  <Link href={companyPath(earning.order.company.companySeq)} className="text-text hover:underline">
                    {earning.order.company.name}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <Link href={orderPath(earning.order.orderSeq)} className="font-mono text-xs text-text hover:underline">
                    {formatOrderId(earning.order.orderSeq)}
                  </Link>
                  <div className="text-xs text-subtle">{earning.order.itemName}</div>
                </td>
                <td className="px-3 py-2 text-muted">{earning.payeeAccount?.label ?? "—"}</td>
                <td className="px-3 py-2 text-right font-medium text-text">{formatCurrency(earning.amount)}</td>
                <td className="px-3 py-2 text-muted">{clock.date(earning.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
