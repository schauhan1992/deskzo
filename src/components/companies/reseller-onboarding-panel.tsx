"use client";

import { useId, useState, useTransition } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import type { ResellerOnboardingStatus, ResellerTier } from "@prisma/client";
import { resellerProfileSchema, type ResellerProfileInput } from "@/lib/validation/reseller";
import { updateResellerProfile, setResellerStatus } from "@/actions/reseller";
import {
  resellerStatusValues,
  resellerStatusLabels,
  resellerTierValues,
  resellerTierLabels,
  type ChecklistItem,
} from "@/lib/reseller-onboarding";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

const STATUS_TONE: Record<ResellerOnboardingStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  ONBOARDING: "amber",
  ACTIVE: "green",
  SUSPENDED: "red",
  INACTIVE: "default",
};

type Profile = {
  status: ResellerOnboardingStatus;
  agreementSignedOn: Date | string | null;
  agreementReference: string | null;
  agreementApprovedByUserId: string | null;
  creditLimit: unknown;
  tier: ResellerTier | null;
  discountPercent: unknown;
  notes: string | null;
};

type CreditSummary = {
  creditLimit: number | null;
  outstanding: number;
  available: number | null;
  overLimit: boolean;
};

/** A typed day as stored (midnight UTC) back into a date input: its UTC date is the day, in any zone. */
function toDateInput(d: Date | string | null) {
  return d ? new Date(d).toISOString().slice(0, 10) : "";
}

export function ResellerOnboardingPanel({
  companyId,
  profile,
  checklist,
  credit,
  users,
  complete,
}: {
  companyId: string;
  profile: Profile;
  checklist: ChecklistItem[];
  credit: CreditSummary;
  users: { id: string; name: string }[];
  complete: boolean;
}) {
  const router = useRouter();
  // Prefix rather than literal ids: a company page can render this panel beside another copy of the
  // same form, and two controls sharing an id send every label to the first one.
  const fieldId = useId();
  const [editing, setEditing] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  type FormValues = z.input<typeof resellerProfileSchema>;
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, ResellerProfileInput>({
    resolver: zodResolver(resellerProfileSchema),
    defaultValues: {
      agreementSignedOn: toDateInput(profile.agreementSignedOn),
      agreementReference: profile.agreementReference ?? "",
      agreementApprovedByUserId: profile.agreementApprovedByUserId ?? "",
      creditLimit: profile.creditLimit != null ? Number(profile.creditLimit) : undefined,
      tier: profile.tier ?? "",
      discountPercent: profile.discountPercent != null ? Number(profile.discountPercent) : undefined,
      notes: profile.notes ?? "",
    },
  });

  async function onSubmit(values: ResellerProfileInput) {
    setServerError(null);
    const result = await updateResellerProfile(companyId, values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  function changeStatus(next: ResellerOnboardingStatus) {
    setStatusError(null);
    startTransition(async () => {
      const result = await setResellerStatus(companyId, next);
      if (!result.ok) {
        setStatusError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={STATUS_TONE[profile.status]}>{resellerStatusLabels[profile.status]}</Badge>
        <Select
          value={profile.status}
          disabled={isPending}
          onChange={(e) => changeStatus(e.target.value as ResellerOnboardingStatus)}
          className="h-8 w-40 text-xs"
          // The Badge beside it is the only caption, and a Badge names nothing.
          aria-label="Onboarding status"
        >
          {resellerStatusValues.map((s) => (
            <option key={s} value={s}>
              {resellerStatusLabels[s]}
            </option>
          ))}
        </Select>
        <span className="text-xs text-muted">
          {profile.status === "ACTIVE"
            ? "Orders can be punched for this reseller."
            : "Orders are blocked until this reseller is Active."}
        </span>
      </div>
      {statusError && <p className="text-xs text-danger">{statusError}</p>}

      <div className="space-y-1.5 rounded-md border border-line p-3">
        {checklist.map((item) => (
          <div key={item.key} className="flex items-start gap-2 text-sm">
            {item.done ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            ) : (
              <X className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            )}
            <div>
              <span className={item.done ? "text-text" : "font-medium text-text"}>{item.label}</span>
              {!item.done && <p className="text-xs text-muted">{item.hint}</p>}
            </div>
          </div>
        ))}
        {!complete && (
          <p className="pt-1 text-xs text-warning">
            Finish every step above before this reseller can be activated.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm @2xl:grid-cols-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-subtle">Credit limit</div>
          <div className="text-text">
            {credit.creditLimit === null ? "—" : formatCurrency(String(credit.creditLimit))}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-subtle">Outstanding</div>
          <div className={credit.overLimit ? "font-medium text-danger" : "text-text"}>
            {formatCurrency(String(credit.outstanding))}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-subtle">Available</div>
          <div className="text-text">
            {credit.available === null ? "—" : formatCurrency(String(credit.available))}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-subtle">Tier</div>
          <div className="text-text">
            {profile.tier ? resellerTierLabels[profile.tier] : "—"}
            {profile.discountPercent != null && ` · ${Number(profile.discountPercent)}% off`}
          </div>
        </div>
      </div>
      {credit.overLimit && (
        <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
          Over their credit limit by {formatCurrency(String(credit.outstanding - (credit.creditLimit ?? 0)))} — chase
          payment before taking more orders, or raise the limit.
        </p>
      )}

      {!editing ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Edit onboarding details
          </Button>
          {profile.agreementReference && (
            <span className="text-muted">Agreement ref: {profile.agreementReference}</span>
          )}
          {profile.notes && <span className="text-muted">{profile.notes}</span>}
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3 rounded-md border border-line bg-surface-sunken p-3">
          {serverError && <p className="text-xs text-danger">{serverError}</p>}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-signed-on`} className="text-xs">
                Agreement signed on
              </Label>
              <Input id={`${fieldId}-signed-on`} type="date" {...register("agreementSignedOn")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-reference`} className="text-xs">
                Agreement reference
              </Label>
              <Input
                id={`${fieldId}-reference`}
                placeholder="e.g. WRF-PA-2026-014"
                {...register("agreementReference")}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label htmlFor={`${fieldId}-approved-by`} className="text-xs">
                Approved by
              </Label>
              <Select id={`${fieldId}-approved-by`} {...register("agreementApprovedByUserId")}>
                <option value="">Not recorded</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-credit-limit`} className="text-xs">
                Credit limit (₹)
              </Label>
              <Input
                id={`${fieldId}-credit-limit`}
                type="number"
                step="0.01"
                min={0}
                {...register("creditLimit")}
              />
              {errors.creditLimit && <p className="text-xs text-danger">{String(errors.creditLimit.message)}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-tier`} className="text-xs">
                Partner tier
              </Label>
              <Select id={`${fieldId}-tier`} {...register("tier")}>
                <option value="">Not set</option>
                {resellerTierValues.map((t) => (
                  <option key={t} value={t}>
                    {resellerTierLabels[t]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-discount`} className="text-xs">
                Standard discount (%)
              </Label>
              <Input
                id={`${fieldId}-discount`}
                type="number"
                step="0.01"
                min={0}
                max={100}
                {...register("discountPercent")}
              />
              {errors.discountPercent && (
                <p className="text-xs text-danger">{String(errors.discountPercent.message)}</p>
              )}
            </div>
            <div className="col-span-2 space-y-1">
              <Label htmlFor={`${fieldId}-notes`} className="text-xs">
                Notes
              </Label>
              <Textarea id={`${fieldId}-notes`} {...register("notes")} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
