"use client";

import { useWording } from "@/components/terms/wording-provider";
import { statusSlot } from "@/lib/terms/dictionary";
import { useId, useState, useTransition } from "react";
import type { z } from "zod";
import type { PaymentTerms, OrderStatus, OrderBusinessType } from "@prisma/client";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { updateCompanyProductSchema, type UpdateCompanyProductInput } from "@/lib/validation/company-product";
import { removeCompanyProduct, updateCompanyProduct } from "@/actions/company";
import { IndianRupee, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { PaymentsDialog, type PayableOrder } from "@/components/payments/payments-dialog";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { useClock } from "@/components/time/clock-provider";
import { getRenewalStatus } from "@/lib/renewals";
import { formatOrderId } from "@/lib/order-id";
import { companyPath, orderPath } from "@/lib/record-links";
import { calculateOrderAmount, getPaymentStatus, paymentTermsLabels } from "@/lib/gst";
import { orderBusinessTypeLabels } from "@/lib/validation/order";
import { AddSeatsDialog } from "@/components/orders/add-seats-dialog";

type ItemOption = { id: string; name: string; sku: string; type: string; unit: string | null; sellingPrice: unknown };
type LocationOption = { id: string; label: string; isPrimary: boolean };
type VendorOption = { id: string; name: string; paymentTerms: PaymentTerms };

const ORDER_STATUS_TONE: Record<OrderStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  PENDING_APPROVAL: "amber",
  APPROVED: "blue",
  REJECTED: "red",
  PROCESSING: "blue",
  FULFILLED: "green",
  CANCELLED: "default",
};

const BUSINESS_TYPE_TONE: Record<OrderBusinessType, "default" | "green" | "blue" | "red" | "amber"> = {
  NEW: "green",
  RENEWAL: "blue",
  NEW_TO_US_RENEWAL: "amber",
  ADDON: "default",
};

type Product = PayableOrder & {
  notes: string | null;
  poNumber: string | null;
  startDate: Date | string | null;
  endDate: Date | string | null;
  createdAt: Date | string;
  orderStatus: OrderStatus;
  businessType: OrderBusinessType;
  addedBy: { id: string; name: string };
  /** Set on extra seats, pointing at the subscription they co-terminate with. */
  parentId?: string | null;
  /** Live addons hanging off this subscription, for the combined seat count. */
  addons?: { id: string; quantity: number; startDate: Date | string | null; unitPrice: string | number | null }[];
  location: { id: string; label: string; gstNumber: string | null; state: string | null };
  vendor: { id: string; companySeq: number; name: string; paymentTerms: PaymentTerms } | null;
  item: PayableOrder["item"] & { id: string; sku: string; type: string; unit: string | null };
  /** Set on a reseller's own rows: the customer this was bought for. */
  endCustomer?: { id: string; companySeq: number; name: string } | null;
  /** Set on an end customer's rows: the reseller who placed and pays for it. */
  company?: { id: string; companySeq: number; name: string };
};

type EditFormValues = z.input<typeof updateCompanyProductSchema>;

/** A typed day as stored (midnight UTC) back into a date input: its UTC date is the day, in any zone. */
function toDateInputValue(d: Date | string | null) {
  if (!d) return "";
  return new Date(d).toISOString().slice(0, 10);
}

function EditProductForm({
  product,
  locations,
  columnCount,
  onClose,
}: {
  product: Product;
  locations: LocationOption[];
  columnCount: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const isSubscription = product.item.type === "SUBSCRIPTION";
  // This form is rendered into whichever product row is being edited, so the ids are per-mount.
  const id = useId();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EditFormValues, unknown, UpdateCompanyProductInput>({
    resolver: zodResolver(updateCompanyProductSchema),
    defaultValues: {
      id: product.id,
      locationId: product.location.id,
      quantity: product.quantity,
      notes: product.notes ?? "",
      poNumber: product.poNumber ?? "",
      startDate: toDateInputValue(product.startDate),
      endDate: toDateInputValue(product.endDate),
    },
  });

  async function onSubmit(values: UpdateCompanyProductInput) {
    setServerError(null);
    const result = await updateCompanyProduct(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <tr className="border-b border-line bg-surface-sunken last:border-0">
      <td colSpan={columnCount} className="p-3">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-2 rounded-md border border-line bg-surface p-3">
          {serverError && <p className="text-xs text-danger">{serverError}</p>}
          <div className="text-sm font-medium text-text">
            {formatOrderId(product.orderSeq)} · {product.item.name}
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor={`${id}-location`}>
              Location
            </Label>
            <Select id={`${id}-location`} {...register("locationId")}>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.label}
                </option>
              ))}
            </Select>
            {errors.locationId && <p className="text-xs text-danger">{errors.locationId.message}</p>}
          </div>
          {/* These three carry a placeholder instead of a label, and a placeholder is gone the moment
              somebody types — so they are named outright rather than paired with a caption. */}
          <div className="flex gap-2">
            <Input
              type="number"
              min={1}
              placeholder="Qty"
              aria-label="Quantity"
              className="w-24"
              {...register("quantity")}
            />
            <Input
              placeholder="PO / Invoice number (optional)"
              aria-label="PO / Invoice number"
              {...register("poNumber")}
            />
          </div>
          <Input placeholder="Notes (optional)" aria-label="Notes" {...register("notes")} />
          {errors.quantity && <p className="text-xs text-danger">{errors.quantity.message}</p>}
          {isSubscription && (
            <div className="grid grid-cols-2 gap-2 rounded-md bg-surface-sunken p-2">
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={`${id}-start-date`}>
                  Start date
                </Label>
                <Input id={`${id}-start-date`} type="date" {...register("startDate")} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={`${id}-end-date`}>
                  Expiry date
                </Label>
                <Input id={`${id}-end-date`} type="date" {...register("endDate")} />
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </td>
    </tr>
  );
}

