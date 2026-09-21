"use client";

import { useId, useState } from "react";
import type { z } from "zod";
import { useForm, type UseFormRegister, type FieldValues, type FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import type { GstTreatment } from "@prisma/client";
import {
  addCompanyLocationSchema,
  updateCompanyLocationSchema,
  type AddCompanyLocationInput,
  type UpdateCompanyLocationInput,
} from "@/lib/validation/company-location";
import {
  addCompanyLocation,
  updateCompanyLocation,
  setPrimaryLocation,
  deleteCompanyLocation,
} from "@/actions/company-location";
import { Star, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { gstTreatmentValues, gstTreatmentLabels } from "@/lib/gst";

export type Location = {
  id: string;
  label: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  pincode: string | null;
  gstNumber: string | null;
  gstTreatment: GstTreatment;
  isPrimary: boolean;
  isBilling: boolean;
  isShipping: boolean;
};

function LocationFields({
  register,
  errors,
}: {
  register: UseFormRegister<FieldValues>;
  errors: FieldErrors<FieldValues>;
}) {
  // These fields already carry visible labels, so they are wired up with htmlFor rather than
  // aria-label — one source of truth for the wording, and the label text becomes a click target.
  // The prefix comes from useId because the add form and an open edit form render this component
  // side by side; a fixed id would appear twice and both labels would point at the first copy.
  const uid = useId();
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="col-span-2 space-y-1">
        <Label htmlFor={`${uid}-label`} className="text-xs">
          Label
        </Label>
        <Input id={`${uid}-label`} placeholder="e.g. Head Office — Maharashtra" {...register("label")} />
        {errors.label && <p className="text-xs text-danger">{String(errors.label.message)}</p>}
      </div>
      <div className="col-span-2 space-y-1">
        <Label htmlFor={`${uid}-address`} className="text-xs">
          Address
        </Label>
        <Input id={`${uid}-address`} {...register("address")} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${uid}-city`} className="text-xs">
          City
        </Label>
        <Input id={`${uid}-city`} {...register("city")} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${uid}-state`} className="text-xs">
          State
        </Label>
        <Input id={`${uid}-state`} {...register("state")} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${uid}-country`} className="text-xs">
          Country
        </Label>
        <Input id={`${uid}-country`} placeholder="India" {...register("country")} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${uid}-pincode`} className="text-xs">
          PIN code
        </Label>
        <Input id={`${uid}-pincode`} placeholder="400001" {...register("pincode")} />
        {errors.pincode && <p className="text-xs text-danger">{String(errors.pincode.message)}</p>}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${uid}-gstNumber`} className="text-xs">
          GST number
        </Label>
        <Input id={`${uid}-gstNumber`} {...register("gstNumber")} />
      </div>

      <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
        {/* Both, because most customers bill and ship to one place and making them record it
            twice is how the two drift apart. */}
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" className="h-4 w-4 rounded border-line-strong" {...register("isBilling")} />
          Bill to this address
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" className="h-4 w-4 rounded border-line-strong" {...register("isShipping")} />
          Ship to this address
        </label>
      </div>
      <div className="col-span-2 space-y-1">
        <Label htmlFor={`${uid}-gstTreatment`} className="text-xs">
          GST treatment
        </Label>
        <Select id={`${uid}-gstTreatment`} {...register("gstTreatment")}>
          {gstTreatmentValues.map((t) => (
            <option key={t} value={t}>
              {gstTreatmentLabels[t]}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

function EditLocationForm({ location, onClose }: { location: Location; onClose: () => void }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  type FormValues = z.input<typeof updateCompanyLocationSchema>;
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, UpdateCompanyLocationInput>({
    resolver: zodResolver(updateCompanyLocationSchema),
    defaultValues: {
      id: location.id,
      label: location.label,
      address: location.address ?? "",
      city: location.city ?? "",
      state: location.state ?? "",
      country: location.country ?? "",
      pincode: location.pincode ?? "",
      gstNumber: location.gstNumber ?? "",
      isBilling: location.isBilling,
      isShipping: location.isShipping,
      gstTreatment: location.gstTreatment,
    },
  });

  async function onSubmit(values: UpdateCompanyLocationInput) {
    setServerError(null);
    const result = await updateCompanyLocation(values);
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
      <LocationFields register={register as unknown as UseFormRegister<FieldValues>} errors={errors} />
      <div className="flex justify-end gap-2 pt-1">
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

export function LocationsManager({ companyId, locations }: { companyId: string; locations: Location[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const deleteTarget = locations.find((l) => l.id === deleteTargetId) ?? null;
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [addServerError, setAddServerError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  type AddFormValues = z.input<typeof addCompanyLocationSchema>;
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AddFormValues, unknown, AddCompanyLocationInput>({
    resolver: zodResolver(addCompanyLocationSchema),
    defaultValues: { companyId, label: "", gstTreatment: "UNREGISTERED" },
  });

  async function onAddSubmit(values: AddCompanyLocationInput) {
    setAddServerError(null);
    const result = await addCompanyLocation(values);
    if (!result.ok) {
      setAddServerError(result.error);
      return;
    }
    reset({ companyId, label: "", address: "", city: "", state: "", country: "", pincode: "", gstNumber: "", gstTreatment: "UNREGISTERED" });
    setAddOpen(false);
    router.refresh();
  }

  function handleSetPrimary(id: string) {
    setPendingId(id);
    setPrimaryLocation(id).finally(() => {
      setPendingId(null);
      router.refresh();
    });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteError(null);
    setPendingId(deleteTarget.id);
    deleteCompanyLocation(deleteTarget.id).then((result) => {
      setPendingId(null);
      if (!result.ok) {
        setDeleteError(result.error);
        return;
      }
      setDeleteTargetId(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {locations.map((loc) =>
        editingId === loc.id ? (
          <EditLocationForm key={loc.id} location={loc} onClose={() => setEditingId(null)} />
        ) : (
          <div key={loc.id} className="flex items-start justify-between text-sm">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-text">{loc.label}</span>
                {loc.isPrimary && <Badge tone="blue">Primary</Badge>}
                {loc.isBilling && <Badge tone="green">Billing</Badge>}
                {loc.isShipping && <Badge tone="amber">Shipping</Badge>}
              </div>
              <div className="text-muted">
                {[loc.address, loc.city, loc.state, loc.pincode, loc.country].filter(Boolean).join(", ") || "No address on file"}
              </div>
              <div className="text-muted">
                GST: {loc.gstNumber ?? "—"} · {gstTreatmentLabels[loc.gstTreatment]}
              </div>
            </div>
            <RowActions className="shrink-0">
              {!loc.isPrimary && (
                <IconButton
                  icon={Star}
                  label="Make this the primary site"
                  disabled={pendingId === loc.id}
                  onClick={() => handleSetPrimary(loc.id)}
                />
              )}
              <IconButton icon={Pencil} label="Edit site" onClick={() => setEditingId(loc.id)} />
              {!loc.isPrimary && (
                <IconButton
                  icon={Trash2}
                  label="Delete site"
                  tone="danger"
                  onClick={() => {
                    setDeleteError(null);
                    setDeleteTargetId(loc.id);
                  }}
                />
              )}
            </RowActions>
          </div>
        ),
      )}

      {!addOpen ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
          + Add location
        </Button>
      ) : (
        <form onSubmit={handleSubmit(onAddSubmit)} className="space-y-2 rounded-md border border-line p-3">
          {addServerError && <p className="text-xs text-danger">{addServerError}</p>}
          <LocationFields register={register as unknown as UseFormRegister<FieldValues>} errors={errors} />
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? "Adding…" : "Add location"}
            </Button>
          </div>
        </form>
      )}

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTargetId(null)} title="Delete location">
        <p className="text-sm text-muted">
          Delete <span className="font-medium text-text">{deleteTarget?.label}</span>? This can&apos;t be undone.
          Locations with orders already attached to them can&apos;t be deleted.
        </p>
        {deleteError && <p className="mt-2 text-xs text-danger">{deleteError}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteTargetId(null)} disabled={!!pendingId}>
            Cancel
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={confirmDelete} disabled={!!pendingId}>
            {pendingId === deleteTarget?.id ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
