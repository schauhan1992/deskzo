import Link from "next/link";
import { remindersPausedFor } from "@/actions/payment-collection";
import { collectionConfig, msmeClaims } from "@/lib/collect/settings";
import { interestForCompany } from "@/lib/collect/msme";
import { can } from "@/lib/authz/resolve";
import { requireUser } from "@/lib/session";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ReminderPauseControl } from "@/components/collect/reminder-pause-control";
import { ChargeInterestButton } from "@/components/collect/charge-interest-button";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { formatMoney } from "@/lib/currency";
import { formatCalendarDay } from "@/lib/time/zone";
import { documentPath } from "@/lib/trade-documents";

/**
 * Above a customer's statement (owner, 23 Oct 2026 — src/lib/collect): whether they get payment reminders,
 * with the switch to pause them, and — for a micro or small business — the MSMED Act interest their late
 * payments have run up, with the summary for an MSME Samadhaan complaint.
 */
export async function StatementCollectPanel({ companyId, companyRef }: { companyId: string; companyRef: string }) {
  const user = await requireUser();
  const [pause, config, seesMoney] = await Promise.all([remindersPausedFor(companyId), collectionConfig(), can(user.id, "payments.view")]);
  if (!config.migrated) return null;
  const rows = seesMoney && msmeClaims(config) ? await interestForCompany(companyId, config.bankRate!) : [];
  // Charging it is raising a debit note: for whoever may raise sales documents, where the plan has them.
  const mayCharge = rows.length > 0 && (await can(user.id, "documents.issue")) && (await moduleAvailableForTenant("sales_documents"));
  const total = rows.reduce((t, r) => t + r.interest, 0);

  return (
    <div className="space-y-4">
      <ReminderPauseControl companyId={companyId} paused={pause.paused} reason={pause.reason} on={pause.on} mayChange={pause.mayChange} />
      {rows.length > 0 && (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
            <span>
              MSME interest on late payments — {formatMoney(total, "INR")} at {rows[0]!.rate}% a year
            </span>
            <Link href={`/receivables/msme/${companyRef}`} className="text-sm font-normal text-brand hover:underline">
              Summary for MSME Samadhaan
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="px-4 py-2 font-medium">Invoice</th>
                    <th className="px-4 py-2 font-medium">Last day to pay</th>
                    <th className="px-4 py-2 font-medium">Days late</th>
                    <th className="px-4 py-2 font-medium">Still unpaid</th>
                    <th className="px-4 py-2 text-right font-medium">Interest</th>
                    {mayCharge && (
                      <th className="px-4 py-2 font-medium">
                        <span className="sr-only">Charge it</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.invoiceId} className="border-b border-line last:border-0">
                      <td className="px-4 py-2">
                        <Link href={documentPath(r.invoiceId)} className="text-brand hover:underline">
                          {r.docNumber ?? "—"}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-muted">{formatCalendarDay(r.lastDay)}</td>
                      <td className="px-4 py-2 text-muted">{r.days}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-text">{r.unpaid > 0 ? formatMoney(r.unpaid, "INR") : "Paid late"}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right text-text">{formatMoney(r.interest, "INR")}</td>
                      {mayCharge && (
                        <td className="px-4 py-2 text-right">
                          <ChargeInterestButton invoiceId={r.invoiceId} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-3 text-xs text-muted">
              Compound interest with monthly rests at three times the RBI bank rate, under section 16 of the MSMED Act — shown, not billed. Charge drafts a debit note for it, with GST at the invoice&apos;s rate, for you to check and issue.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
