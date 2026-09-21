"use client";

import { useId, useState } from "react";
import type { z } from "zod";
import { useForm, type UseFormRegister, type FieldValues, type FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import {
  commissionPartyAccountSchema,
  type CommissionPartyAccountInput,
} from "@/lib/validation/commission-party";
import {
  createCommissionPartyAccount,
  updateCommissionPartyAccount,
  deleteCommissionPartyAccount,
} from "@/actions/commission-party";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";

export type CommissionPartyAccount = {
  id: string;
  label: string;
  accountHolderName: string | null;
  panNumber: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  upiId: string | null;
  isDefault: boolean;
};

function AccountFields({
  register,
  errors,
}: {
  register: UseFormRegister<FieldValues>;
  errors: FieldErrors<FieldValues>;
}) {
  // A caption above a control names nothing until the label points at the control's id. The ids have
  // to be per-instance rather than per-field, because an edit form and the add form can be mounted at
  // the same time and a repeated id would aim both forms' labels at the first one's fields.
  const id = useId();
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="col-span-2 space-y-1">
        <Label className="text-xs" htmlFor={`${id}-label`}>
          Label
        </Label>
        <Input id={`${id}-label`} placeholder={'e.g. "Primary" or the account holder\'s name'} {...register("label")} />
        {errors.label && <p className="text-xs text-danger">{String(errors.label.message)}</p>}
      </div>
      <div className="col-span-2 space-y-1">
        <Label className="text-xs" htmlFor={`${id}-holder`}>
          Account holder name
        </Label>
        <Input id={`${id}-holder`} {...register("accountHolderName")} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${id}-pan`}>
          PAN
        </Label>
        <Input id={`${id}-pan`} placeholder="ABCDE1234F" {...register("panNumber")} />
        {errors.panNumber && <p className="text-xs text-danger">{String(errors.panNumber.message)}</p>}
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${id}-upi`}>
          UPI ID
        </Label>
        <Input id={`${id}-upi`} placeholder="name@bank" {...register("upiId")} />
      </div>
      <div className="col-span-2 space-y-1">
        <Label className="text-xs" htmlFor={`${id}-account-number`}>
          Bank account number
        </Label>
        <Input id={`${id}-account-number`} {...register("bankAccountNumber")} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${id}-ifsc`}>
          IFSC
        </Label>
        <Input id={`${id}-ifsc`} placeholder="HDFC0001234" {...register("bankIfsc")} />
        {errors.bankIfsc && <p className="text-xs text-danger">{String(errors.bankIfsc.message)}</p>}
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${id}-bank-name`}>
          Bank name
        </Label>
        <Input id={`${id}-bank-name`} {...register("bankName")} />
      </div>
      {/* No id/htmlFor: the add form and an edit form can be open at once, and duplicate ids would
          make one form's label toggle the other form's checkbox. */}
      <label className="col-span-2 flex items-center gap-2 pt-1 text-xs text-muted">
        <input type="checkbox" {...register("isDefault")} className="h-3.5 w-3.5" />
        Default account for this commission party
      </label>
    </div>
  );
}

function AccountForm({
  commissionPartyId,
  account,
  onClose,
}: {
  commissionPartyId: string;
  account?: CommissionPartyAccount;
  onClose: () => void;
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  type FormValues = z.input<typeof commissionPartyAccountSchema>;
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CommissionPartyAccountInput>({
    resolver: zodResolver(commissionPartyAccountSchema),
    defaultValues: {
      label: account?.label ?? "",
      accountHolderName: account?.accountHolderName ?? "",
      panNumber: account?.panNumber ?? "",
      bankAccountNumber: account?.bankAccountNumber ?? "",
      bankIfsc: account?.bankIfsc ?? "",
      bankName: account?.bankName ?? "",
      upiId: account?.upiId ?? "",
      isDefault: account?.isDefault ?? false,
    },
  });

  async function onSubmit(values: CommissionPartyAccountInput) {
    setServerError(null);
    const result = account
      ? await updateCommissionPartyAccount(account.id, values)
      : await createCommissionPartyAccount(commissionPartyId, values);
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
      <AccountFields register={register as unknown as UseFormRegister<FieldValues>} errors={errors} />
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

export function CommissionPartyAccountsManager({
  commissionPartyId,
  accounts,
}: {
  commissionPartyId: string;
  accounts: CommissionPartyAccount[];
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const deleteTarget = accounts.find((a) => a.id === deleteTargetId) ?? null;
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteError(null);
    setPendingId(deleteTarget.id);
    deleteCommissionPartyAccount(deleteTarget.id).then((result) => {
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
      {accounts.length === 0 && !addOpen && (
        <p className="text-sm text-subtle">
          No related parties yet — add one for each account this commission party can be paid into.
        </p>
      )}
      {accounts.map((a) =>
        editingId === a.id ? (
          <AccountForm key={a.id} commissionPartyId={commissionPartyId} account={a} onClose={() => setEditingId(null)} />
        ) : (
          <div key={a.id} className="flex items-start justify-between text-sm">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-text">{a.label}</span>
                {a.isDefault && <Badge tone="blue">Default</Badge>}
              </div>
              {a.accountHolderName && <div className="text-muted">{a.accountHolderName}</div>}
              <div className="text-muted">
                {[a.panNumber, a.bankName, a.bankAccountNumber, a.bankIfsc, a.upiId].filter(Boolean).join(" · ") || "No details on file"}
              </div>
            </div>
            <RowActions className="shrink-0">
              <IconButton icon={Pencil} label="Edit account" onClick={() => setEditingId(a.id)} />
              <IconButton
                icon={Trash2}
                label="Delete account"
                tone="danger"
                onClick={() => {
                  setDeleteError(null);
                  setDeleteTargetId(a.id);
                }}
              />
            </RowActions>
          </div>
        ),
      )}

      {!addOpen ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
          + Add related party
        </Button>
      ) : (
        <AccountForm commissionPartyId={commissionPartyId} onClose={() => setAddOpen(false)} />
      )}

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTargetId(null)} title="Delete related party">
        <p className="text-sm text-muted">
          Delete <span className="font-medium text-text">{deleteTarget?.label}</span>? This can&apos;t be undone.
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
