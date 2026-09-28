"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { LoaderCircle, UserPlus } from "lucide-react";
import { partnerRequestReseller } from "@/actions/partners/resellers";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { TextAreaField, TextField } from "@/components/partners/common/fields";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/input";
import { COUNTRIES } from "@/lib/geo/countries";

type ProposeAction = ReturnType<typeof useConsoleAction<{ id: string }>>;

/** A plain shape test so the button answers at once; the server's check is the one that counts. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY_NAMES = new Map(COUNTRIES.map((c) => [c.code, c.name]));
const nameOf = (code: string) => COUNTRY_NAMES.get(code) ?? code;

/**
 * "Request a new reseller" (a distributor's ADMIN): a company to sell under this distributor, inside
 * its own territories (the only ones offered here — the server checks again). Platform staff review
 * the proposal; approved, they set the reseller up under this distributor and invite its contact as
 * its first admin (src/actions/partners/resellers.ts partnerRequestReseller). At most ten wait at once.
 */
export function RequestResellerButton({ territories }: { territories: string[] }) {
  const action = useConsoleAction<{ id: string }>();
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
        size="sm"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <UserPlus aria-hidden="true" className="h-4 w-4" />
        Request a new reseller
      </Button>
      <Dialog open={open} onClose={close} title="Request a new reseller">
        {open && <ProposeForm territories={territories} action={action} onDone={() => setOpen(false)} onCancel={close} />}
      </Dialog>
    </>
  );
}

function ProposeForm({ territories, action, onDone, onCancel }: { territories: string[]; action: ProposeAction; onDone: () => void; onCancel: () => void }) {
  const firstRef = useRef<HTMLInputElement>(null);
  const countryId = useId();
  const [legalName, setLegalName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [country, setCountry] = useState(territories.length === 1 ? territories[0]! : "");
  const [chosen, setChosen] = useState<string[]>(territories.length === 1 ? [territories[0]!] : []);
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => firstRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const clean = (text: string) => text.replace(/\s+/g, " ").trim();
  const legalOk = clean(legalName).length >= 2 && clean(legalName).length <= 200;
  const displayOk = clean(displayName).length >= 2 && clean(displayName).length <= 120;
  const contactOk = clean(contactName).length >= 2 && clean(contactName).length <= 120;
  const emailOk = EMAIL.test(contactEmail.trim());
  const ready = legalOk && displayOk && !!country && chosen.length > 0 && contactOk && emailOk;

  function toggle(code: string, on: boolean) {
    setChosen((list) => (on ? [...list.filter((c) => c !== code), code] : list.filter((c) => c !== code)));
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTried(true);
    if (!ready || action.pending) return;
    const name = clean(displayName);
    action.run(
      () =>
        partnerRequestReseller({
          legalName: clean(legalName),
          displayName: name,
          country,
          // In the order the distributor's territories are listed, whatever order they were ticked in.
          territories: territories.filter((c) => chosen.includes(c)),
          contactName: clean(contactName),
          contactEmail: contactEmail.trim(),
          note: note.trim() || null,
        }),
      { success: `${name} is proposed — platform staff will review it.`, onDone },
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 p-0.5" aria-busy={action.pending || undefined}>
      <p className="text-sm text-muted">Platform staff review the proposal. Once it is approved they set the reseller up under your company and invite its contact as its first admin.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField inputRef={firstRef} label="Legal name" value={legalName} onChange={setLegalName} max={200} required readOnly={action.pending} error={tried && !legalOk ? "Give the company's legal name (2 to 200 characters)." : null} />
        <TextField label="Display name" value={displayName} onChange={setDisplayName} max={120} required readOnly={action.pending} error={tried && !displayOk ? "Give the name to show (2 to 120 characters)." : null} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={countryId}>
          Country the company is established in
          <span aria-hidden="true" className="ml-0.5 text-danger">
            *
          </span>
        </Label>
        <Select id={countryId} value={country} onChange={(e) => setCountry(e.target.value)} disabled={action.pending} aria-required="true" aria-invalid={tried && !country ? true : undefined}>
          <option value="">Choose a country</option>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </Select>
        {tried && !country && <p className="text-xs text-danger">Choose the country the company is established in.</p>}
      </div>
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-[13px] font-medium text-muted">
          Territories it would sell in
          <span aria-hidden="true" className="ml-0.5 text-danger">
            *
          </span>
        </legend>
        <p className="text-xs text-muted">Only your own territories can be given to a reseller.</p>
        <div className="grid max-h-48 gap-1 overflow-y-auto rounded-lg border border-line p-2 sm:grid-cols-2">
          {territories.map((code) => (
            <label key={code} className="flex cursor-pointer items-center gap-2 rounded-base px-2 py-1 text-sm text-text hover:bg-surface-sunken">
              <input type="checkbox" checked={chosen.includes(code)} onChange={(e) => toggle(code, e.target.checked)} disabled={action.pending} className="h-4 w-4 shrink-0 rounded border-line-strong accent-brand" />
              <span className="min-w-0 truncate">{`${nameOf(code)} (${code})`}</span>
            </label>
          ))}
        </div>
        {tried && chosen.length === 0 && <p className="text-xs text-danger">Choose at least one territory.</p>}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Contact name" value={contactName} onChange={setContactName} max={120} required readOnly={action.pending} error={tried && !contactOk ? "Give the contact's name (2 to 120 characters)." : null} />
        <TextField
          label="Contact email"
          type="email"
          inputMode="email"
          value={contactEmail}
          onChange={setContactEmail}
          max={254}
          required
          readOnly={action.pending}
          mono
          error={tried && !emailOk ? "That doesn't look like an email address." : null}
          hint="Invited as the reseller's first admin once it is approved."
        />
      </div>
      <TextAreaField label="Note for the platform" value={note} onChange={setNote} max={1000} readOnly={action.pending} rows={3} hint="Optional — who they are and why they would be a good reseller." />
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" aria-disabled={action.pending || undefined} aria-busy={action.pending || undefined} className={action.pending ? "cursor-wait opacity-70" : undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Send for review
        </Button>
      </div>
    </form>
  );
}
