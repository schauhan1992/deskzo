"use client";

import { useId, useState } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Pencil, Star, Trash2 } from "lucide-react";
import { bankAccountSchema, type BankAccountInput } from "@/lib/validation/bank-account";
import {
  createCompanyBankAccount,
  deleteCompanyBankAccount,
  setPrimaryCompanyBankAccount,
  updateCompanyBankAccount,
} from "@/actions/company-bank";
import {
  createOrganisationBankAccount,
  deleteOrganisationBankAccount,
  setOrganisationBankAccountActive,
  setPrimaryOrganisationBankAccount,
  updateOrganisationBankAccount,
} from "@/actions/organisation-bank";
import { Button } from "@/components/ui/button";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";

/**
 * A list of bank accounts with one primary (owner, 8 Oct 2026) — a vendor's, on its record, or the
 * organisation's own, in Settings › Organisation. The same fields and rules either way; only the
 * organisation's can be retired, because its documents and branches name them.
 */

export type BankAccountRow = {
  id: string;
  label: string;
  accountHolderName: string | null;
  bankName: string | null;
  branchName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  swift: string | null;
  upiId: string | null;
  isPrimary: boolean;
  /** The organisation's only: false once retired. */
  active?: boolean;
  documents?: number;
  branches?: string[];
};

type Scope = { kind: "company"; companyId: string } | { kind: "organisation" };
type Result = { ok: true } | { ok: false; error: string };

const actions = {
  create: (scope: Scope, values: BankAccountInput): Promise<Result> =>
    scope.kind === "company" ? createCompanyBankAccount(scope.companyId, values) : createOrganisationBankAccount(values),
  update: (scope: Scope, id: string, values: BankAccountInput): Promise<Result> =>
    scope.kind === "company" ? updateCompanyBankAccount(id, values) : updateOrganisationBankAccount(id, values),
  primary: (scope: Scope, id: string): Promise<Result> =>
    scope.kind === "company" ? setPrimaryCompanyBankAccount(id) : setPrimaryOrganisationBankAccount(id),
  remove: (scope: Scope, id: string): Promise<Result> =>
    scope.kind === "company" ? deleteCompanyBankAccount(id) : deleteOrganisationBankAccount(id),
};

