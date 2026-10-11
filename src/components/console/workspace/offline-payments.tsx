"use client";

import { useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { consoleRecordOfflinePayment, consoleVoidOfflinePayment } from "@/actions/platform/console-offline";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { PLATFORM_GST_PERCENT, withPlatformGst } from "@/lib/billing/platform-gst";
import type { OfflineMethodKey } from "@/lib/console-shared/types";
import type { OfflineFormOptions } from "@/lib/platform/workspace-data";

/**
 * Recording a payment no gateway took (src/lib/billing/offline.ts) — a bank transfer, a cheque, a
 * distributor paying for its customer — and voiding one recorded by mistake. The form works out what
 * the price list says the period costs, GST included, beside the amount received, so a short payment
 * is seen before it is saved; the server checks everything again.
 */

const METHODS: { value: OfflineMethodKey; label: string }[] = [
  { value: "NEFT", label: "NEFT" },
  { value: "RTGS", label: "RTGS" },
  { value: "IMPS", label: "IMPS" },
  { value: "UPI", label: "UPI" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "CASH", label: "Cash" },
  { value: "OTHER", label: "Other" },
];

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const todayInIndia = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

type Row = { planKey: string; quantity: string };

export function RecordPaymentButton({ tenantId, options }: { tenantId: string; options: OfflineFormOptions }) {
  const id = useId();
  const action = useConsoleAction<{ periodEnd: Date | string; taxNumber: string | null }>();
  const [open, setOpen] = useState(false);
  const start = (): Row[] => (options.current.length ? options.current.map((c) => ({ planKey: c.planKey, quantity: String(c.quantity) })) : [{ planKey: options.plans[0]?.key ?? "", quantity: "1" }]);
  const [rows, setRows] = useState<Row[]>(start);
  const [interval, setBilledInterval] = useState<"MONTH" | "YEAR">("YEAR");
  const [periods, setPeriods] = useState("1");
  const [startsOn, setStartsOn] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<OfflineMethodKey>("NEFT");
  const [reference, setReference] = useState("");
  const [receivedOn, setReceivedOn] = useState(todayInIndia);
  const [partnerId, setPartnerId] = useState("");
  const [note, setNote] = useState("");

  // What the price list says, before and with GST — null while a plan has no price at this interval.
  const count = Math.max(0, Math.floor(Number(periods) || 0));
  const priced = rows.map((r) => {
    const plan = options.plans.find((p) => p.key === r.planKey);
    const unit = plan ? (interval === "YEAR" ? plan.yearly : plan.monthly) : null;
    const qty = Math.max(0, Math.floor(Number(r.quantity) || 0));
    return unit === null ? null : unit * qty * count;
  });
  const subtotal = priced.every((p) => p !== null) ? priced.reduce<number>((sum, p) => sum + (p ?? 0), 0) : null;
  const listTotal = subtotal === null ? null : withPlatformGst(subtotal);
  const typed = Number(amount.replace(/[,\s₹]/g, ""));
  const typedPaise = Number.isFinite(typed) && typed > 0 ? Math.round(typed * 100) : null;
  const short = listTotal !== null && typedPaise !== null && typedPaise < listTotal;

  function openForm() {
    action.reset();
    setRows(start());
    setBilledInterval("YEAR");
    setPeriods("1");
    setStartsOn("");
    setAmount("");
    setMethod("NEFT");
    setReference("");
    setReceivedOn(todayInIndia());
    setPartnerId("");
    setNote("");
    setOpen(true);
  }

  function save() {
    const form = {
      tenantId,
      items: rows.map((r) => ({ planKey: r.planKey, quantity: Number(r.quantity) })),
      interval,
      periods: Number(periods),
      startsOn,
      amount,
      method,
      reference,
      receivedOn,
      partnerId,
      note,
    };
    action.run(() => consoleRecordOfflinePayment(form), {
      success: (d) => `Payment recorded — paid until ${new Date(d.periodEnd).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" })}${d.taxNumber ? `, tax invoice ${d.taxNumber}` : " (its tax invoice waits for the seller's details in Settings › Invoicing)"}.`,
      onDone: () => setOpen(false),
    });
  }

  if (!options.plans.length) {
    return <p className="text-xs text-muted">No plan has a price in rupees yet — add prices in Plans first.</p>;
  }
  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={openForm}>
        <Plus aria-hidden="true" className="h-4 w-4" />
        Record a payment
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Record a payment"
        wide
        confirmLabel="Record payment"
        pending={action.pending}
        error={action.error}
        confirmDisabled={!rows.length || rows.some((r) => !r.planKey || !(Number(r.quantity) >= 1)) || !(count >= 1) || typedPaise === null || !receivedOn || (method !== "CASH" && !reference.trim())}
        onConfirm={save}
      >
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-text">What it pays for</legend>
          {rows.map((r, i) => {
            const plan = options.plans.find((p) => p.key === r.planKey);
            return (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <Label htmlFor={`${id}-plan-${i}`} className="sr-only">
                    Plan {i + 1}
                  </Label>
                  <Select id={`${id}-plan-${i}`} value={r.planKey} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, planKey: e.target.value } : x)))}>
                    {options.plans.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name}
                        {p.kind === "ADDON" ? " (add-on)" : ""}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="w-28 space-y-1">
                  <Label htmlFor={`${id}-qty-${i}`} className="text-xs text-muted">
                    {plan?.perSeat ? "People" : "Quantity"}
                  </Label>
                  <Input id={`${id}-qty-${i}`} inputMode="numeric" value={r.quantity} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value.replace(/\D/g, "").slice(0, 5) } : x)))} className="tabular-nums" />
                </div>
                {rows.length > 1 && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove ${plan?.name ?? "this plan"}`}>
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </Button>
                )}
              </div>
            );
          })}
          {rows.length < 10 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setRows([...rows, { planKey: options.plans[0]!.key, quantity: "1" }])}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add a plan or add-on
            </Button>
          )}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-interval`}>Billed</Label>
            <Select id={`${id}-interval`} value={interval} onChange={(e) => setBilledInterval(e.target.value === "MONTH" ? "MONTH" : "YEAR")}>
              <option value="YEAR">Yearly</option>
              <option value="MONTH">Monthly</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-periods`}>{interval === "YEAR" ? "Years" : "Months"}</Label>
            <Input id={`${id}-periods`} inputMode="numeric" value={periods} onChange={(e) => setPeriods(e.target.value.replace(/\D/g, "").slice(0, 2))} className="tabular-nums" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-starts`}>From</Label>
            <Input id={`${id}-starts`} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
            <p className="text-[11px] text-muted">{options.paidUntil ? "Empty: straight on from what is paid already." : "Empty: from today."}</p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-amount`}>Amount received (₹, GST included)</Label>
            <Input id={`${id}-amount`} inputMode="decimal" placeholder={listTotal !== null ? (listTotal / 100).toFixed(2) : "0.00"} value={amount} onChange={(e) => setAmount(e.target.value.slice(0, 16))} className="tabular-nums" />
            <p className={short ? "text-[11px] text-warning" : "text-[11px] text-muted"}>
              {listTotal === null
                ? `A plan here has no ${interval === "YEAR" ? "yearly" : "monthly"} price in rupees.`
                : `Price list: ${rupees(listTotal)} (${rupees(subtotal!)} + ${PLATFORM_GST_PERCENT}% GST)${short ? " — less than the price list; the invoice shows the difference as a discount." : "."}`}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-received`}>Received on</Label>
            <Input id={`${id}-received`} type="date" value={receivedOn} max={todayInIndia()} onChange={(e) => setReceivedOn(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-method`}>How</Label>
            <Select id={`${id}-method`} value={method} onChange={(e) => setMethod(e.target.value as OfflineMethodKey)}>
              {METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-reference`}>{method === "CHEQUE" ? "Cheque number" : method === "CASH" ? "Receipt number (optional)" : "UTR / reference"}</Label>
            <Input id={`${id}-reference`} value={reference} maxLength={80} autoComplete="off" onChange={(e) => setReference(e.target.value)} className="font-mono" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${id}-payer`}>Paid by</Label>
            <Select id={`${id}-payer`} value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
              <option value="">The workspace itself</option>
              {options.partners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.kind.toLowerCase()})
                </option>
              ))}
            </Select>
            <p className="text-[11px] text-muted">A distributor paying for its customer is billed: the tax invoice is made out to it, naming this workspace as the end user.</p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${id}-note`}>Note (staff only)</Label>
            <Textarea id={`${id}-note`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <p className="text-sm text-muted">It is paid until the period ends; its paid invoice and GST tax invoice are made and mailed now, and a trial ends.</p>
      </ConfirmDialog>
    </>
  );
}

/** Voiding a payment recorded by mistake: its period comes off, and its tax invoice is credited. */
export function VoidPaymentButton({ paymentId, summary }: { paymentId: string; summary: string }) {
  const action = useConsoleAction<null>();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-danger hover:text-danger"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        Void
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Void this payment"
        tone="danger"
        confirmLabel="Void payment"
        pending={action.pending}
        error={action.error}
        reason={{ label: "Why (kept in the platform's log)", minLength: 3, maxLength: 500, placeholder: "Recorded twice" }}
        onConfirm={({ reason }) => action.run(() => consoleVoidOfflinePayment(paymentId, reason), { success: "Payment voided; its tax invoice is credited.", onDone: () => setOpen(false) })}
      >
        <p>
          <span className="font-medium">{summary}</span> is voided — never deleted. The period it paid for comes off the paid-until date, and its tax invoice gets a credit note.
        </p>
      </ConfirmDialog>
    </>
  );
}
