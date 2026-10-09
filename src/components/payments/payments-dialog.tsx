"use client";

import { useId, useState, useTransition } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { recordPaymentSchema, type RecordPaymentInput } from "@/lib/validation/payment";
import { recordPayment, deleteAllocation } from "@/actions/payment";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { useClock } from "@/components/time/clock-provider";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { calculateOrderAmount, getPaymentStatus, paymentMethodValues, paymentMethodLabels } from "@/lib/gst";
import { formatOrderId } from "@/lib/order-id";

export type AllocationRow = {
  id: string;
  amount: unknown;
  allocatedBy: { id: string; name: string };
  payment: { id: string; paidOn: Date | string; method: string; reference: string | null };
};

export type PayableOrder = {
  id: string;
  orderSeq: number;
  quantity: number;
  unitPrice?: unknown;
  item: { name: string; sellingPrice: unknown; taxRatePercent: unknown };
  allocations: AllocationRow[];
};

type FormValues = z.input<typeof recordPaymentSchema>;

export function PaymentsDialog({
  order,
  open,
  onClose,
  canRecord,
  canDelete,
  companyId,
  companyName,
}: {
  order: PayableOrder | null;
  open: boolean;
  onClose: () => void;
  canRecord: boolean;
  canDelete: boolean;
  companyId: string;
  companyName?: string;
}) {
  const router = useRouter();
  const clock = useClock();
  // A dialog can be mounted once per order on a page of orders, so the ids are generated rather
  // than written — two "Amount" labels pointing at one box is worse than no label at all.
  const fieldId = useId();
  const [serverError, setServerError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [allocationError, setAllocationError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, RecordPaymentInput>({
    resolver: zodResolver(recordPaymentSchema),
    defaultValues: {
      companyId,
      allocateToOrderId: order?.id ?? "",
      method: "BANK_TRANSFER",
      paidOn: clock.today(),
    },
  });

  if (!order) {
    return null;
  }

  const { total } = calculateOrderAmount({
    quantity: order.quantity,
    unitPrice: Number(order.unitPrice ?? order.item.sellingPrice),
    taxRatePercent: order.item.taxRatePercent ? Number(order.item.taxRatePercent) : null,
  });
  const paid = order.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
  const balance = Math.round((total - paid) * 100) / 100;
  const status = getPaymentStatus(total, paid);

  async function onSubmit(values: RecordPaymentInput) {
    setServerError(null);
    const result = await recordPayment({ ...values, companyId, allocateToOrderId: order!.id });
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    reset({
      companyId,
      allocateToOrderId: order!.id,
      method: "BANK_TRANSFER",
      amount: undefined,
      paidOn: clock.today(),
      reference: "",
      notes: "",
    });
    router.refresh();
  }

  function handleDeleteAllocation(allocationId: string, amount: number) {
    /**
     * Confirmed, and the refusal reported.
     *
     * Un-applying money is not an edit — it detaches a receipt from the thing it paid for, moves the
     * order back to unpaid and the payment back to unallocated, and there is no undo. It went on one
     * click, and the result was discarded, so a refusal looked exactly like a success while the row
     * stayed on screen until the next refresh.
     */
    if (!window.confirm(`Un-apply ${formatCurrency(amount)} from this order? The payment stays on file but stops covering it.`)) {
      return;
    }
    setDeletingId(allocationId);
    setAllocationError(null);
    startTransition(async () => {
      const result = await deleteAllocation(allocationId);
      setDeletingId(null);
      if (!result.ok) {
        setAllocationError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Payments — ${formatOrderId(order.orderSeq)}`}>
      <div className="space-y-4">
        {allocationError && (
          <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{allocationError}</p>
        )}
        <div className="rounded-md bg-surface-sunken p-3 text-sm">
          <div className="font-medium text-text">
            {order.item.name}
            {companyName ? ` · ${companyName}` : ""}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted">
            <span>Total {formatCurrency(String(total))}</span>
            <span>Paid {formatCurrency(String(paid))}</span>
            <span>Balance {formatCurrency(String(balance))}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
        </div>

        <div className="space-y-2">
          {order.allocations.length === 0 && <p className="text-sm text-subtle">No payments applied yet.</p>}
          {order.allocations.map((a) => (
            <div key={a.id} className="flex items-start justify-between text-sm">
              <div>
                <div className="font-medium text-text">
                  {formatCurrency(String(a.amount))} ·{" "}
                  {paymentMethodLabels[a.payment.method as keyof typeof paymentMethodLabels] ?? a.payment.method}
                </div>
                <div className="text-muted">
                  {formatCalendarDay(a.payment.paidOn)}
                  {a.payment.reference ? ` · Ref: ${a.payment.reference}` : ""} · Applied by {a.allocatedBy.name}
                </div>
              </div>
              {canDelete && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-danger hover:bg-danger-bg hover:text-danger"
                  disabled={isPending && deletingId === a.id}
                  onClick={() => handleDeleteAllocation(a.id, Number(a.amount))}
                >
                  Un-apply
                </Button>
              )}
            </div>
          ))}
        </div>

        {canRecord && (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-2 rounded-md border border-line p-3">
            <p className="text-xs font-medium text-text">Record a new payment for this order</p>
            {serverError && <p className="text-xs text-danger">{serverError}</p>}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="min-w-0 space-y-1">
                <Label htmlFor={`${fieldId}-amount`} className="text-xs">
                  Amount
                </Label>
                <Input id={`${fieldId}-amount`} type="number" min={0.01} step="0.01" {...register("amount")} />
              </div>
              <div className="min-w-0 space-y-1">
                <Label htmlFor={`${fieldId}-paidOn`} className="text-xs">
                  Date received
                </Label>
                <Input id={`${fieldId}-paidOn`} type="date" {...register("paidOn")} />
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
            {/* These two have no caption above them, only the placeholder — which goes as soon as anything is typed. */}
            <Input
              aria-label="Reference"
              placeholder="Reference (UTR / cheque no. / txn id — optional)"
              {...register("reference")}
            />
            <Input aria-label="Notes" placeholder="Notes (optional)" {...register("notes")} />
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={isSubmitting}>
                {isSubmitting ? "Recording…" : "Record payment"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
