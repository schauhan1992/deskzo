"use client";

import { useId, useState, useTransition } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { allocatePaymentSchema, type AllocatePaymentInput } from "@/lib/validation/payment";
import { allocatePayment, listCompanyOrdersForPayment } from "@/actions/payment";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils";
import { formatOrderId } from "@/lib/order-id";

type OrderOption = Awaited<ReturnType<typeof listCompanyOrdersForPayment>>[number];
type FormValues = z.input<typeof allocatePaymentSchema>;

export type UnallocatedPayment = {
  id: string;
  unallocated: number;
  company: { id: string; name: string };
};

export function AllocatePaymentButton({ payment }: { payment: UnallocatedPayment }) {
  const router = useRouter();
  // One of these buttons sits on every unallocated payment row, so the field ids have to be unique
  // per instance — a fixed "amount" would repeat down the page and point every label at row one.
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [orders, setOrders] = useState<OrderOption[] | null>(null);
  const [ordersPending, startOrdersTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, AllocatePaymentInput>({
    resolver: zodResolver(allocatePaymentSchema),
    defaultValues: { paymentId: payment.id },
  });

  function openDialog() {
    setOpen(true);
    setServerError(null);
    startOrdersTransition(async () => {
      setOrders(await listCompanyOrdersForPayment(payment.company.id));
    });
  }

  async function onSubmit(values: AllocatePaymentInput) {
    setServerError(null);
    const result = await allocatePayment({ ...values, paymentId: payment.id });
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={openDialog}>
        Allocate
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Allocate payment — ${payment.company.name}`}>
        <p className="mb-2 text-sm text-muted">
          {formatCurrency(String(payment.unallocated))} unallocated. Apply some or all of it to an order.
        </p>
        {ordersPending && <p className="text-sm text-subtle">Loading orders…</p>}
        {!ordersPending && (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-2">
            {serverError && <p className="text-xs text-danger">{serverError}</p>}
            <div className="space-y-1">
              <Label className="text-xs" htmlFor={`${fieldId}-order`}>Order</Label>
              <Select id={`${fieldId}-order`} {...register("companyProductId")}>
                <option value="">Select an order…</option>
                {orders?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {formatOrderId(o.orderSeq)} · {o.item.name} — due {formatCurrency(String(Math.max(o.balance, 0)))}
                  </option>
                ))}
              </Select>
              {errors.companyProductId && <p className="text-xs text-danger">{errors.companyProductId.message}</p>}
              {orders?.length === 0 && <p className="text-xs text-subtle">This company has no orders yet.</p>}
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor={`${fieldId}-amount`}>Amount to allocate</Label>
              <Input
                id={`${fieldId}-amount`}
                type="number"
                min={0.01}
                step="0.01"
                max={payment.unallocated}
                {...register("amount")}
              />
              {errors.amount && <p className="text-xs text-danger">{errors.amount.message}</p>}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isSubmitting || orders?.length === 0}>
                {isSubmitting ? "Allocating…" : "Allocate"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