function AccountForm({ scope, account, onClose }: { scope: Scope; account?: BankAccountRow; onClose: () => void }) {
  const router = useRouter();
  // Per instance: the add form and an edit form can be open at once.
  const id = useId();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<z.input<typeof bankAccountSchema>, unknown, BankAccountInput>({
    resolver: zodResolver(bankAccountSchema),
    defaultValues: {
      label: account?.label ?? "",
      accountHolderName: account?.accountHolderName ?? "",
      bankName: account?.bankName ?? "",
      branchName: account?.branchName ?? "",
      accountNumber: account?.accountNumber ?? "",
      ifsc: account?.ifsc ?? "",
      swift: account?.swift ?? "",
      upiId: account?.upiId ?? "",
      isPrimary: account?.isPrimary ?? false,
    },
  });

  async function onSubmit(values: BankAccountInput) {
    setServerError(null);
    const result = account ? await actions.update(scope, account.id, values) : await actions.create(scope, values);
    if (!result.ok) return setServerError(result.error);
    router.refresh();
    onClose();
  }

  const field = (name: keyof z.input<typeof bankAccountSchema>, label: string, props: { placeholder?: string; mono?: boolean; wide?: boolean } = {}) => {
    const error = errors[name]?.message;
    return (
      <div className={`space-y-1 ${props.wide ? "col-span-2" : ""}`}>
        <Label className="text-xs" htmlFor={`${id}-${name}`}>
          {label}
        </Label>
        <Input
          id={`${id}-${name}`}
          placeholder={props.placeholder}
          className={props.mono ? "font-mono" : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-${name}-error` : undefined}
          {...register(name)}
        />
        {error && (
          <p id={`${id}-${name}-error`} className="text-xs text-danger">
            {String(error)}
          </p>
        )}
      </div>
    );
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-2 rounded-md border border-line bg-surface-sunken p-3">
      {serverError && (
        <p role="alert" className="text-xs text-danger">
          {serverError}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {field("label", "Name", { placeholder: scope.kind === "organisation" ? 'e.g. "Main account" or "USD account"' : 'e.g. "Main account"', wide: true })}
        {field("accountHolderName", "Account holder name", { wide: true })}
        {field("accountNumber", "Account number (or IBAN)", { mono: true, wide: true })}
        {field("ifsc", "IFSC", { placeholder: "HDFC0001234", mono: true })}
        {field("swift", "SWIFT / BIC", { placeholder: "For payments from abroad", mono: true })}
        {field("bankName", "Bank")}
        {field("branchName", "Bank branch")}
        {field("upiId", "UPI ID", { placeholder: "name@bank" })}
        {/* No id/htmlFor: a duplicate id across two open forms would tick the other form's box. */}
        <label className="col-span-2 flex items-center gap-2 pt-1 text-xs text-muted">
          <input type="checkbox" {...register("isPrimary")} disabled={account?.isPrimary} className="h-3.5 w-3.5" />
          {account?.isPrimary
            ? "The primary account — make another one primary to change this"
            : scope.kind === "organisation"
              ? "Primary — printed on sales documents unless a branch or the document picks another"
              : "Primary — the account this company is paid into unless another is chosen"}
        </label>
      </div>
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

export function BankAccountsManager({
  scope,
  accounts,
  canManage,
  emptyText,
}: {
  scope: Scope;
  accounts: BankAccountRow[];
  canManage: boolean;
  emptyText: string;
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deleting = accounts.find((a) => a.id === deleteId) ?? null;

  async function run(work: () => Promise<Result>, after?: () => void) {
    setError(null);
    setBusy(true);
    const result = await work();
    setBusy(false);
    if (!result.ok) return setError(result.error);
    after?.();
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {accounts.length === 0 && !adding && <p className="text-sm text-subtle">{emptyText}</p>}
      {error && !deleting && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {accounts.map((a) =>
        editingId === a.id ? (
          <AccountForm key={a.id} scope={scope} account={a} onClose={() => setEditingId(null)} />
        ) : (
          <div key={a.id} className={`flex items-start justify-between gap-3 text-sm ${a.active === false ? "opacity-60" : ""}`}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-text">{a.label}</span>
                {a.isPrimary && <Badge tone="blue">Primary</Badge>}
                {a.active === false && <Badge>Retired</Badge>}
              </div>
              {a.accountHolderName && <div className="text-muted">{a.accountHolderName}</div>}
              <div className="break-words text-muted">
                {[
                  [a.bankName, a.branchName].filter(Boolean).join(", "),
                  a.accountNumber && `A/c ${a.accountNumber}`,
                  a.ifsc && `IFSC ${a.ifsc}`,
                  a.swift && `SWIFT ${a.swift}`,
                  a.upiId && `UPI ${a.upiId}`,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No details on file"}
              </div>
              {a.branches && a.branches.length > 0 && <div className="text-xs text-subtle">Default for {a.branches.join(", ")}</div>}
            </div>
            {canManage && (
              <RowActions className="shrink-0">
                {!a.isPrimary && a.active !== false && (
                  <IconButton icon={Star} label="Make primary" disabled={busy} onClick={() => run(() => actions.primary(scope, a.id))} />
                )}
                <IconButton icon={Pencil} label="Edit account" onClick={() => setEditingId(a.id)} />
                {scope.kind === "organisation" && !a.isPrimary && (
                  <IconButton
                    icon={a.active === false ? ArchiveRestore : Archive}
                    label={a.active === false ? "Put back in use" : "Retire account"}
                    disabled={busy}
                    onClick={() => run(() => setOrganisationBankAccountActive(a.id, a.active === false))}
                  />
                )}
                <IconButton
                  icon={Trash2}
                  label="Delete account"
                  tone="danger"
                  onClick={() => {
                    setError(null);
                    setDeleteId(a.id);
                  }}
                />
              </RowActions>
            )}
          </div>
        ),
      )}

      {canManage &&
        (adding ? (
          <AccountForm scope={scope} onClose={() => setAdding(false)} />
        ) : (
          <Button type="button" variant="secondary" size="sm" onClick={() => setAdding(true)}>
            + Add bank account
          </Button>
        ))}

      <Dialog open={!!deleting} onClose={() => setDeleteId(null)} title="Delete bank account">
        <p className="text-sm text-muted">
          Delete <span className="font-medium text-text">{deleting?.label}</span>? This can&apos;t be undone.
          {scope.kind === "company" && deleting?.isPrimary && accounts.length > 1 && " The oldest of the others becomes the primary."}
        </p>
        {error && deleting && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteId(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => deleting && run(() => actions.remove(scope, deleting.id), () => setDeleteId(null))}
          >
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
