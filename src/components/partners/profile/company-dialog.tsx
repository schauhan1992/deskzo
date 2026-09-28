"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { LoaderCircle, Pencil } from "lucide-react";
import { partnerUpdateProfile } from "@/actions/partners/profile";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { TextAreaField, TextField } from "@/components/partners/common/fields";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { PartnerSelfInput } from "@/lib/partners/registry";

/** What an ADMIN changes directly — everything else is a request staff review. */
export type CompanyFields = { displayName: string; contactPhone: string | null; website: string | null; publicListing: boolean; publicBlurb: string | null };

type EditAction = ReturnType<typeof useConsoleAction<{ changed: string[] }>>;

/**
 * "Edit company details" (ADMIN): the name the portal and the platform show, the phone and website,
 * and whether — and how — the company appears in the public partner directory
 * (src/actions/partners/profile.ts partnerUpdateProfile). Only the fields that changed are sent;
 * the server checks each again and says what is wrong. The form starts from what is on file.
 */
export function EditCompanyButton({ initial }: { initial: CompanyFields }) {
  const action = useConsoleAction<{ changed: string[] }>();
  const [open, setOpen] = useState(false);

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <Pencil aria-hidden="true" className="h-4 w-4" />
        Edit company details
      </Button>
      <Dialog open={open} onClose={close} title="Edit company details">
        {open && <CompanyForm initial={initial} action={action} onDone={() => setOpen(false)} onCancel={close} />}
      </Dialog>
    </>
  );
}

const orNull = (text: string) => (text.trim() ? text.trim() : null);

function CompanyForm({ initial, action, onDone, onCancel }: { initial: CompanyFields; action: EditAction; onDone: () => void; onCancel: () => void }) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [phone, setPhone] = useState(initial.contactPhone ?? "");
  const [website, setWebsite] = useState(initial.website ?? "");
  const [listed, setListed] = useState(initial.publicListing);
  const [blurb, setBlurb] = useState(initial.publicBlurb ?? "");

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const cleanName = displayName.replace(/\s+/g, " ").trim();
  const nameOk = cleanName.length >= 2 && cleanName.length <= 120;
  const change: PartnerSelfInput = {
    ...(cleanName !== initial.displayName ? { displayName: cleanName } : {}),
    ...(orNull(phone) !== (initial.contactPhone ?? null) ? { contactPhone: orNull(phone) } : {}),
    ...(orNull(website) !== (initial.website ?? null) ? { website: orNull(website) } : {}),
    ...(listed !== initial.publicListing ? { publicListing: listed } : {}),
    ...(orNull(blurb) !== (initial.publicBlurb ?? null) ? { publicBlurb: orNull(blurb) } : {}),
  };
  const changed = Object.keys(change).length > 0;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!changed || !nameOk || action.pending) return;
    action.run(() => partnerUpdateProfile(change), { success: "Company details saved.", onDone });
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 p-0.5" aria-busy={action.pending || undefined}>
      <TextField
        inputRef={nameRef}
        label="Display name"
        value={displayName}
        onChange={setDisplayName}
        max={120}
        required
        readOnly={action.pending}
        error={!nameOk ? "Give the name to show (2 to 120 characters)." : null}
        hint="How your company is named in the portal and to your customers."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Phone" type="tel" inputMode="tel" value={phone} onChange={setPhone} max={32} readOnly={action.pending} autoComplete="off" />
        <TextField label="Website" type="url" inputMode="url" value={website} onChange={setWebsite} max={200} readOnly={action.pending} placeholder="example.com" mono />
      </div>
      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 hover:bg-surface-sunken">
        <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} disabled={action.pending} className="mt-0.5 h-4 w-4 shrink-0 rounded border-line-strong accent-brand" />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-text">List us in the public partner directory</span>
          <span className="mt-0.5 block text-xs text-muted">It shows your display name, territories, website and the description below — only while the platform has the directory switched on.</span>
        </span>
      </label>
      <TextAreaField label="Public description" value={blurb} onChange={setBlurb} max={300} readOnly={action.pending} rows={3} hint="One or two sentences for the directory." />
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!changed || !nameOk} aria-disabled={action.pending || undefined} aria-busy={action.pending || undefined} className={action.pending ? "cursor-wait opacity-70" : undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Save details
        </Button>
      </div>
    </form>
  );
}
