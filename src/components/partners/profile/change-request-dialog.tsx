"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { FilePenLine, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { partnerRequestProfileChange } from "@/actions/partners/profile";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { TextField } from "@/components/partners/common/fields";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Select } from "@/components/ui/input";
import { COUNTRIES } from "@/lib/geo/countries";
import type { PartnerAddress } from "@/lib/partners/portal-data";
import type { ProfileChangeInput } from "@/lib/partners/requests";
import { TAX_ID_KINDS } from "@/lib/partners/types";

/** The legal and contact details on file, as the change form starts from them. */
export type LegalFields = { legalName: string; country: string; contactName: string; contactEmail: string; address: PartnerAddress; taxIds: { kind: string; value: string }[] };

type RequestAction = ReturnType<typeof useConsoleAction<{ id: string }>>;
type TaxRow = { key: number; kind: string; value: string };

/** At most four tax ids (src/lib/partners/registry.ts cleanTaxIds). */
const MAX_TAX_IDS = 4;

/**
 * "Request a change" (ADMIN): the company's legal name, country, contact, address and tax ids are the
 * ones statements and payments are made out to, so a change is a request that platform staff review
 * (src/actions/partners/profile.ts partnerRequestProfileChange) — the details on file stay until they
 * approve it. The form starts from what is on file; only what was changed is sent. One request may
 * wait at a time, and the server says so.
 */
export function RequestChangeButton({ current }: { current: LegalFields }) {
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
        variant="secondary"
        size="sm"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <FilePenLine aria-hidden="true" className="h-4 w-4" />
        Request a change
      </Button>
      <Dialog open={open} onClose={close} title="Request a change to your legal details">
        {open && <ChangeForm current={current} action={action} onDone={() => setOpen(false)} onCancel={close} />}
      </Dialog>
    </>
  );
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim() === (b ?? "").trim();

