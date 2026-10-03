import Link from "next/link";
import { notFound } from "next/navigation";
import { getVendorCredit } from "@/actions/vendor-credit";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { VendorCreditSettle } from "@/components/rebates/vendor-credit-form";
import { CancelVendorCreditButton, RemoveSettlementButton } from "@/components/rebates/vendor-credit-actions";
import { formatCurrency } from "@/lib/utils";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { formatOrderId } from "@/lib/order-id";

const KIND_LABEL = { REBATE: "Backend rebate", PRICE_DIFFERENCE: "Bill above the deal price", OTHER: "Other" } as const;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** One vendor credit: its amounts, its posting, and what it is set against. */
export default async function VendorCreditPage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("payables");
  if (!enabled) return <ModuleDisabledNotice moduleKey="payables" />;
  const { id } = await params;
  const data = await getVendorCredit(id);
  if (!data) notFound();
  const { credit, canManage } = data;
  const clock = await workspaceClock();
  const allocated = round2(credit.allocations.reduce((t, a) => t + Number(a.amount), 0));
  const applied = round2(credit.applications.reduce((t, a) => t + Number(a.amount), 0));
  const live = !credit.cancelledAt;

  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">
            <Link href="/purchase/vendor-credits" className="hover:underline">
              Vendor credits
            </Link>
          </p>
          <h1 className="text-xl font-semibold text-text">
            {credit.reference}{" "}
            <Badge tone={credit.form === "PAYOUT" ? "green" : "blue"}>{credit.form === "PAYOUT" ? "Payout" : "Credit note"}</Badge>{" "}
            {credit.cancelledAt && <Badge tone="red">Cancelled</Badge>}
          </h1>
          <p className="mt-1 text-sm text-muted">
            From{" "}
            <Link href={`/companies/${credit.vendor.id}`} className="hover:underline">
              {credit.vendor.name}
            </Link>{" "}
            on {formatCalendarDay(credit.date)} · {KIND_LABEL[credit.kind]}
            {credit.bankAccount ? ` · into ${credit.bankAccount.name}` : ""}
          </p>
        </div>
        {canManage && live && <CancelVendorCreditButton id={credit.id} />}
      </div>

      {credit.cancelledAt && (
        <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
          Cancelled {clock.dateTime(credit.cancelledAt)}
          {credit.cancelledBy ? ` by ${credit.cancelledBy.name}` : ""}: {credit.cancelReason}
        </p>
      )}

      <Card>
        <CardContent className="grid grid-cols-2 gap-3 pt-5 text-sm sm:grid-cols-4">
          <div>
            <p className="text-xs text-subtle">Before GST</p>
            <p className="font-medium text-text">{formatCurrency(Number(credit.taxableAmount))}</p>
          </div>
          <div>
            <p className="text-xs text-subtle">GST</p>
            <p className="text-text">
              {formatCurrency(round2(Number(credit.cgstAmount) + Number(credit.sgstAmount) + Number(credit.igstAmount)))}
            </p>
          </div>
          <div>
            <p className="text-xs text-subtle">Total</p>
            <p className="font-medium text-text">{formatCurrency(Number(credit.total))}</p>
          </div>
          <div>
            <p className="text-xs text-subtle">Posted</p>
            <p className="text-text">
              {credit.journalEntries.length === 0
                ? "—"
                : credit.journalEntries.map((e, i) => (
                    <span key={e.id}>
                      {i > 0 ? ", " : ""}
                      <Link href={`/accounting/journal?q=${encodeURIComponent(e.entryNumber)}`} className="hover:underline">
                        {e.entryNumber}
                      </Link>
                      {e.reversesId ? " (reversal)" : ""}
                    </span>
                  ))}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">
          Set against orders&apos; rebates — {formatCurrency(allocated)} of {formatCurrency(Number(credit.taxableAmount))}
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {credit.allocations.length === 0 && <p className="text-muted">Nothing yet.</p>}
          {credit.allocations.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2 last:border-0">
              <span>
                <Link href={`/orders/${a.orderRebate.companyProduct.id}`} className="font-medium text-text hover:underline">
                  {formatOrderId(a.orderRebate.companyProduct.orderSeq)}
                </Link>{" "}
                <span className="text-muted">
                  {a.orderRebate.companyProduct.company.name} · {a.orderRebate.companyProduct.item.name}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums text-text">{formatCurrency(Number(a.amount))}</span>
                {canManage && live && <RemoveSettlementButton kind="allocation" id={a.id} />}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      {credit.form === "CREDIT_NOTE" && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">
            Set against {credit.vendor.name}&apos;s bills — {formatCurrency(applied)} of {formatCurrency(Number(credit.total))}
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {credit.applications.length === 0 && <p className="text-muted">Nothing yet — until it is, it waits on their account.</p>}
            {credit.applications.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2 last:border-0">
                <Link href={`/documents/${a.bill.id}`} className="font-medium text-text hover:underline">
                  {a.bill.docNumber}
                </Link>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums text-text">{formatCurrency(Number(a.amount))}</span>
                  {canManage && live && <RemoveSettlementButton kind="application" id={a.id} />}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {canManage && live && (
        <VendorCreditSettle
          credit={{
            id: credit.id,
            vendorId: credit.vendor.id,
            form: credit.form,
            rebateRoom: round2(Number(credit.taxableAmount) - allocated),
            billRoom: round2(Number(credit.total) - applied),
          }}
        />
      )}

      {credit.notes && <p className="text-sm text-muted">{credit.notes}</p>}
      <p className="text-xs text-subtle">
        Recorded {clock.dateTime(credit.createdAt)}
        {credit.createdBy ? ` by ${credit.createdBy.name}` : ""}
      </p>
    </div>
  );
}
