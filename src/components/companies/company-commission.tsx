import Link from "next/link";
import { listCompanyCommissions, listCompanyCommissionParties } from "@/actions/commission-party";
import { LinkedCompaniesManager } from "@/components/companies/linked-companies-manager";
import { Card, CardContent, CardHeader, Badge } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { formatOrderId } from "@/lib/order-id";
import { companyPath, orderPath } from "@/lib/record-links";
import { workspaceClock } from "@/lib/time/workspace";

type CommissionParty = Awaited<ReturnType<typeof listCompanyCommissionParties>>[number];
type Commission = Awaited<ReturnType<typeof listCompanyCommissions>>[number];

/**
 * The commission side of a customer's 360 view: who we pay for their business, and what's actually
 * been paid out on their orders. Both were previously only visible from the commission party's own
 * page, which meant you couldn't answer "what does this account really cost us" from the account.
 */
export async function CompanyCommission({
  companyId,
  commissionParties,
  commissions,
  partyOptions,
}: {
  companyId: string;
  commissionParties: CommissionParty[];
  commissions: Commission[];
  partyOptions: { id: string; name: string }[];
}) {
  const clock = await workspaceClock();
  const totalPaid = commissions.reduce((sum, c) => sum + c.amount, 0);

  // A payout is recorded against an order, but what matters here is who it went to, so the same
  // party's separate payouts are rolled up rather than making you add them up by eye.
  const byParty = new Map<string, { name: string; total: number; count: number }>();
  for (const commission of commissions) {
    const key = commission.payee?.id ?? "unknown";
    const current = byParty.get(key) ?? { name: commission.payee?.name ?? "Unattributed", total: 0, count: 0 };
    current.total += commission.amount;
    current.count += 1;
    byParty.set(key, current);
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="text-sm font-medium text-text">Commission parties</CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted">
            Agents, brokers and referral partners who bring us business from this customer. Linking here is the same
            link that appears on the commission party&apos;s own page.
          </p>
          <LinkedCompaniesManager
            ownerId={companyId}
            side="company"
            links={commissionParties.map((p) => ({ linkId: p.linkId, id: p.id, companySeq: p.companySeq, name: p.name }))}
            companyOptions={partyOptions}
            emptyText="No commission party linked to this customer yet."
            searchPlaceholder="Type to search commission parties…"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
          <span>Commission paid on this account</span>
          <span className="text-sm font-semibold text-text">{formatCurrency(totalPaid)}</span>
        </CardHeader>
        <CardContent className={commissions.length === 0 ? undefined : "p-0"}>
          {commissions.length === 0 ? (
            <p className="text-sm text-subtle">
              No commission has been recorded against this customer&apos;s orders. Commission is captured as an
              expense when an order is punched.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 px-5 py-3">
                {[...byParty.entries()].map(([key, party]) => (
                  <Badge key={key} tone="brand">
                    {party.name}: {formatCurrency(party.total)} · {party.count} payout(s)
                  </Badge>
                ))}
              </div>
              <table className="w-full text-sm">
                <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-5 py-2">Order</th>
                    <th className="px-3 py-2">Paid to</th>
                    <th className="px-3 py-2">Account</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2">Recorded</th>
                    <th className="px-3 py-2">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {commissions.map((commission) => (
                    <tr key={commission.id} className="border-b border-line last:border-0">
                      <td className="px-5 py-2">
                        <Link href={orderPath(commission.order.orderSeq)} className="font-mono text-xs text-text hover:underline">
                          {formatOrderId(commission.order.orderSeq)}
                        </Link>
                        <div className="text-xs text-subtle">{commission.order.itemName}</div>
                      </td>
                      <td className="px-3 py-2">
                        {commission.payee ? (
                          <Link href={companyPath(commission.payee.companySeq)} className="text-text hover:underline">
                            {commission.payee.name}
                          </Link>
                        ) : (
                          <span className="text-subtle">Not recorded</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted">
                        {commission.payeeAccount
                          ? commission.payeeAccount.label
                          : <span className="text-subtle">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-text">{formatCurrency(commission.amount)}</td>
                      <td className="px-3 py-2 text-muted">{clock.date(commission.createdAt)}</td>
                      <td className="px-3 py-2 text-subtle">{commission.notes ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
