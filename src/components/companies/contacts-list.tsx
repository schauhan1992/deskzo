"use client";

import { useId, useState } from "react";
import type { z } from "zod";
import { useForm, type UseFormRegister, type FieldValues, type FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { MessageCircle, Lock, MailCheck, Pencil, Trash2 } from "lucide-react";
import { REDACTED_PLACEHOLDER } from "@/lib/reseller";
import type { ContactDesignation } from "@prisma/client";
import {
  contactInputSchema,
  updateContactSchema,
  contactDesignationValues,
  type ContactInput,
  type UpdateContactInput,
} from "@/lib/validation/company";
import { addContact, updateContact, deleteContact } from "@/actions/company";
import { verifyCompanyEmails } from "@/actions/email-verification";
import { Button } from "@/components/ui/button";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { CallButton } from "@/components/calls/call-button";
import { EmailAddress, type VerifiableContact } from "@/components/contacts/email-address";
import { emailCheckState } from "@/lib/email-verification";
import { OutboundLink, whatsappHref } from "@/components/ui/outbound-link";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";

export type Contact = VerifiableContact & {
  name: string;
  designation: ContactDesignation;
  phone: string | null;
  linkedinUrl: string | null;
  isPrimary: boolean;
  /** Email/phone were stripped server-side because this company belongs to a reseller. */
  detailsRedacted?: boolean;
};

function ContactFields({
  register,
  errors,
}: {
  register: UseFormRegister<FieldValues>;
  errors: FieldErrors<FieldValues>;
}) {
  // Per-instance ids rather than per-field: an edit form and the add form can be on screen together,
  // and a repeated id would point both forms' labels at the first one's fields.
  const id = useId();
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="col-span-2 space-y-1">
        <Label className="text-xs" htmlFor={`${id}-name`}>
          Name
        </Label>
        <Input id={`${id}-name`} {...register("name")} />
        {errors.name && <p className="text-xs text-danger">{String(errors.name.message)}</p>}
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${id}-designation`}>
          Designation
        </Label>
        <Select id={`${id}-designation`} {...register("designation")}>
          {contactDesignationValues.map((d) => (
            <option key={d} value={d}>
              {d.replaceAll("_", " ")}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${id}-email`}>
          Email
        </Label>
        <Input id={`${id}-email`} type="email" {...register("email")} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${id}-phone`}>
          Phone
        </Label>
        <Input id={`${id}-phone`} {...register("phone")} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${id}-linkedin`}>
          LinkedIn URL
        </Label>
        <Input id={`${id}-linkedin`} {...register("linkedinUrl")} />
      </div>
      <div className="col-span-2">
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" {...register("isPrimary")} />
          Primary contact
        </label>
      </div>
    </div>
  );
}