function ChangeForm({ current, action, onDone, onCancel }: { current: LegalFields; action: RequestAction; onDone: () => void; onCancel: () => void }) {
  const firstRef = useRef<HTMLInputElement>(null);
  const countryId = useId();
  const [legalName, setLegalName] = useState(current.legalName);
  const [country, setCountry] = useState(current.country);
  const [contactName, setContactName] = useState(current.contactName);
  const [contactEmail, setContactEmail] = useState(current.contactEmail);
  const [line1, setLine1] = useState(current.address.line1 ?? "");
  const [line2, setLine2] = useState(current.address.line2 ?? "");
  const [city, setCity] = useState(current.address.city ?? "");
  const [region, setRegion] = useState(current.address.region ?? "");
  const [postalCode, setPostalCode] = useState(current.address.postalCode ?? "");
  const [taxIds, setTaxIds] = useState<TaxRow[]>(() => current.taxIds.map((t, i) => ({ key: i, kind: t.kind, value: t.value })));
  const [nextKey, setNextKey] = useState(current.taxIds.length);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => firstRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const addressChanged =
    !same(line1, current.address.line1) || !same(line2, current.address.line2) || !same(city, current.address.city) || !same(region, current.address.region) || !same(postalCode, current.address.postalCode);
  const typedTaxIds = taxIds.filter((t) => t.value.trim()).map((t) => ({ kind: t.kind, value: t.value.trim() }));
  const taxChanged = JSON.stringify(typedTaxIds) !== JSON.stringify(current.taxIds.map((t) => ({ kind: t.kind, value: t.value.trim() })));
  const change: ProfileChangeInput = {
    ...(!same(legalName, current.legalName) ? { legalName: legalName.trim() } : {}),
    ...(country !== current.country ? { country } : {}),
    ...(!same(contactName, current.contactName) ? { contactName: contactName.trim() } : {}),
    ...(!same(contactEmail, current.contactEmail) ? { contactEmail: contactEmail.trim() } : {}),
    ...(addressChanged ? { address: { line1: line1.trim() || null, line2: line2.trim() || null, city: city.trim() || null, region: region.trim() || null, postalCode: postalCode.trim() || null } } : {}),
    ...(taxChanged ? { taxIds: typedTaxIds } : {}),
  };
  const changed = Object.keys(change).length > 0;

  function addTaxId() {
    setTaxIds((rows) => [...rows, { key: nextKey, kind: "GSTIN", value: "" }]);
    setNextKey((n) => n + 1);
  }

  function setTaxRow(key: number, patch: Partial<TaxRow>) {
    setTaxIds((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!changed || action.pending) return;
    action.run(() => partnerRequestProfileChange(change), { success: "Change sent for review. The details on file stay as they are until it is approved.", onDone });
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 p-0.5" aria-busy={action.pending || undefined}>
      <p className="text-sm text-muted">Platform staff review a change to these details before it takes effect. The answer appears under Requests on this page.</p>
      <TextField inputRef={firstRef} label="Legal name" value={legalName} onChange={setLegalName} max={200} required readOnly={action.pending} />
      <div className="space-y-1.5">
        <Label htmlFor={countryId}>Country the company is established in</Label>
        <Select id={countryId} value={country} onChange={(e) => setCountry(e.target.value)} disabled={action.pending}>
          {!COUNTRIES.some((c) => c.code === country) && <option value={country}>{country || "Choose a country"}</option>}
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Contact name" value={contactName} onChange={setContactName} max={120} required readOnly={action.pending} />
        <TextField label="Contact email" type="email" inputMode="email" value={contactEmail} onChange={setContactEmail} max={254} required readOnly={action.pending} mono />
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-1 text-[13px] font-medium text-muted">Address</legend>
        <TextField label="Address line 1" value={line1} onChange={setLine1} max={200} readOnly={action.pending} />
        <TextField label="Address line 2" value={line2} onChange={setLine2} max={200} readOnly={action.pending} />
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField label="City" value={city} onChange={setCity} max={120} readOnly={action.pending} />
          <TextField label="State or region" value={region} onChange={setRegion} max={120} readOnly={action.pending} />
          <TextField label="Postal code" value={postalCode} onChange={setPostalCode} max={20} readOnly={action.pending} />
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] font-medium text-muted">Tax ids</legend>
        {taxIds.length === 0 && <p className="text-xs text-muted">None on file.</p>}
        {taxIds.map((row, i) => (
          <TaxIdRow key={row.key} row={row} index={i} disabled={action.pending} onChange={(patch) => setTaxRow(row.key, patch)} onRemove={() => setTaxIds((rows) => rows.filter((r) => r.key !== row.key))} />
        ))}
        {taxIds.length < MAX_TAX_IDS && (
          <Button type="button" variant="ghost" size="sm" onClick={addTaxId} disabled={action.pending}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add a tax id
          </Button>
        )}
      </fieldset>

      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!changed} aria-disabled={action.pending || undefined} aria-busy={action.pending || undefined} className={action.pending ? "cursor-wait opacity-70" : undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Send for review
        </Button>
      </div>
    </form>
  );
}

function TaxIdRow({ row, index, disabled, onChange, onRemove }: { row: TaxRow; index: number; disabled: boolean; onChange: (patch: Partial<TaxRow>) => void; onRemove: () => void }) {
  const id = useId();
  const kindId = `${id}-kind`;
  const valueId = `${id}-value`;
  return (
    <div className="flex items-end gap-2">
      <div className="w-32 shrink-0 space-y-1.5">
        <Label htmlFor={kindId}>{`Kind ${index + 1}`}</Label>
        <Select id={kindId} value={row.kind} onChange={(e) => onChange({ kind: e.target.value })} disabled={disabled}>
          {!(TAX_ID_KINDS as readonly string[]).includes(row.kind) && <option value={row.kind}>{row.kind}</option>}
          {TAX_ID_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <Label htmlFor={valueId}>{`Tax id ${index + 1}`}</Label>
        <Input id={valueId} value={row.value} onChange={(e) => onChange({ value: e.target.value })} readOnly={disabled} maxLength={40} autoComplete="off" spellCheck={false} data-1p-ignore="" className="font-mono text-[13px]" />
      </div>
      <IconButton icon={Trash2} label={`Remove tax id ${index + 1}`} tone="danger" onClick={onRemove} disabled={disabled} className="mb-1" />
    </div>
  );
}
