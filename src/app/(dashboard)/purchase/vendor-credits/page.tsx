import Link from "next/link";
import { listVendorCredits } from "@/actions/vendor-credit";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";

/**
 * Vendor credits (owner, 1 Oct 2026): what distributors and OEMs have given back — credit notes
 * against what we owe them, and rebates paid into the bank — with how much of each is set against
 * orders' rebates and their bills. src/actions/vendor-credit.ts. `rebates.view` only.
 */
export default async function VendorCreditsPage() {
  const enabled = await isModuleEnabled("payables");
  if (!enabled) return <ModuleDisabledNotice moduleKey="payables" />;
  const data = await listVendorCredits();
  if (!data) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Vendor credits</h1>
        <p className="mt-2 text-sm text-muted">This is for whoever can see backend rebates.</p>
      </div>
    );
  }
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Vendor credits</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Credit notes and payouts from distributors and OEMs — backend rebates, and bills that missed the deal price.
            Each posts to the books when recorded, and is set against the orders&apos; rebates it settles and, a credit note,
            the issuer&apos;s open bills.
          </p>
        </div>
        {data.canManage && (
          <Link href="/purchase/vendor-credits/new">
            <Button size="sm">Record a credit</Button>
          </Link>
        )}
      </div>
      <Card className="mt-5 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="sr-only">Vendor credits</caption>
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Reference</th>
              <th className="px-4 py-2.5">From</th>
              <th className="px-4 py-2.5">Date</th>
              <th className="px-4 py-2.5 text-right">Total</th>
              <th className="px-4 py-2.5 text-right">On rebates</th>
              <th className="px-4 py-2.5 text-right">On bills</th>
            </tr>
          </thead>
          <tbody>
            {data.credits.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted">
                  None recorded yet.
                </td>
              </tr>
            )}
            {data.credits.map((c) => (
              <tr key={c.id} className={`border-b border-line last:border-0 ${c.cancelledAt ? "text-subtle line-through" : ""}`}>
                <td className="px-4 py-2.5">
                  <Link href={`/purchase/vendor-credits/${c.id}`} className="font-medium text-text hover:underline">
                    {c.reference}
                  </Link>{" "}
                  <Badge tone={c.form === "PAYOUT" ? "green" : "blue"}>{c.form === "PAYOUT" ? "Payout" : "Credit note"}</Badge>
                </td>
                <td className="px-4 py-2.5 text-muted">{c.vendor.name}</td>
                <td className="px-4 py-2.5 text-muted">{formatCalendarDay(c.date)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-text">{formatCurrency(Number(c.total))}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-text">{formatCurrency(c.allocated)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-text">{c.form === "CREDIT_NOTE" ? formatCurrency(c.applied) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
