"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Banknote, Plus } from "lucide-react";
import { recordBillPayment } from "@/actions/payable";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { formatRate, isBaseCurrency } from "@/lib/currency";
import { formatCalendarDay } from "@/lib/time/zone";
import { useClock } from "@/components/time/clock-provider";
import { ReceiptRateHint } from "@/components/documents/invoice-settlement";

/**
 * Paying a vendor bill.
 *
 * `recordBillPayment` has existed, complete and correct, with no caller anywhere in the app — so a
 * bill could be raised and aged and chased and never settled. Every bill ever entered stayed at
 * ISSUED, `/payables` kept showing the full amount owed and aged it into the 90+ bucket, and the
 * Accounts Payable ledger account was credited on every bill and never debited back down, so the
 * balance sheet overstated liabilities by everything the company had ever actually paid.
 *
 * Deliberately the mirror of the invoice panel opposite: the same three figures in the same order,
 * because somebody who has learnt one side should not have to learn the other.
 */

const METHODS = [
  { value: "BANK_TRANSFER", label: "Bank transfer" },
  { value: "UPI", label: "UPI" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "CASH", label: "Cash" },
  { value: "CARD", label: "Card" },
  { value: "OTHER", label: "Other" },
] as const;

export type BillSettlement = {
  /** The bill's own currency — every figure here is in it. Absent reads as rupees. */
  currency?: string;
  /** The rate the bill was booked at, which a foreign payment's rate is measured against. */
  exchangeRate?: number;
  total: number;
  paid: number;
  credited: number;
  balance: number;
  payments: {
    id: string;
    amount: number | string;
    payment: { id: string; paidOn: string | Date; method: string; reference: string | null } | null;
  }[];
  /** A distributor's or an OEM's credit notes set against it (src/actions/vendor-credit.ts) — part of "Credited". */
  vendorCredits?: { id: string; amount: number | string; vendorCredit: { id: string; reference: string; date: string | Date } }[];
};

export function BillSettlementPanel({
  billId,
  settlement,
  canRecord,
}: {
  billId: string;
  settlement: BillSettlement;
  canRecord: boolean;
}) {
  const router = useRouter();
  const clock = useClock();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currency = settlement.currency ?? "INR";
  const foreign = !isBaseCurrency(currency);
  const bookedAt = settlement.exchangeRate ?? 1;
  const money = (value: number | string | null | undefined) => formatCurrency(value, currency);
  const [form, setForm] = useState({
    // Pre-filled with what is actually outstanding, which is the amount in all but the rare case.
    amount: settlement.balance > 0 ? String(settlement.balance) : "",
    // A foreign bill: the rate the money went out at, the bill's own until somebody says otherwise.
    rate: String(bookedAt),
    // Today in the workspace's zone, not in UTC's, which can be a day either side of it.
    paidOn: clock.today(),
    method: "BANK_TRANSFER" as (typeof METHODS)[number]["value"],
    reference: "",
  });

  function save() {
    setBusy(true);
    setError(null);
    startTransition(async () => {
      const result = await recordBillPayment({
        billId,
        amount: form.amount,
        paidOn: form.paidOn,
        method: form.method,
        reference: form.reference || undefined,
        ...(foreign ? { exchangeRate: form.rate } : {}),
      });
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-text">
          <Banknote className="h-4 w-4 text-muted" />
          Paid to vendor
        </span>
        <span className={settlement.balance > 0 ? "text-sm font-medium text-danger" : "text-sm text-success"}>
          {settlement.balance > 0 ? `${money(settlement.balance)} outstanding` : "Settled in full"}
        </span>
      </CardHeader>

      <CardContent className="space-y-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-subtle">Billed</dt>
            <dd className="tabular-nums text-text">{money(settlement.total)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-subtle">Paid</dt>
            <dd className="tabular-nums text-text">{money(settlement.paid)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-subtle">Credited</dt>
            <dd className="tabular-nums text-text">{money(settlement.credited)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-subtle">Balance</dt>
            <dd className="tabular-nums font-medium text-text">{money(settlement.balance)}</dd>
          </div>
        </dl>

        {settlement.payments.length > 0 && (
          <ul className="divide-y divide-line border-t border-line pt-1 text-sm">
            {settlement.payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="text-muted">
                  {p.payment ? formatCalendarDay(p.payment.paidOn) : "—"}
                  {p.payment?.reference && <span className="ml-2 text-subtle">{p.payment.reference}</span>}
                </span>
                <span className="tabular-nums text-text">{money(Number(p.amount))}</span>
              </li>
            ))}
          </ul>
        )}

        {settlement.vendorCredits && settlement.vendorCredits.length > 0 && (
          <ul className="divide-y divide-line border-t border-line pt-1 text-sm">
            {settlement.vendorCredits.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="text-muted">
                  Credit note{" "}
                  <a href={`/purchase/vendor-credits/${c.vendorCredit.id}`} className="underline">
                    {c.vendorCredit.reference}
                  </a>
                  <span className="ml-2 text-subtle">{formatCalendarDay(c.vendorCredit.date)}</span>
                </span>
                <span className="tabular-nums text-text">{money(Number(c.amount))}</span>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}

        {canRecord && settlement.balance > 0 && !open && (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" />
            Record a payment
          </Button>
        )}

        {open && (
          <div className="space-y-3 rounded-base border border-line bg-surface-sunken p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="bill-amount">{foreign ? `Amount paid (${currency})` : "Amount"}</Label>
                <Input
                  id="bill-amount"
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </div>
              {foreign && (
                <div className="space-y-1">
                  <Label htmlFor="bill-rate">Rate on the day (₹ per {currency})</Label>
                  <Input
                    id="bill-rate"
                    inputMode="decimal"
                    value={form.rate}
                    onChange={(e) => setForm({ ...form, rate: e.target.value })}
                  />
                </div>
              )}
              {foreign && (
                <div className="sm:col-span-2">
                  <p className="mb-1 text-xs text-subtle">The bill was booked at {formatRate(bookedAt)}.</p>
                  <ReceiptRateHint amount={form.amount} rate={form.rate} documentRate={bookedAt} currency={currency} receivable={false} />
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="bill-paid-on">Paid on</Label>
                <Input
                  id="bill-paid-on"
                  type="date"
                  value={form.paidOn}
                  onChange={(e) => setForm({ ...form, paidOn: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bill-method">Method</Label>
                <Select
                  id="bill-method"
                  value={form.method}
                  onChange={(e) => setForm({ ...form, method: e.target.value as typeof form.method })}
                >
                  {METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="bill-reference">Reference</Label>
                <Input
                  id="bill-reference"
                  value={form.reference}
                  onChange={(e) => setForm({ ...form, reference: e.target.value })}
                  placeholder="UTR, cheque number…"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={busy || !form.amount || !form.paidOn}>
                {busy ? "Recording…" : "Record payment"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
