"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload, X } from "lucide-react";
import { createExpense, updateExpense } from "@/actions/expense";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import {
  expenseCategoryValues,
  expenseCategoryLabels,
  expensePaymentModeValues,
  expensePaymentModeLabels,
  MAX_RECEIPT_BYTES,
  ALLOWED_RECEIPT_TYPES,
} from "@/lib/expenses";
import { formatVisitId } from "@/lib/visits";
import { CompanyCombobox } from "@/components/ui/company-combobox";

export type ExpenseFormDefaults = {
  id?: string;
  category: string;
  amount: string;
  taxAmount: string;
  spentOn: string;
  description: string;
  paymentMode: string;
  reimbursable: boolean;
  visitId: string;
  companyId: string;
  leadId: string;
  receiptName: string;
};

export function ExpenseForm({
  companies,
  visit,
  defaults,
}: {
  companies: { id: string; name: string }[];
  /** Set when the claim is being raised from a visit — the company then comes from the visit. */
  visit: { id: string; visitSeq: number; companyName: string } | null;
  defaults: ExpenseFormDefaults;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const receiptInput = useRef<HTMLInputElement>(null);

  const [category, setCategory] = useState(defaults.category);
  const [amount, setAmount] = useState(defaults.amount);
  const [taxAmount, setTaxAmount] = useState(defaults.taxAmount);
  const [spentOn, setSpentOn] = useState(defaults.spentOn);
  const [description, setDescription] = useState(defaults.description);
  const [paymentMode, setPaymentMode] = useState(defaults.paymentMode);
  const [reimbursable, setReimbursable] = useState(defaults.reimbursable);
  const [companyId, setCompanyId] = useState(defaults.companyId);
  const [receiptDataUrl, setReceiptDataUrl] = useState("");
  const [receiptName, setReceiptName] = useState(defaults.receiptName);

  function attach(file: File) {
    setError(null);
    if (!ALLOWED_RECEIPT_TYPES.includes(file.type)) {
      setError("Attach a PNG, JPEG, WebP or PDF receipt.");
      return;
    }
    if (file.size > MAX_RECEIPT_BYTES) {
      setError("That receipt is over 512KB — use a smaller file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setReceiptDataUrl(String(reader.result));
      setReceiptName(file.name);
    };
    reader.readAsDataURL(file);
  }

  function submit(andSubmit: boolean) {
    setError(null);
    const payload = {
      ...(defaults.id ? { id: defaults.id } : {}),
      category,
      amount,
      taxAmount,
      spentOn,
      description,
      paymentMode,
      reimbursable,
      visitId: visit?.id ?? defaults.visitId,
      companyId: visit ? "" : companyId,
      leadId: defaults.leadId,
      receiptDataUrl,
      receiptName,
      ...(defaults.id ? {} : { submit: andSubmit }),
    };
    startTransition(async () => {
      const result = defaults.id ? await updateExpense(payload) : await createExpense(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/expenses/${result.data.id}`);
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(true);
      }}
      className="animate-fade-rise space-y-5"
    >
      <Card>
        <CardHeader className="text-sm font-medium text-text">What was spent</CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="category">Category</Label>
            <Select id="category" value={category} onChange={(e) => setCategory(e.target.value)}>
              {expenseCategoryValues.map((c) => (
                <option key={c} value={c}>
                  {expenseCategoryLabels[c]}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="amount">Amount</Label>
            <Input
              id="amount"
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="taxAmount">Of which tax</Label>
            <Input
              id="taxAmount"
              type="number"
              step="0.01"
              min="0"
              value={taxAmount}
              onChange={(e) => setTaxAmount(e.target.value)}
            />
            <p className="text-xs text-subtle">Optional — tracked separately where input credit can be claimed.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="spentOn">Spent on</Label>
            <Input id="spentOn" type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} required />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="paymentMode">Paid by</Label>
            <Select id="paymentMode" value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)}>
              {expensePaymentModeValues.map((m) => (
                <option key={m} value={m}>
                  {expensePaymentModeLabels[m]}
                </option>
              ))}
            </Select>
          </div>

          <label className="flex items-center gap-2 self-end pb-2 text-sm text-text">
            <input
              type="checkbox"
              checked={reimbursable}
              onChange={(e) => setReimbursable(e.target.checked)}
              className="h-4 w-4 accent-[var(--brand)]"
            />
            Reimburse me for this
          </label>

          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label htmlFor="description">What it was for</Label>
            <Textarea
              id="description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Cab to client office and back"
              required
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">What it was against</CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {visit ? (
            <div className="sm:col-span-2 rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm">
              Claimed against visit{" "}
              <span className="font-mono text-xs">{formatVisitId(visit.visitSeq)}</span> — {visit.companyName}.
              <span className="block text-xs text-subtle">The company comes from the visit.</span>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="companyId">Company</Label>
              <CompanyCombobox
                id="companyId"
                companies={companies}
                value={companyId}
                onSelect={(company) => setCompanyId(company?.id ?? "")}
                placeholder="Type to search — or leave blank"
              />
              <p className="text-xs text-subtle">
                Leave blank for general business spend — office supplies, subscriptions, and so on.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Receipt</Label>
            <div className="flex items-center gap-3">
              <input
                ref={receiptInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) attach(file);
                  e.target.value = "";
                }}
              />
              <Button type="button" variant="secondary" size="sm" onClick={() => receiptInput.current?.click()}>
                <Upload className="h-3.5 w-3.5" /> Attach
              </Button>
              {receiptName ? (
                <span className="flex items-center gap-1 text-sm text-muted">
                  {receiptName}
                  <button
                    type="button"
                    aria-label="Remove receipt"
                    className="text-subtle hover:text-danger"
                    onClick={() => {
                      setReceiptDataUrl("");
                      setReceiptName("");
                    }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ) : (
                <span className="text-xs text-subtle">PNG, JPEG, WebP or PDF, up to 512KB.</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-base border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !amount || !description.trim()}>
          {pending ? "Saving…" : defaults.id ? "Save changes" : "Submit for approval"}
        </Button>
        {!defaults.id && (
          <Button type="button" variant="secondary" disabled={pending} onClick={() => submit(false)}>
            Save as draft
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={() => router.push(defaults.id ? `/expenses/${defaults.id}` : "/expenses")}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
