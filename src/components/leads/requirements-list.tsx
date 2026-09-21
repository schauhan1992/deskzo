"use client";

import { useState, useTransition } from "react";
import type { z } from "zod";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import {
  addLeadRequirementSchema,
  updateLeadRequirementSchema,
  type AddLeadRequirementInput,
  type UpdateLeadRequirementInput,
} from "@/lib/validation/lead";
import { addLeadRequirement, removeLeadRequirement, updateLeadRequirement } from "@/actions/lead";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { ItemCombobox } from "@/components/items/item-combobox";
import { formatCurrency } from "@/lib/utils";

type ItemOption = { id: string; name: string; sku: string; type: string; unit: string | null; sellingPrice: unknown };

type Requirement = {
  id: string;
  quantity: number;
  notes: string | null;
  item: { id: string; name: string; sku: string; type: string; unit: string | null; sellingPrice: unknown };
};

type AddFormValues = z.input<typeof addLeadRequirementSchema>;
type EditFormValues = z.input<typeof updateLeadRequirementSchema>;

function EditRequirementForm({ requirement, onClose }: { requirement: Requirement; onClose: () => void }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EditFormValues, unknown, UpdateLeadRequirementInput>({
    resolver: zodResolver(updateLeadRequirementSchema),
    defaultValues: {
      id: requirement.id,
      quantity: requirement.quantity,
      notes: requirement.notes ?? "",
    },
  });

  async function onSubmit(values: UpdateLeadRequirementInput) {
    setServerError(null);
    const result = await updateLeadRequirement(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-2 rounded-md border border-line bg-surface-sunken p-3">
      {serverError && <p className="text-xs text-danger">{serverError}</p>}
      <div className="text-sm font-medium text-text">{requirement.item.name}</div>
      <div className="flex gap-2">
        {/*
          This form opens in place of a row, so the product it belongs to is carried in the name —
          "Quantity" alone is the same two words on whichever row somebody happened to open.
        */}
        <Input
          aria-label={`Quantity of ${requirement.item.name}`}
          type="number"
          min={1}
          placeholder="Qty"
          className="w-24"
          {...register("quantity")}
        />
        <Input aria-label={`Notes on ${requirement.item.name}`} placeholder="Notes (optional)" {...register("notes")} />
      </div>
      {errors.quantity && <p className="text-xs text-danger">{errors.quantity.message}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

export function RequirementsList({
  leadId,
  requirements,
  items,
  canEdit,
  canDelete,
}: {
  leadId: string;
  requirements: Requirement[];
  items: ItemOption[];
  canEdit: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Requirement | null>(null);
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = useForm<AddFormValues, unknown, AddLeadRequirementInput>({
    resolver: zodResolver(addLeadRequirementSchema),
    defaultValues: { leadId, quantity: 1 },
  });

  async function onSubmit(values: AddLeadRequirementInput) {
    setServerError(null);
    const result = await addLeadRequirement(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    reset({ leadId, itemId: "", quantity: 1, notes: "" });
    setOpen(false);
    router.refresh();
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    startTransition(async () => {
      await removeLeadRequirement(id);
      setDeleteTarget(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {requirements.length === 0 && <p className="text-sm text-subtle">No products added yet.</p>}
      {requirements.map((r) => {
        if (editingId === r.id) {
          return <EditRequirementForm key={r.id} requirement={r} onClose={() => setEditingId(null)} />;
        }

        return (
          <div key={r.id} className="flex items-start justify-between text-sm">
            <div>
              <div className="font-medium text-text">
                {r.item.name} <Badge>{r.item.type}</Badge>
              </div>
              <div className="text-muted">
                {r.item.sku} · Qty {r.quantity}
                {r.item.unit ? ` ${r.item.unit}` : ""} ·{" "}
                {formatCurrency((Number(r.item.sellingPrice) * r.quantity).toString())}
              </div>
              {r.notes && <div className="text-muted">{r.notes}</div>}
            </div>
            {(canEdit || canDelete) && (
              <RowActions className="shrink-0">
                {canEdit && (
                  <IconButton icon={Pencil} label="Edit requirement" onClick={() => setEditingId(r.id)} />
                )}
                {canDelete && (
                  <IconButton
                    icon={Trash2}
                    label="Delete requirement"
                    tone="danger"
                    disabled={isPending && deleteTarget?.id === r.id}
                    onClick={() => setDeleteTarget(r)}
                  />
                )}
              </RowActions>
            )}
          </div>
        );
      })}

      {!open ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)} disabled={items.length === 0}>
          + Add product
        </Button>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-2 rounded-md border border-line p-3">
          {serverError && <p className="text-xs text-danger">{serverError}</p>}
          <Controller
            name="itemId"
            control={control}
            render={({ field }) => (
              <ItemCombobox
                items={items}
                value={field.value ?? ""}
                onSelect={(item) => field.onChange(item?.id ?? "")}
                showPrice
              />
            )}
          />
          {errors.itemId && <p className="text-xs text-danger">{errors.itemId.message}</p>}
          <div className="flex gap-2">
            <Input aria-label="Quantity" type="number" min={1} placeholder="Qty" className="w-24" {...register("quantity")} />
            <Input aria-label="Notes" placeholder="Notes (optional)" {...register("notes")} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? "Adding…" : "Add"}
            </Button>
          </div>
        </form>
      )}

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Remove product">
        <p className="text-sm text-muted">
          Remove <span className="font-medium text-text">{deleteTarget?.item.name}</span> from this lead&apos;s
          requirements? This can&apos;t be undone.
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
    </div>
  );
}