function EditContactForm({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  type FormValues = z.input<typeof updateContactSchema>;
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, UpdateContactInput>({
    resolver: zodResolver(updateContactSchema),
    defaultValues: {
      id: contact.id,
      name: contact.name,
      designation: contact.designation,
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      linkedinUrl: contact.linkedinUrl ?? "",
      isPrimary: contact.isPrimary,
    },
  });

  async function onSubmit(values: UpdateContactInput) {
    setServerError(null);
    const result = await updateContact(values);
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
      <ContactFields register={register as unknown as UseFormRegister<FieldValues>} errors={errors} />
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

export function ContactsList({
  companyId,
  companyName,
  contacts,
}: {
  companyId: string;
  companyName: string;
  contacts: Contact[];
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const deleteTarget = contacts.find((c) => c.id === deleteTargetId) ?? null;
  const [isPending, setIsPending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkNotice, setCheckNotice] = useState<string | null>(null);

  // Offered only when there is something to check: a button that reports "checked 0" is noise on a
  // panel that already has plenty.
  const uncheckedCount = contacts.filter(
    (c) => c.email && emailCheckState(c).status === "UNCHECKED",
  ).length;

  function checkAll() {
    setChecking(true);
    setCheckNotice(null);
    verifyCompanyEmails(companyId).then((result) => {
      setChecking(false);
      setCheckNotice(result.ok ? `Checked ${result.data.checked}.` : result.error);
      if (result.ok) router.refresh();
    });
  }

  type AddFormValues = z.input<typeof contactInputSchema>;
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AddFormValues, unknown, ContactInput>({
    resolver: zodResolver(contactInputSchema),
    defaultValues: { designation: "OTHER", isPrimary: false },
  });

  async function onAddSubmit(values: ContactInput) {
    const result = await addContact(companyId, values);
    if (!result.ok) {
      return;
    }
    reset({ name: "", designation: "OTHER", email: "", phone: "", linkedinUrl: "", isPrimary: false });
    setAddOpen(false);
    router.refresh();
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteError(null);
    setIsPending(true);
    deleteContact(deleteTarget.id).then((result) => {
      setIsPending(false);
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
      {contacts.map((c) =>
        editingId === c.id ? (
          <EditContactForm key={c.id} contact={c} onClose={() => setEditingId(null)} />
        ) : (
          <div key={c.id} className="flex items-start justify-between text-sm">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-text">{c.name}</span>
                {c.isPrimary && <Badge tone="blue">Primary</Badge>}
              </div>
              <div className="text-muted">{c.designation.replaceAll("_", " ")}</div>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                {c.detailsRedacted && (
                  <span className="flex items-center gap-1 rounded bg-warning-bg px-1.5 py-0.5 text-xs text-warning">
                    <Lock className="h-3 w-3" />
                    {REDACTED_PLACEHOLDER}
                  </span>
                )}
                {c.email && <EmailAddress contact={c} />}
                {c.phone && (
                  <CallButton
                    companyId={companyId}
                    companyName={companyName}
                    contact={{ id: c.id, name: c.name, phone: c.phone }}
                    size="sm"
                    variant="ghost"
                    label={c.phone}
                  />
                )}
                {c.phone && (
                  <OutboundLink
                    href={whatsappHref(c.phone)}
                    className="flex items-center gap-1 text-success hover:text-success hover:underline"
                  >
                    <MessageCircle className="h-3.5 w-3.5" />
                    WhatsApp
                  </OutboundLink>
                )}
              </div>
            </div>
            <RowActions className="shrink-0">
              <IconButton icon={Pencil} label="Edit contact" onClick={() => setEditingId(c.id)} />
              <IconButton
                icon={Trash2}
                label="Delete contact"
                tone="danger"
                onClick={() => {
                  setDeleteError(null);
                  setDeleteTargetId(c.id);
                }}
              />
            </RowActions>
          </div>
        ),
      )}
      {contacts.length === 0 && <p className="text-sm text-subtle">No contacts added.</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {!addOpen ? (
          <>
            <Button type="button" variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
              + Add contact
            </Button>
            {uncheckedCount > 0 && (
              <Button type="button" variant="ghost" size="sm" disabled={checking} onClick={checkAll}>
                <MailCheck className="mr-1.5 h-3.5 w-3.5" />
                {checking ? "Checking…" : `Check ${uncheckedCount} address${uncheckedCount === 1 ? "" : "es"}`}
              </Button>
            )}
            {checkNotice && <span className="text-xs text-muted">{checkNotice}</span>}
          </>
        ) : (
          <form onSubmit={handleSubmit(onAddSubmit)} className="space-y-2 rounded-md border border-line p-3">
            <ContactFields register={register as unknown as UseFormRegister<FieldValues>} errors={errors} />
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isSubmitting}>
                {isSubmitting ? "Saving…" : "Save contact"}
              </Button>
            </div>
          </form>
        )}
      </div>

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTargetId(null)} title="Delete contact">
        <p className="text-sm text-muted">
          Delete <span className="font-medium text-text">{deleteTarget?.name}</span>? This can&apos;t be undone.
        </p>
        {deleteError && <p className="mt-2 text-xs text-danger">{deleteError}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteTargetId(null)} disabled={isPending}>
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
