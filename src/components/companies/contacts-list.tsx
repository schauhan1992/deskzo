"use client";

import { useId, useState } from "react";
import { ScheduleMeetingButton } from "@/components/calendar/schedule-meeting-button";
import type { z } from "zod";
import { useForm, type UseFormRegister, type FieldValues, type FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { ChevronRight, MessageCircle, Lock, MailCheck, Pencil, Trash2, UserCheck, UserX } from "lucide-react";
import { REDACTED_PLACEHOLDER } from "@/lib/reseller";
import type { ContactDesignation } from "@prisma/client";
import {
  contactInputSchema,
  updateContactSchema,
  contactRoleLabel,
  isContactDetailField,
  type ContactInput,
  type UpdateContactInput,
} from "@/lib/validation/company";
import { addContact, updateContact, deleteContact, setContactLeft, moveContact, searchCompaniesToJoin } from "@/actions/company";
import type { ContactMoves } from "@/lib/contacts/moves";
import { companyPath } from "@/lib/record-links";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import Link from "next/link";
import {
  CustomFieldInputs,
  missingRequired,
  type CustomFieldFormValues,
  type CustomFieldPerson,
} from "@/components/custom-fields/custom-field-inputs";
import type { CustomFieldDef } from "@/lib/custom-fields/rules";
import { verifyCompanyEmails } from "@/actions/email-verification";
import { Button } from "@/components/ui/button";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { CallButton } from "@/components/calls/call-button";
import { EmailAddress, type VerifiableContact } from "@/components/contacts/email-address";
import { emailCheckState } from "@/lib/email-verification";
import { OutboundLink, externalHref, whatsappHref } from "@/components/ui/outbound-link";
import { LinkedInMark } from "@/components/companies/company-links";
import { DesignationInput } from "@/components/contacts/designation-input";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";

export type Contact = VerifiableContact & {
  name: string;
  designation: ContactDesignation;
  /** Its designation from the workspace's list — none for a record made before the list, or without one. */
  designationName?: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  isPrimary: boolean;
  receivesDocuments: boolean;
  /** Email/phone were stripped server-side because this company belongs to a reseller. */
  detailsRedacted?: boolean;
};

/**
 * The workspace's own contact fields (src/lib/custom-fields), as the company page prepares them: the
 * inputs, and for each contact by id the values its edit form starts with and the ones its row shows.
 */
export type ContactCustomFields = {
  fields: CustomFieldDef[];
  people: CustomFieldPerson[];
  values: Record<string, CustomFieldFormValues>;
  shown: Record<string, { key: string; label: string; text: string }[]>;
};

const NO_CUSTOM_FIELDS: ContactCustomFields = { fields: [], people: [], values: {}, shown: {} };

/** A row's link-shaped actions (WhatsApp, LinkedIn), sized and coloured as its IconButtons are. */
const ICON = "inline-grid h-7 w-7 shrink-0 place-items-center rounded-base text-subtle transition-colors hover:bg-surface-sunken";

/**
 * The fields one contact's form offers. A reseller's end customer leaves out the contact-detail ones,
 * hidden like its email and phone — the server sent no values for them, and keeps them on a save.
 */
function formFields(contact: Contact, fields: CustomFieldDef[]): CustomFieldDef[] {
  return contact.detailsRedacted ? fields.filter((f) => !isContactDetailField(f.type)) : fields;
}

/** An error list without one field's — once that field has been changed. */
function withoutError(errors: Record<string, string>, key: string): Record<string, string> {
  if (!errors[key]) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

function ContactFields({
  register,
  errors,
  detailsHidden = false,
}: {
  register: UseFormRegister<FieldValues>;
  errors: FieldErrors<FieldValues>;
  /**
   * A reseller's end customer, for somebody who may not see its email and phone: the inputs would
   * only show blanks, so they are left out — and the save keeps both as stored (`updateContact`).
   */
  detailsHidden?: boolean;
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
        <DesignationInput id={`${id}-designation`} {...register("designationName")} />
      </div>
      {!detailsHidden && (
        <>
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
        </>
      )}
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${id}-linkedin`}>
          LinkedIn URL
        </Label>
        <Input id={`${id}-linkedin`} {...register("linkedinUrl")} />
      </div>
      {detailsHidden && (
        <p className="col-span-2 flex items-center gap-1.5 text-xs text-warning">
          <Lock className="h-3 w-3 shrink-0" />
          Email and phone are hidden on a reseller&apos;s customer — saving keeps them as they are.
        </p>
      )}
      <div className="col-span-2">
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" {...register("isPrimary")} />
          Primary contact
        </label>
        <label className="mt-1.5 flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" {...register("receivesDocuments")} />
          Receives invoices &amp; quotes — ticked when a document is emailed
        </label>
      </div>
    </div>
  );
}

function EditContactForm({ contact, custom, onClose }: { contact: Contact; custom: ContactCustomFields; onClose: () => void }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const fields = formFields(contact, custom.fields);
  const [customValues, setCustomValues] = useState<CustomFieldFormValues>(custom.values[contact.id] ?? {});
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  // Per instance, like ContactFields' own: the add form can be open beside this one.
  const customId = useId();
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
      designationName: contactRoleLabel(contact.designationName, contact.designation) ?? "",
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      linkedinUrl: contact.linkedinUrl ?? "",
      isPrimary: contact.isPrimary,
      receivesDocuments: contact.receivesDocuments,
    },
  });

  async function onSubmit(values: UpdateContactInput) {
    setServerError(null);
    const missing = missingRequired(fields, customValues);
    setCustomErrors(missing);
    if (Object.keys(missing).length > 0) return;
    // The workspace's own fields only when the form had some: without them, the save leaves them be.
    const result = await updateContact(fields.length > 0 ? { ...values, customFields: customValues } : values);
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
      <ContactFields register={register as unknown as UseFormRegister<FieldValues>} errors={errors} detailsHidden={contact.detailsRedacted} />
      {fields.length > 0 && (
        <div className="pt-1">
          <CustomFieldInputs
            fields={fields}
            values={customValues}
            people={custom.people}
            errors={customErrors}
            idPrefix={`${customId}-cf`}
            disabled={isSubmitting}
            onChange={(key, value) => {
              setCustomValues((v) => ({ ...v, [key]: value }));
              setCustomErrors((e) => withoutError(e, key));
            }}
          />
        </div>
      )}
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
  customFields = NO_CUSTOM_FIELDS,
  canMeet = false,
  left = {},
  moves = {},
}: {
  companyId: string;
  companyName: string;
  contacts: Contact[];
  /** Those who have left the company, by id, with the day they left as it reads — src/lib/contacts/left.ts. */
  left?: Record<string, string>;
  /** Where those who moved came from, and where those who left went (src/lib/contacts/moves.ts). */
  moves?: ContactMoves;
  /** The workspace's own contact fields — none when it has none this person sees. */
  customFields?: ContactCustomFields;
  /** Calendar is on: a meeting can be scheduled with somebody who has an address. */
  canMeet?: boolean;
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addCustom, setAddCustom] = useState<CustomFieldFormValues>({});
  const [addCustomErrors, setAddCustomErrors] = useState<Record<string, string>>({});
  const addId = useId();
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const deleteTarget = contacts.find((c) => c.id === deleteTargetId) ?? null;
  const [isPending, setIsPending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkNotice, setCheckNotice] = useState<string | null>(null);
  const [leavingId, setLeavingId] = useState<string | null>(null);
  const [leavePending, setLeavePending] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const leaving = contacts.find((c) => c.id === leavingId) ?? null;
  const current = contacts.filter((c) => !left[c.id]);
  const former = contacts.filter((c) => left[c.id]);

  // Leaving for another company: who they are there.
  const [joined, setJoined] = useState(false);
  const [joinCompany, setJoinCompany] = useState<CompanyComboOption | null>(null);
  const [join, setJoin] = useState({ email: "", phone: "", designationName: "" });

  function startLeaving(contactId: string) {
    setLeaveError(null);
    setJoined(false);
    setJoinCompany(null);
    setJoin({ email: "", phone: "", designationName: "" });
    setLeavingId(contactId);
  }

  function recordMove(contactId: string) {
    if (!joinCompany) return setLeaveError("Pick the company they've joined.");
    setLeaveError(null);
    setLeavePending(true);
    moveContact(contactId, { companyId: joinCompany.id, ...join }).then((result) => {
      setLeavePending(false);
      if (!result.ok) return setLeaveError(result.error);
      setLeavingId(null);
      router.refresh();
    });
  }

  function markLeft(contactId: string, hasLeft: boolean) {
    setLeaveError(null);
    setLeavePending(true);
    setContactLeft(contactId, hasLeft).then((result) => {
      setLeavePending(false);
      if (!result.ok) return setLeaveError(result.error);
      setLeavingId(null);
      router.refresh();
    });
  }

  // Offered only when there is something to check: a button that reports "checked 0" is noise on a
  // panel that already has plenty.
  const uncheckedCount = current.filter(
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
    defaultValues: { designation: "OTHER", designationName: "", isPrimary: false, receivesDocuments: false },
  });

  async function onAddSubmit(values: ContactInput) {
    setAddError(null);
    const missing = missingRequired(customFields.fields, addCustom);
    setAddCustomErrors(missing);
    if (Object.keys(missing).length > 0) return;
    const result = await addContact(companyId, { ...values, customFields: addCustom });
    if (!result.ok) {
      // Said rather than swallowed: a field of the workspace's own can be refused here too.
      setAddError(result.error);
      return;
    }
    reset({ name: "", designation: "OTHER", designationName: "", email: "", phone: "", linkedinUrl: "", isPrimary: false, receivesDocuments: false });
    setAddCustom({});
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
      {current.map((c) =>
        editingId === c.id ? (
          <EditContactForm key={c.id} contact={c} custom={customFields} onClose={() => setEditingId(null)} />
        ) : (
          <div key={c.id} className="flex items-start justify-between gap-3 text-sm">
            <div className="min-w-0 flex-1">
              {/* Who they are, on one line. */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium text-text">{c.name}</span>
                {contactRoleLabel(c.designationName, c.designation) && <span className="text-muted">{contactRoleLabel(c.designationName, c.designation)}</span>}
                {c.isPrimary && <Badge tone="blue">Primary</Badge>}
                {c.receivesDocuments && <Badge tone="green">Invoices</Badge>}
              </div>
              {/* How to reach them, and the workspace's own fields, on the next. */}
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                {c.detailsRedacted && (
                  <span className="flex items-center gap-1 rounded bg-warning-bg px-1.5 py-0.5 text-warning">
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
                    className="-mx-1.5 h-6 px-1.5 text-xs text-muted"
                  />
                )}
                {moves[c.id]?.previous && (
                  <Link
                    href={`${companyPath(moves[c.id]!.previous!.companySeq)}?tab=contacts`}
                    className="text-brand hover:underline"
                  >
                    Previously at {moves[c.id]!.previous!.companyName}
                  </Link>
                )}
                {(customFields.shown[c.id] ?? []).map((f) => (
                  <span key={f.key} className="min-w-0 break-words">
                    <span className="text-subtle">{f.label}:</span> {f.text}
                  </span>
                ))}
              </div>
            </div>
            <RowActions className="shrink-0">
              {canMeet && c.email && !c.detailsRedacted && (
                <ScheduleMeetingButton
                  record={{ kind: "contact", id: c.id }}
                  size="icon"
                  variant="ghost"
                  label={`Schedule a meeting with ${c.name}`}
                  className="h-7 w-7 text-subtle hover:text-brand"
                />
              )}
              {c.phone && (
                <OutboundLink
                  href={whatsappHref(c.phone)}
                  className={`${ICON} hover:text-success`}
                  title={`WhatsApp ${c.name} (opens in a new tab)`}
                  aria-label={`WhatsApp ${c.name}, opens in a new tab`}
                >
                  <MessageCircle className="h-4 w-4" aria-hidden />
                </OutboundLink>
              )}
              {externalHref(c.linkedinUrl) && (
                <OutboundLink
                  href={externalHref(c.linkedinUrl)!}
                  className={`${ICON} hover:text-brand`}
                  title={`${c.name} on LinkedIn (opens in a new tab)`}
                  aria-label={`${c.name} on LinkedIn, opens in a new tab`}
                >
                  <LinkedInMark />
                </OutboundLink>
              )}
              <IconButton icon={Pencil} label="Edit contact" onClick={() => setEditingId(c.id)} />
              <IconButton
                icon={UserX}
                label={`${c.name} has left ${companyName}`}
                onClick={() => startLeaving(c.id)}
              />
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
      {current.length === 0 && (
        <p className="text-sm text-subtle">{former.length > 0 ? "Nobody here now — everybody listed has left." : "No contacts added."}</p>
      )}

      {/* Kept with their history, out of the way: nobody new is offered them (src/lib/contacts/left.ts). */}
      {former.length > 0 && (
        <details className="group rounded-base border border-line">
          <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-2 text-sm text-muted marker:hidden hover:text-text">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
            Left the company ({former.length})
          </summary>
          <div className="space-y-2 border-t border-line p-3">
            {former.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-muted">
                  <span className="font-medium">{c.name}</span>
                  {contactRoleLabel(c.designationName, c.designation) && <span>{contactRoleLabel(c.designationName, c.designation)}</span>}
                  <span className="text-xs text-subtle">Left {left[c.id]}</span>
                  {moves[c.id]?.next && (
                    <Link href={`${companyPath(moves[c.id]!.next!.companySeq)}?tab=contacts`} className="text-xs text-brand hover:underline">
                      Now at {moves[c.id]!.next!.companyName}
                    </Link>
                  )}
                  {c.email && !c.detailsRedacted && <span className="truncate text-xs text-subtle">{c.email}</span>}
                </div>
                <RowActions className="shrink-0">
                  <IconButton
                    icon={UserCheck}
                    label={`${c.name} is back at ${companyName}`}
                    disabled={leavePending}
                    onClick={() => markLeft(c.id, false)}
                  />
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
            ))}
            {leaveError && !leaving && (
              <p role="alert" className="text-xs text-danger">
                {leaveError}
              </p>
            )}
          </div>
        </details>
      )}

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
            {addError && <p className="text-xs text-danger">{addError}</p>}
            <ContactFields register={register as unknown as UseFormRegister<FieldValues>} errors={errors} />
            {customFields.fields.length > 0 && (
              <div className="pt-1">
                <CustomFieldInputs
                  fields={customFields.fields}
                  values={addCustom}
                  people={customFields.people}
                  errors={addCustomErrors}
                  idPrefix={`${addId}-cf`}
                  disabled={isSubmitting}
                  onChange={(key, value) => {
                    setAddCustom((v) => ({ ...v, [key]: value }));
                    setAddCustomErrors((e) => withoutError(e, key));
                  }}
                />
              </div>
            )}
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

      <Dialog open={!!leaving} onClose={() => setLeavingId(null)} title={`Has ${leaving?.name} left ${companyName}?`}>
        <p className="text-sm text-muted">
          They stay here with everything that happened with them, under &ldquo;Left the company&rdquo;. From now on they
          aren&apos;t the primary contact, aren&apos;t sent invoices or campaigns, aren&apos;t offered for meetings, calls or
          forms, and any customer-portal link of theirs stops working.
        </p>
        {leaving?.isPrimary && (
          <p className="mt-2 text-sm text-warning">They&apos;re the primary contact — make somebody else primary afterwards.</p>
        )}
        <label className="mt-3 flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={joined} onChange={(e) => setJoined(e.target.checked)} className="h-4 w-4" />
          They&apos;ve joined another company
        </label>
        {joined && (
          <div className="mt-2 space-y-2 rounded-md border border-line bg-surface-sunken p-3">
            <p className="text-xs text-muted">
              A record of them is made there with what&apos;s new, linked to this one — their history stays at each company it
              happened at.
            </p>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor={`${addId}-join-company`}>
                Company they&apos;ve joined
              </Label>
              <CompanyCombobox
                id={`${addId}-join-company`}
                companies={[]}
                value={joinCompany?.id ?? ""}
                onSelect={setJoinCompany}
                search={searchCompaniesToJoin}
                placeholder="Type two letters of its name…"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2 space-y-1">
                <Label className="text-xs" htmlFor={`${addId}-join-designation`}>
                  Designation there
                </Label>
                <DesignationInput
                  id={`${addId}-join-designation`}
                  value={join.designationName}
                  onChange={(e) => setJoin((j) => ({ ...j, designationName: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={`${addId}-join-email`}>
                  New email
                </Label>
                <Input id={`${addId}-join-email`} type="email" value={join.email} onChange={(e) => setJoin((j) => ({ ...j, email: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={`${addId}-join-phone`}>
                  New phone
                </Label>
                <Input id={`${addId}-join-phone`} value={join.phone} onChange={(e) => setJoin((j) => ({ ...j, phone: e.target.value }))} />
              </div>
            </div>
          </div>
        )}
        {leaveError && leaving && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {leaveError}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setLeavingId(null)} disabled={leavePending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => leaving && (joined ? recordMove(leaving.id) : markLeft(leaving.id, true))}
            disabled={leavePending}
          >
            {leavePending ? "Saving…" : joined ? "Record the move" : "They've left"}
          </Button>
        </div>
      </Dialog>

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