export function CompanyProductsList({
  companyId,
  companyName,
  products,
  items,
  locations,
  canEdit,
  canDelete,
  canRecordPayments,
  canDeletePayments,
  canAddSeats = true,
}: {
  /** Renewals are in the workspace's plan and this person may raise seats (`orders.process`), as `createAddon` decides it. */
  canAddSeats?: boolean;
  companyId: string;
  companyName: string;
  products: Product[];
  items: ItemOption[];
  locations: LocationOption[];
  vendors: VendorOption[];
  canEdit: boolean;
  canDelete: boolean;
  canRecordPayments: boolean;
  canDeletePayments: boolean;
}) {
  const router = useRouter();
  // The workspace's own names for the statuses (Settings → Wording).
  const wording = useWording();
  const clock = useClock();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [paymentsTargetId, setPaymentsTargetId] = useState<string | null>(null);
  const paymentsTarget = products.find((p) => p.id === paymentsTargetId) ?? null;
  const [isPending, startTransition] = useTransition();
  const showActionsColumn = canEdit || canDelete || canRecordPayments || canDeletePayments;
  const columnCount = 10 + (showActionsColumn ? 1 : 0);

  function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    startTransition(async () => {
      await removeCompanyProduct(id);
      setDeleteTarget(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2.5">Order ID</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Product</th>
              <th className="px-3 py-2.5">Vendor</th>
              <th className="px-3 py-2.5">Qty</th>
              <th className="px-3 py-2.5">PO / Invoice #</th>
              <th className="px-3 py-2.5">Total (incl. GST)</th>
              <th className="px-3 py-2.5">Payment</th>
              <th className="px-3 py-2.5">Renewal</th>
              <th className="px-3 py-2.5">Added by</th>
              {showActionsColumn && <th className="px-3 py-2.5 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const status = p.item.type === "SUBSCRIPTION" ? getRenewalStatus(p.endDate) : null;
              const { subtotal, gstAmount, total } = calculateOrderAmount({
                quantity: p.quantity,
                unitPrice: Number(p.unitPrice ?? p.item.sellingPrice),
                taxRatePercent: p.item.taxRatePercent ? Number(p.item.taxRatePercent) : null,
              });
              const paid = p.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
              const balance = Math.round((total - paid) * 100) / 100;
              const paymentStatus = getPaymentStatus(total, paid);

              if (editingId === p.id) {
                return (
                  <EditProductForm
                    key={p.id}
                    product={p}
                    locations={locations}
                    columnCount={columnCount}
                    onClose={() => setEditingId(null)}
                  />
                );
              }

              return (
                <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-3 py-2.5 font-mono text-xs">
                    <Link href={orderPath(p.orderSeq)} className="text-muted hover:underline">
                      {formatOrderId(p.orderSeq)}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={ORDER_STATUS_TONE[p.orderStatus]}>{statusSlot(wording, p.orderStatus, p.orderStatus.replaceAll("_", " "))}</Badge>
                    <div className="mt-1">
                      <Badge tone={BUSINESS_TYPE_TONE[p.businessType]}>{orderBusinessTypeLabels[p.businessType]}</Badge>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-text">{p.item.name}</span>
                      <Badge>{p.item.type}</Badge>
                    </div>
                    <div className="text-muted">
                      {p.item.sku} · {p.location.label}
                      {p.notes && <> · {p.notes}</>}
                    </div>
                    {p.endCustomer && (
                      <div className="mt-0.5 text-xs text-info">
                        For end customer:{" "}
                        <Link href={companyPath(p.endCustomer.companySeq)} className="hover:underline">
                          {p.endCustomer.name}
                        </Link>
                      </div>
                    )}
                    {p.company && (
                      <div className="mt-0.5 text-xs text-info">
                        Bought via reseller:{" "}
                        <Link href={companyPath(p.company.companySeq)} className="hover:underline">
                          {p.company.name}
                        </Link>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {p.vendor ? (
                      <>
                        <Link href={companyPath(p.vendor.companySeq)} className="font-medium text-text hover:underline">
                          {p.vendor.name}
                        </Link>
                        <div className="text-xs text-subtle">{paymentTermsLabels[p.vendor.paymentTerms]}</div>
                      </>
                    ) : (
                      <Badge tone="amber">No vendor set</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted">
                    {p.quantity}
                    {p.item.unit ? ` ${p.item.unit}` : ""}
                    {/* The running total, where seats were added part-way through the term. */}
                    {p.addons && p.addons.length > 0 && (
                      <span className="block text-[11px] text-subtle">
                        {p.quantity + p.addons.reduce((t, a) => t + a.quantity, 0)} in total, with{" "}
                        {p.addons.length} addition{p.addons.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {p.parentId && <span className="block text-[11px] text-subtle">added mid-term</span>}
                    {/* Extra seats are raised from the subscription itself, where the term and the
                        price to pro-rate against are already known. */}
                    {canAddSeats && !p.parentId && p.item.type === "SUBSCRIPTION" && p.endDate && p.orderStatus !== "CANCELLED" && (
                      <span className="mt-1 block">
                        <AddSeatsDialog subscription={{ id: p.id, quantity: p.quantity, endDate: p.endDate }} />
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted">{p.poNumber ?? "—"}</td>
                  <td className="px-3 py-2.5 text-muted">
                    <div className="font-medium text-text">{formatCurrency(String(total))}</div>
                    {gstAmount > 0 && (
                      <div className="text-xs text-subtle">
                        {formatCurrency(String(subtotal))} + GST {formatCurrency(String(gstAmount))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={paymentStatus.tone}>{paymentStatus.label}</Badge>
                    <div className="mt-1 text-xs text-muted">
                      Paid {formatCurrency(String(paid))}
                      {balance > 0 ? ` · Due ${formatCurrency(String(balance))}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {status ? (
                      <div className="space-y-1">
                        <div className="text-muted">
                          {formatCalendarDay(p.startDate)} – {formatCalendarDay(p.endDate)}
                        </div>
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </div>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted">
                    {p.addedBy.name}
                    <div className="text-xs text-subtle">{clock.date(p.createdAt)}</div>
                  </td>
                  {showActionsColumn && (
                    <td className="px-3 py-2.5 text-right">
                      <RowActions>
                        {(canRecordPayments || canDeletePayments) && (
                          <IconButton
                            icon={IndianRupee}
                            label="Payments"
                            onClick={() => setPaymentsTargetId(p.id)}
                          />
                        )}
                        {canEdit && <IconButton icon={Pencil} label="Edit" onClick={() => setEditingId(p.id)} />}
                        {canDelete && (
                          <IconButton
                            icon={Trash2}
                            label="Delete"
                            tone="danger"
                            disabled={isPending && deleteTarget?.id === p.id}
                            onClick={() => setDeleteTarget(p)}
                          />
                        )}
                      </RowActions>
                    </td>
                  )}
                </tr>
              );
            })}
            {products.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="px-3 py-6 text-center text-subtle">
                  No orders added directly yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-subtle">Add an item to the catalog before punching an order.</p>
      ) : (
        <Link href={`/orders/new?companyId=${companyId}`}>
          <Button type="button" variant="secondary" size="sm">
            + Punch order
          </Button>
        </Link>
      )}

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Remove product">
        <p className="text-sm text-muted">
          Remove{" "}
          <span className="font-medium text-text">
            {deleteTarget && formatOrderId(deleteTarget.orderSeq)} · {deleteTarget?.item.name}
          </span>{" "}
          from this company? This can&apos;t be undone.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteTarget(null)} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={confirmDelete} disabled={isPending}>
            {isPending ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Dialog>

      {paymentsTarget && (
        <PaymentsDialog
          key={paymentsTarget.id}
          order={paymentsTarget}
          open
          onClose={() => setPaymentsTargetId(null)}
          canRecord={canRecordPayments}
          canDelete={canDeletePayments}
          companyId={companyId}
          companyName={companyName}
        />
      )}
    </div>
  );
}
