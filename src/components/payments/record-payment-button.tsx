"use client";

import { useId, useState, useTransition } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { recordPaymentSchema, type RecordPaymentInput } from "@/lib/validation/payment";
import { recordPayment, listCompanyOrdersForPayment } from "@/actions/payment";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils";
import { paymentMethodValues, paymentMethodLabels } from "@/lib/gst";
import { formatOrderId } from "@/lib/order-id";

type CompanyOption = { id: string; name: string };

type OrderOption = Awaited<ReturnType<typeof listCompanyOrdersForPayment>>[number];

type FormValues = z.input<typeof recordPaymentSchema>;

const MAX_RESULTS = 20;

export function RecordPaymentButton({
  companies,
  canRecord,
}: {
  companies: CompanyOption[];
  canRecord: boolean;
}) {
  const router = useRouter();
  // This button sits on list pages and on a company's own page, so two dialogs can be mounted at
  // once. Literal ids would collide and point both labels at whichever form mounted first.
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"company" | "order" | "form">("company");
  const [companyQuery, setCompanyQuery] = useState("");
  const [selectedCompany, setSelectedCompany] = useState<CompanyOption | null>(null);
  const [orders, setOrders] = useState<OrderOption[] | null>(null);
  const [ordersPending, startOrdersTransition] = useTransition();
  const [selectedOrder, setSelectedOrder] = useState<OrderOption | null>(null);
  const [lumpSum, setLumpSum] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, RecordPaymentInput>({
    resolver: zodResolver(recordPaymentSchema),
    defaultValues: { method: "BANK_TRANSFER", paidOn: new Date().toISOString().slice(0, 10) },
  });

  if (!canRecord) return null;

  function reopen() {
    setOpen(true);
    setCompanyQuery("");
    setOrders(null);
    setSelectedOrder(null);
    setLumpSum(false);
    setServerError(null);
    // Opened from a company's own page there's only ever one choice, so don't make them pick it.
    if (companies.length === 1) {
      pickCompany(companies[0]);
      return;
    }
    setStep("company");
    setSelectedCompany(null);
  }

  function close() {
    setOpen(false);
  }

  function pickCompany(company: CompanyOption) {
    setSelectedCompany(company);
    setStep("order");
    startOrdersTransition(async () => {
      const result = await listCompanyOrdersForPayment(company.id);
      setOrders(result);
    });
  }

  function pickOrder(order: OrderOption | null) {
    setSelectedOrder(order);
    setLumpSum(order === null);
    setStep("form");
    reset({
      companyId: selectedCompany!.id,
      allocateToOrderId: order?.id ?? "",
      method: "BANK_TRANSFER",
      paidOn: new Date().toISOString().slice(0, 10),
    });
  }

  async function onSubmit(values: RecordPaymentInput) {
    setServerError(null);
    const result = await recordPayment({ ...values, companyId: selectedCompany!.id });
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  const trimmed = companyQuery.trim().toLowerCase();
  const companyResults = (
    trimmed ? companies.filter((c) => c.name.toLowerCase().includes(trimmed)) : companies
  ).slice(0, MAX_RESULTS);

  return (
    <>
      <Button type="button" size="sm" onClick={reopen}>
        + Record payment
      </Button>

      <Dialog
        open={open}
        onClose={close}
        title={
          step === "company"
            ? "Record payment — select a company"
            : step === "order"
              ? `Record payment — ${selectedCompany?.name}`
              : `Record payment — ${selectedCompany?.name}`
        }
      >
        {step === "company" && (
          <div>
            <Input
              autoFocus
              value={companyQuery}
              onChange={(e) => setCompanyQuery(e.target.value)}
              placeholder="Search company…"
              aria-label="Search companies"
            />
            <div className="mt-2 max-h-80 space-y-1 overflow-y-auto">
              {companyResults.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => pickCompany(c)}
                  className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-text hover:bg-surface-sunken"
                >
                  {c.name}
                </button>
              ))}
              {companyResults.length === 0 && (
                <div className="px-3 py-2 text-sm text-subtle">No matching companies.</div>
              )}
            </div>
          </div>
        )}

        {step === "order" && (
          <div>
            <p className="mb-2 text-sm text-muted">
              Which order is this payment for? Or record it as a lump sum and align it to an order later.
            </p>
            {ordersPending && <p className="text-sm text-subtle">Loading orders…</p>}
            {!ordersPending && (
              <div className="max-h-80 space-y-1 overflow-y-auto">
                {orders?.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => pickOrder(o)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-surface-sunken"
                  >
                    <span className="min-w-0">
                      <span className="font-mono text-xs text-subtle">{formatOrderId(o.orderSeq)}</span>{" "}
                      <span className="font-medium text-text">{o.item.name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-muted">
                      {formatCurrency(String(Math.max(o.balance, 0)))} due
                      <Badge tone={o.status === "paid" ? "green" : o.status === "partial" ? "amber" : "red"}>
                        {o.status === "paid" ? "Paid" : o.status === "partial" ? "Partially paid" : "Unpaid"}
                      </Badge>
                    </span>
                  </button>
                ))}
                {orders?.length === 0 && (
                  <p className="px-3 py-2 text-sm text-subtle">This company has no orders yet.</p>
                )}
                <button
                  type="button"
                  onClick={() => pickOrder(null)}
                  className="mt-1 block w-full rounded-md border-t border-line px-3 py-2 text-left text-sm font-medium text-text hover:bg-surface-sunken"
                >
                  Record as a lump sum — don&apos;t apply to an order yet
                </button>
              </div>
            )}
            <div className="mt-3 flex justify-start">
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep("company")}>
                ← Back
              </Button>
            </div>
          </div>
        )}

        {step === "form" && (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-2">
            <div className="rounded-md bg-surface-sunken p-2 text-sm text-muted">
              {lumpSum ? (
                <>Unapplied lump sum for {selectedCompany?.name} — align it to an order later from the Payments list.</>
              ) : (
                <>
                  Applying to {formatOrderId(selectedOrder!.orderSeq)} · {selectedOrder!.item.name} — balance{" "}
                  {formatCurrency(String(Math.max(selectedOrder!.balance, 0)))}
                </>
              )}
            </div>
            {serverError && <p className="text-xs text-danger">{serverError}</p>}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor={`${fieldId}-amount`} className="text-xs">
                  Amount
                </Label>
                <Input
                  id={`${fieldId}-amount`}
                  type="number"
                  min={0.01}
                  step="0.01"
                  {...register("amount")}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${fieldId}-paid-on`} className="text-xs">
                  Date received
                </Label>
                <Input id={`${fieldId}-paid-on`} type="date" {...register("paidOn")} />
              </div>
            </div>
            {errors.amount && <p className="text-xs text-danger">{errors.amount.message}</p>}
            {errors.paidOn && <p className="text-xs text-danger">{errors.paidOn.message}</p>}
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-method`} className="text-xs">
                Method
              </Label>
              <Select id={`${fieldId}-method`} {...register("method")}>
                {paymentMethodValues.map((m) => (
                  <option key={m} value={m}>
                    {paymentMethodLabels[m]}
                  </option>
                ))}
              </Select>
            </div>
            {/* No caption sits above these two, so the name has to travel on the control itself. */}
            <Input
              aria-label="Reference"
              placeholder="Reference (UTR / cheque no. / txn id — optional)"
              {...register("reference")}
            />
            <Input aria-label="Notes" placeholder="Notes (optional)" {...register("notes")} />
            <div className="flex justify-between pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep("order")}>
                ← Back
              </Button>
              <Button type="submit" size="sm" disabled={isSubmitting}>
                {isSubmitting ? "Recording…" : "Record payment"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
