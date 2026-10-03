"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createVendorCredit, settleVendorCredit, vendorCreditOptions } from "@/actions/vendor-credit";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { CompanyCombobox } from "@/components/ui/company-combobox";
import { formatCurrency } from "@/lib/utils";

type Options = NonNullable<Awaited<ReturnType<typeof vendorCreditOptions>>>;
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: string) => (v.trim() === "" ? 0 : Number(v));

/**
 * What a credit is set against: the issuer's orders' rebates still due, and — a credit note — its open
 * bills. Amounts are typed per line; "Fill oldest first" spreads what is left across them in order.
 */
function SettlementPicker({
  options,
  form,
  rebateRoom,
  billRoom,
  allocations,
  applications,
  setAllocations,
  setApplications,
}: {
  options: Options;
  form: "CREDIT_NOTE" | "PAYOUT";
  rebateRoom: number;
  billRoom: number;
  allocations: Record<string, string>;
  applications: Record<string, string>;
  setAllocations: (v: Record<string, string>) => void;
  setApplications: (v: Record<string, string>) => void;
}) {
  function fill<T extends { outstanding?: number; balance?: number }>(rows: (T & { key: string })[], room: number) {
    const out: Record<string, string> = {};
    let left = round2(room);
    for (const r of rows) {
      const due = r.outstanding ?? r.balance ?? 0;
      const take = round2(Math.min(due, left));
      if (take <= 0) break;
      out[r.key] = String(take);
      left = round2(left - take);
    }
    return out;
  }
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
          <span>Set against orders&apos; rebates</span>
          {options.rebates.length > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setAllocations(fill(options.rebates.map((r) => ({ ...r, key: r.orderRebateId })), rebateRoom))}>
              Fill oldest first
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {options.rebates.length === 0 ? (
            <p className="text-muted">No rebate is due from {options.vendor.name} on any order.</p>
          ) : (
            options.rebates.map((r) => (
              <div key={r.orderRebateId} className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2 last:border-0">
                <div className="min-w-0">
                  <a href={`/orders/${r.orderLabel}`} className="font-medium text-text hover:underline">
                    {r.orderLabel}
                  </a>{" "}
                  <span className="text-muted">
                    {r.customer} · {r.item}
                  </span>
                  <p className="text-xs text-subtle">
                    Expected {formatCurrency(r.expected)} · received {formatCurrency(r.received)} · still to come {formatCurrency(r.outstanding)}
                  </p>
                </div>
                <Input
                  aria-label={`Amount against ${r.orderLabel}'s rebate`}
                  className="w-32"
                  type="number"
                  step="0.01"
                  min={0}
                  max={r.outstanding}
                  value={allocations[r.orderRebateId] ?? ""}
                  onChange={(e) => setAllocations({ ...allocations, [r.orderRebateId]: e.target.value })}
                />
              </div>
            ))
          )}
          <p className="text-xs text-subtle">Up to {formatCurrency(rebateRoom)} — the amount before GST — goes against rebates.</p>
        </CardContent>
      </Card>

      {form === "CREDIT_NOTE" && (
        <Card>
          <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
            <span>Set against {options.vendor.name}&apos;s bills</span>
            {options.bills.length > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setApplications(fill(options.bills.map((b) => ({ ...b, key: b.id })), billRoom))}>
                Fill oldest first
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {options.bills.length === 0 ? (
              <p className="text-muted">No open rupee bill from {options.vendor.name}.</p>
            ) : (
              options.bills.map((b) => (
                <div key={b.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2 last:border-0">
                  <div>
                    <a href={`/documents/${b.id}`} className="font-medium text-text hover:underline">
                      {b.docNumber}
                    </a>{" "}
                    <span className="text-muted">owes {formatCurrency(b.balance)}</span>
                  </div>
                  <Input
                    aria-label={`Amount against ${b.docNumber}`}
                    className="w-32"
                    type="number"
                    step="0.01"
                    min={0}
                    max={b.balance}
                    value={applications[b.id] ?? ""}
                    onChange={(e) => setApplications({ ...applications, [b.id]: e.target.value })}
                  />
                </div>
              ))
            )}
            <p className="text-xs text-subtle">What is set against a bill comes off what we owe on it. Up to {formatCurrency(billRoom)}.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const picked = (rows: Record<string, string>) =>
  Object.entries(rows)
    .map(([id, v]) => ({ id, amount: num(v) }))
    .filter((r) => Number.isFinite(r.amount) && r.amount > 0);

/** Recording a credit note or a payout from a distributor or an OEM. */
export function VendorCreditForm({ issuers, today }: { issuers: { id: string; name: string }[]; today: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState("");
  const [form, setForm] = useState<"CREDIT_NOTE" | "PAYOUT">("CREDIT_NOTE");
  const [kind, setKind] = useState<"REBATE" | "PRICE_DIFFERENCE" | "OTHER">("REBATE");
  const [reference, setReference] = useState("");
  const [date, setDate] = useState(today);
  const [taxable, setTaxable] = useState("");
  const [tax, setTax] = useState<{ cgst: string; sgst: string; igst: string }>({ cgst: "", sgst: "", igst: "" });
  const [bankAccountId, setBankAccountId] = useState("");
  const [notes, setNotes] = useState("");
  const [options, setOptions] = useState<Options | null>(null);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [applications, setApplications] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!vendorId) return;
    let cancelled = false;
    vendorCreditOptions(vendorId).then((o) => {
      if (!cancelled) setOptions(o);
    });
    return () => {
      cancelled = true;
    };
  }, [vendorId]);

  const total = useMemo(() => round2(num(taxable) + num(tax.cgst) + num(tax.sgst) + num(tax.igst)), [taxable, tax]);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await createVendorCredit({
        vendorId,
        form,
        kind,
        reference,
        date,
        taxableAmount: taxable,
        cgstAmount: tax.cgst,
        sgstAmount: tax.sgst,
        igstAmount: tax.igst,
        bankAccountId: form === "PAYOUT" ? bankAccountId : "",
        notes,
        allocations: picked(allocations).map((r) => ({ orderRebateId: r.id, amount: r.amount })),
        applications: form === "CREDIT_NOTE" ? picked(applications).map((r) => ({ billId: r.id, amount: r.amount })) : [],
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/purchase/vendor-credits/${result.data.id}`);
    });
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      <Card>
        <CardContent className="space-y-3 pt-5 text-sm">
          <div className="space-y-1">
            <Label htmlFor="vc-vendor">From</Label>
            <CompanyCombobox id="vc-vendor" companies={issuers} value={vendorId} onSelect={(c) => {
                // A new issuer: what the last one could be set against no longer applies.
                setVendorId(c?.id ?? "");
                setOptions(null);
                setAllocations({});
                setApplications({});
              }}
              placeholder="The distributor or the OEM…"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="vc-form">It came as</Label>
              <Select id="vc-form" value={form} onChange={(e) => setForm(e.target.value as "CREDIT_NOTE" | "PAYOUT")}>
                <option value="CREDIT_NOTE">A credit note — what we owe them goes down</option>
                <option value="PAYOUT">Money paid into our bank</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="vc-kind">For</Label>
              <Select id="vc-kind" value={kind} onChange={(e) => setKind(e.target.value as "REBATE" | "PRICE_DIFFERENCE" | "OTHER")}>
                <option value="REBATE">A backend rebate</option>
                <option value="PRICE_DIFFERENCE">A bill above the deal price</option>
                <option value="OTHER">Something else</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="vc-date">Date</Label>
              <Input id="vc-date" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="vc-ref">{form === "CREDIT_NOTE" ? "Their credit note number" : "The payment's reference"}</Label>
              <Input id="vc-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
            {form === "PAYOUT" && options && (
              <div className="space-y-1">
                <Label htmlFor="vc-bank">Into</Label>
                <Select id="vc-bank" value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
                  <option value="">The default bank</option>
                  {options.banks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="vc-taxable">Before GST</Label>
              <Input id="vc-taxable" type="number" step="0.01" min={0} value={taxable} onChange={(e) => setTaxable(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="vc-cgst">CGST</Label>
              <Input id="vc-cgst" type="number" step="0.01" min={0} value={tax.cgst} onChange={(e) => setTax({ ...tax, cgst: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="vc-sgst">SGST</Label>
              <Input id="vc-sgst" type="number" step="0.01" min={0} value={tax.sgst} onChange={(e) => setTax({ ...tax, sgst: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="vc-igst">IGST</Label>
              <Input id="vc-igst" type="number" step="0.01" min={0} value={tax.igst} onChange={(e) => setTax({ ...tax, igst: e.target.value })} />
            </div>
          </div>
          <p className="text-xs text-subtle">
            A financial credit note has no GST — leave the tax blank. GST on a credit note reverses the input tax we took on
            the purchase. Total: <span className="font-medium text-text">{formatCurrency(total)}</span>
          </p>
          <div className="space-y-1">
            <Label htmlFor="vc-notes">Notes</Label>
            <Textarea id="vc-notes" placeholder="Quarter, scheme…" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {options && (
        <SettlementPicker
          options={options}
          form={form}
          rebateRoom={num(taxable)}
          billRoom={total}
          allocations={allocations}
          applications={applications}
          setAllocations={setAllocations}
          setApplications={setApplications}
        />
      )}

      <div className="flex justify-end">
        <Button type="button" disabled={isPending || !vendorId || !reference.trim() || !taxable} onClick={submit}>
          {isPending ? "Recording…" : "Record and post"}
        </Button>
      </div>
    </div>
  );
}

/** Setting more of a recorded credit against rebates or bills. */
export function VendorCreditSettle({
  credit,
}: {
  credit: { id: string; vendorId: string; form: "CREDIT_NOTE" | "PAYOUT"; rebateRoom: number; billRoom: number };
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Options | null>(null);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [applications, setApplications] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    vendorCreditOptions(credit.vendorId).then((o) => {
      if (!cancelled) setOptions(o);
    });
    return () => {
      cancelled = true;
    };
  }, [open, credit.vendorId]);

  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Set more against rebates or bills
      </Button>
    );
  }
  return (
    <div className="space-y-3">
      {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      {!options ? (
        <p className="text-sm text-muted">Loading what it can be set against…</p>
      ) : (
        <SettlementPicker
          options={options}
          form={credit.form}
          rebateRoom={credit.rebateRoom}
          billRoom={credit.billRoom}
          allocations={allocations}
          applications={applications}
          setAllocations={setAllocations}
          setApplications={setApplications}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={isPending}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={isPending || !options}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await settleVendorCredit({
                vendorCreditId: credit.id,
                allocations: picked(allocations).map((r) => ({ orderRebateId: r.id, amount: r.amount })),
                applications: picked(applications).map((r) => ({ billId: r.id, amount: r.amount })),
              });
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setOpen(false);
              setAllocations({});
              setApplications({});
              router.refresh();
            });
          }}
        >
          {isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
