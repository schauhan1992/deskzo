"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  recordInvoicePayment,
  applyCreditNote,
  removeCreditNoteApplication,
  getInvoiceSettlement,
  listOpenInvoices,
  getCreditNoteBalance,
} from "@/actions/receivable";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/utils";
import { paymentMethodValues, paymentMethodLabels } from "@/lib/gst";

type Settlement = NonNullable<Awaited<ReturnType<typeof getInvoiceSettlement>>>;
type CreditNote = { id: string; docNumber: string; total: number; remaining: number };

/**
 * What's been settled against an invoice and what's left. This is the panel the whole accounting
 * change exists for: before it, an invoice had no notion of being paid — money was tracked against
 * the order that produced it.
 */
export function InvoiceSettlementPanel({
  invoiceId,
  settlement,
  availableCredits,
  canRecord,
  canRemove,
}: {
  invoiceId: string;
  settlement: Settlement;
  /** Issued credit notes for this customer with an unapplied balance. */
  availableCredits: CreditNote[];
  canRecord: boolean;
  canRemove: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);

  const [amount, setAmount] = useState(settlement.balance.toFixed(2));
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  const [creditNoteId, setCreditNoteId] = useState("");
  const [creditAmount, setCreditAmount] = useState("");

  const selectedCredit = availableCredits.find((c) => c.id === creditNoteId);
  const settled = settlement.balance < 0.01;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      after?.();
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>Payments &amp; credits</span>
        {settled ? (
          <Badge tone="green">Settled in full</Badge>
        ) : (
          <span className="text-sm">
            <span className="text-muted">Balance due </span>
            <span className="font-semibold text-danger">{formatCurrency(settlement.balance)}</span>
          </span>
        )}
      </CardHeader>
      <CardContent className="@container space-y-4">
        <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
          <Figure label="Invoiced" value={formatCurrency(settlement.total)} />
          <Figure label="Received" value={formatCurrency(settlement.paid)} tone="success" />
          <Figure label="Credited" value={formatCurrency(settlement.credited)} tone="warning" />
          <Figure label="Balance" value={formatCurrency(settlement.balance)} tone={settled ? undefined : "danger"} />
        </div>

        {canRecord && !settled && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                setAmount(settlement.balance.toFixed(2));
                setPayOpen(true);
              }}
            >
              Record payment
            </Button>
            {availableCredits.length > 0 && (
              <Button size="sm" variant="secondary" onClick={() => setCreditOpen(true)}>
                Apply credit note
              </Button>
            )}
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        {(settlement.payments.length > 0 || settlement.credits.length > 0) && (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2">Applied</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Reference</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {settlement.payments.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2">
                      <Badge tone="green">Payment</Badge>
                    </td>
                    <td className="px-3 py-2 text-muted">{formatDate(p.payment.paidOn)}</td>
                    <td className="px-3 py-2 text-muted">
                      {p.payment.reference ?? paymentMethodLabels[p.payment.method as keyof typeof paymentMethodLabels]}
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-text">{formatCurrency(p.amount)}</td>
                    <td className="px-3 py-2" />
                  </tr>
                ))}
                {settlement.credits.map((c) => (
                  <tr key={c.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2">
                      <Badge tone="amber">Credit note</Badge>
                    </td>
                    <td className="px-3 py-2 text-muted">{formatDate(c.creditNote.issueDate)}</td>
                    <td className="px-3 py-2">
                      <Link href={`/documents/${c.creditNote.id}`} className="font-mono text-xs text-text hover:underline">
                        {c.creditNote.docNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-text">{formatCurrency(c.amount)}</td>
                    <td className="px-3 py-2 text-right">
                      {canRemove && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger hover:bg-danger-bg hover:text-danger"
                          disabled={pending}
                          onClick={() => run(() => removeCreditNoteApplication(c.id))}
                        >
                          Remove
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <Dialog open={payOpen} onClose={() => setPayOpen(false)} title="Record payment">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {formatCurrency(settlement.balance)} outstanding on this invoice.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="payAmount">Amount</Label>
              <Input
                id="payAmount"
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="paidOn">Received on</Label>
              <Input id="paidOn" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="method">Method</Label>
              <Select id="method" value={method} onChange={(e) => setMethod(e.target.value)}>
                {paymentMethodValues.map((m) => (
                  <option key={m} value={m}>
                    {paymentMethodLabels[m]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reference">Reference</Label>
              <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="payNotes">Notes</Label>
              <Textarea id="payNotes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button
              disabled={pending || !amount}
              onClick={() =>
                run(
                  () => recordInvoicePayment({ invoiceId, amount, paidOn, method, reference, notes }),
                  () => setPayOpen(false),
                )
              }
            >
              {pending ? "Saving…" : "Record payment"}
            </Button>
            <Button variant="secondary" onClick={() => setPayOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={creditOpen} onClose={() => setCreditOpen(false)} title="Apply a credit note">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="creditNoteId">Credit note</Label>
            <Select
              id="creditNoteId"
              value={creditNoteId}
              onChange={(e) => {
                setCreditNoteId(e.target.value);
                const credit = availableCredits.find((c) => c.id === e.target.value);
                // Default to whichever is smaller — the credit left, or what's still owed.
                setCreditAmount(credit ? Math.min(credit.remaining, settlement.balance).toFixed(2) : "");
              }}
            >
              <option value="">Select…</option>
              {availableCredits.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.docNumber} — {formatCurrency(c.remaining)} available
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="creditAmount">Amount to apply</Label>
            <Input
              id="creditAmount"
              type="number"
              step="0.01"
              min="0"
              value={creditAmount}
              onChange={(e) => setCreditAmount(e.target.value)}
            />
            {selectedCredit && (
              <p className="text-xs text-subtle">
                {formatCurrency(selectedCredit.remaining)} unapplied on this credit note ·{" "}
                {formatCurrency(settlement.balance)} outstanding here.
              </p>
            )}
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button
              disabled={pending || !creditNoteId || !creditAmount}
              onClick={() =>
                run(
                  () => applyCreditNote({ creditNoteId, invoiceId, amount: creditAmount }),
                  () => {
                    setCreditOpen(false);
                    setCreditNoteId("");
                    setCreditAmount("");
                  },
                )
              }
            >
              {pending ? "Applying…" : "Apply credit"}
            </Button>
            <Button variant="secondary" onClick={() => setCreditOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: "danger" | "success" | "warning" }) {
  const toneClass =
    tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-text";
  return (
    <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className={`mt-0.5 text-base font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

/** The mirror on a credit note: how much is left, and where it's been applied. */
export function CreditNoteApplications({
  balance,
  openInvoices,
  creditNoteId,
  canRecord,
}: {
  balance: NonNullable<Awaited<ReturnType<typeof getCreditNoteBalance>>>;
  openInvoices: Awaited<ReturnType<typeof listOpenInvoices>>;
  creditNoteId: string;
  canRecord: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState("");

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>Applied to invoices</span>
        <span className="text-sm">
          <span className="text-muted">Unapplied </span>
          <span className="font-semibold text-text">{formatCurrency(balance.remaining)}</span>
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {balance.applications.length === 0 ? (
          <p className="text-sm text-subtle">
            Not applied to anything yet — the full {formatCurrency(balance.total)} is sitting on the customer&apos;s
            account.
          </p>
        ) : (
          <div className="space-y-1.5 text-sm">
            {balance.applications.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3">
                <Link href={`/documents/${a.invoice.id}`} className="font-mono text-xs text-text hover:underline">
                  {a.invoice.docNumber}
                </Link>
                <span className="text-muted">{formatDate(a.invoice.issueDate)}</span>
                <span className="font-medium text-text">{formatCurrency(a.amount)}</span>
              </div>
            ))}
          </div>
        )}

        {canRecord && balance.remaining > 0.01 && openInvoices.length > 0 && (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)} disabled={pending}>
            Apply to an invoice
          </Button>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </CardContent>

      <Dialog open={open} onClose={() => setOpen(false)} title="Apply this credit note">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="targetInvoice">Invoice</Label>
            <Select
              id="targetInvoice"
              value={invoiceId}
              onChange={(e) => {
                setInvoiceId(e.target.value);
                // Default to whichever is smaller — the credit left, or what that invoice still owes.
                const invoice = openInvoices.find((i) => i.id === e.target.value);
                setAmount(invoice ? Math.min(balance.remaining, invoice.balance).toFixed(2) : "");
              }}
            >
              <option value="">Select an open invoice…</option>
              {openInvoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.docNumber} — {formatCurrency(i.balance)} due
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="applyAmount">Amount</Label>
            <Input
              id="applyAmount"
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button
              disabled={pending || !invoiceId || !amount}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await applyCreditNote({ creditNoteId, invoiceId, amount });
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setOpen(false);
                  setInvoiceId("");
                  router.refresh();
                });
              }}
            >
              {pending ? "Applying…" : "Apply"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
