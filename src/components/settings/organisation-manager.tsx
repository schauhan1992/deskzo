"use client";

import { useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, Trash2, Upload } from "lucide-react";
import {
  updateOrganisation,
  updateEInvoiceSettings,
  uploadSignature,
  removeSignature,
} from "@/actions/organisation";
import { saveRegistrationEInvoice, type RegistrationRow } from "@/actions/branch";
import type { Organisation } from "@/lib/organisation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, Badge } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { AddressFields } from "@/components/ui/address-fields";
import { GST_STATE_CODES, GST_STATE_OPTIONS, GSTIN_PATTERN, stateCodeFromName } from "@/lib/gst-engine";
import { isIndia } from "@/lib/geo/countries";
import { EINVOICE_PROVIDERS } from "@/lib/einvoice/provider";

export function OrganisationManager({
  organisation,
  multiBranch = false,
  headOffice = null,
}: {
  organisation: Organisation;
  /** More than one active branch: the GSTIN here is the head office's, and the others' are under Branches. */
  multiBranch?: boolean;
  /**
   * Set when the head office has an address of its own. Its GSTIN is then shown read-only and left out
   * of the save: it need not be the registered office's state, and it is changed under Branches.
   */
  headOffice?: { name: string; city: string | null; state: string | null } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    legalName: organisation.legalName,
    tradeName: organisation.tradeName ?? "",
    gstin: organisation.gstin ?? "",
    pan: organisation.pan ?? "",
    cin: organisation.cin ?? "",
    addressLine1: organisation.addressLine1 ?? "",
    addressLine2: organisation.addressLine2 ?? "",
    city: organisation.city ?? "",
    state: organisation.state ?? "",
    stateCode: organisation.stateCode ?? "",
    pincode: organisation.pincode ?? "",
    country: organisation.country ?? "",
    email: organisation.email ?? "",
    phone: organisation.phone ?? "",
    bankName: organisation.bankName ?? "",
    bankAccountNumber: organisation.bankAccountNumber ?? "",
    bankIfsc: organisation.bankIfsc ?? "",
    bankBranch: organisation.bankBranch ?? "",
    upiId: organisation.upiId ?? "",
    invoiceTerms: organisation.invoiceTerms ?? "",
    invoiceNotes: organisation.invoiceNotes ?? "",
  });
  const [roundOffTotals, setRoundOffTotals] = useState(organisation.roundOffTotals);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const signatureInput = useRef<HTMLInputElement>(null);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  /**
   * One registration, one state — and the GSTIN is the authority on which.
   *
   * Its first two digits *are* the GST state code, so typing it sets the code, and nothing else is
   * allowed to move the code while there is one. The address state used to move it: choosing
   * Haryana in the address of a company whose GSTIN starts 27 silently made it a Haryana seller,
   * which re-taxes every invoice from the wrong state and gets every e-invoice rejected. The server
   * now refuses that pair outright; these warnings say so before anybody presses Save.
   *
   * Not while the head office has an address of its own: its GSTIN is then not the registered
   * office's registration, so it decides nothing here — the registered office's code follows its
   * address, as it does before a company has a GSTIN.
   */
  const gstinLocked = headOffice !== null;
  const gstinState = !gstinLocked && GSTIN_PATTERN.test(form.gstin.trim().toUpperCase()) ? form.gstin.trim().slice(0, 2) : null;
  const effectiveCode = form.stateCode || gstinState || "";
  const codeDisagrees = Boolean(gstinState && form.stateCode && form.stateCode !== gstinState);
  const addressCode = stateCodeFromName(form.state);
  const addressDisagrees = Boolean(addressCode && effectiveCode && addressCode !== effectiveCode && !codeDisagrees);

  function save() {
    setError(null);
    setSaved(false);
    // Without a `gstin` key the action leaves the head office's registration as it is.
    const payload: Record<string, unknown> = { ...form, roundOffTotals };
    if (gstinLocked) delete payload.gstin;
    startTransition(async () => {
      const result = await updateOrganisation(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  function uploadSignatureFile(file: File) {
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      startTransition(async () => {
        const result = await uploadSignature(String(reader.result));
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      });
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="text-sm font-medium text-text">Registered details</CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Legal name" hint="Exactly as registered — this is what prints on every invoice.">
            {(id) => <Input id={id} value={form.legalName} onChange={set("legalName")} />}
          </Field>
          <Field label="Trade name">
            {(id) => <Input id={id} value={form.tradeName} onChange={set("tradeName")} />}
          </Field>
          <Field
            label={multiBranch || headOffice ? "GSTIN (head office)" : "GSTIN"}
            hint={
              headOffice ? (
                <>
                  The head office{headOffice.name.trim().toLowerCase() === "head office" ? "" : ` (${headOffice.name})`} has an
                  address of its own{headOffice.city || headOffice.state ? ` in ${headOffice.city || headOffice.state}` : ""}, so
                  its GSTIN is changed under{" "}
                  <Link href="/settings/branches" className="text-brand hover:underline">
                    Settings → Branches &amp; GST registrations
                  </Link>
                  .
                </>
              ) : multiBranch ? (
                <>
                  Other branches&apos; registrations are under{" "}
                  <Link href="/settings/branches" className="text-brand hover:underline">
                    Settings → Branches &amp; GST registrations
                  </Link>
                  .
                </>
              ) : (
                "The first two digits set your state code automatically."
              )
            }
          >
            {(id) =>
              headOffice ? (
                <Input id={id} value={form.gstin} readOnly placeholder="None yet" className="bg-surface-sunken font-mono" />
              ) : (
                <Input
                  id={id}
                  value={form.gstin}
                  onChange={(e) => {
                    const gstin = e.target.value;
                    const prefix = GSTIN_PATTERN.test(gstin.trim().toUpperCase()) ? gstin.trim().slice(0, 2) : null;
                    // What the hint below the field has always promised, now done where it can be seen.
                    setForm((prev) => ({ ...prev, gstin, ...(prefix ? { stateCode: prefix } : {}) }));
                  }}
                  placeholder="27AABCW1234F1ZV"
                  className="font-mono"
                />
              )
            }
          </Field>
          <Field label="PAN">
            {(id) => <Input id={id} value={form.pan} onChange={set("pan")} className="font-mono" />}
          </Field>
          <Field label="CIN">
            {(id) => <Input id={id} value={form.cin} onChange={set("cin")} className="font-mono" />}
          </Field>
          <Field label="GST state code" hint="Decides CGST + SGST versus IGST on every document.">
            {(id) => (
              <>
                <Select id={id} value={form.stateCode} onChange={set("stateCode")}>
                  <option value="">Derive from GSTIN</option>
                  {GST_STATE_OPTIONS.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.code} — {s.name}
                    </option>
                  ))}
                </Select>
                {codeDisagrees && gstinState && (
                  <p className="text-xs text-danger">
                    Your GSTIN is registered in {GST_STATE_CODES[gstinState]} ({gstinState}). Saved like this, every invoice
                    would be taxed from the wrong state and e-invoices rejected — so it won&apos;t save.{" "}
                    <button
                      type="button"
                      className="font-medium underline underline-offset-2"
                      onClick={() => setForm((prev) => ({ ...prev, stateCode: gstinState }))}
                    >
                      Use {gstinState} — {GST_STATE_CODES[gstinState]}
                    </button>
                  </p>
                )}
              </>
            )}
          </Field>

          <Field label="Address line 1" className="sm:col-span-2">
            {(id) => <Input id={id} value={form.addressLine1} onChange={set("addressLine1")} />}
          </Field>
          <Field label="Address line 2">
            {(id) => <Input id={id} value={form.addressLine2} onChange={set("addressLine2")} />}
          </Field>
          {/**
            * The address state sets the GST code only while there is no GSTIN.
            *
            * This is the *seller* side of every document, so the address state and the code
            * disagreeing means invoices computed from one answer and printed with the other. With no
            * GSTIN yet, picking the state is the best evidence of the code, so it sets it. Once there
            * is a GSTIN, the GSTIN decides — a registration is in one state — and an address in a
            * different state is flagged below rather than allowed to move the tax.
            */}
          <div className="sm:col-span-2">
            <AddressFields
              columns={3}
              country={form.country}
              state={form.state}
              city={form.city}
              pincode={form.pincode}
              onChange={(patch) =>
                setForm((prev) => ({
                  ...prev,
                  ...patch,
                  // Only with no GSTIN to decide it — see `gstinState` above.
                  // And only in India: a state abroad is no GST state, whatever it is called.
                  ...(patch.state !== undefined && !gstinState && isIndia(patch.country ?? prev.country)
                    ? { stateCode: GST_STATE_OPTIONS.find((s) => s.name === patch.state)?.code ?? prev.stateCode }
                    : {}),
                }))
              }
            />
            {addressDisagrees && addressCode && (
              <p className="mt-1.5 text-xs text-warning">
                The registered address is in {GST_STATE_CODES[addressCode]}, but your GST registration is in{" "}
                {GST_STATE_CODES[effectiveCode]}. The address on a GST registration is in the state it was issued
                for — worth checking which of the two is wrong.
              </p>
            )}
          </div>
          <Field label="Email">
            {(id) => <Input id={id} type="email" value={form.email} onChange={set("email")} />}
          </Field>
          <Field label="Phone">
            {(id) => <Input id={id} value={form.phone} onChange={set("phone")} />}
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Bank details</CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Bank name">
            {(id) => <Input id={id} value={form.bankName} onChange={set("bankName")} />}
          </Field>
          <Field label="Account number">
            {(id) => (
              <Input id={id} value={form.bankAccountNumber} onChange={set("bankAccountNumber")} className="font-mono" />
            )}
          </Field>
          <Field label="IFSC">
            {(id) => <Input id={id} value={form.bankIfsc} onChange={set("bankIfsc")} className="font-mono" />}
          </Field>
          <Field label="Branch">
            {(id) => <Input id={id} value={form.bankBranch} onChange={set("bankBranch")} />}
          </Field>
          <Field label="UPI ID">
            {(id) => <Input id={id} value={form.upiId} onChange={set("upiId")} />}
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Invoice defaults</CardHeader>
        <CardContent className="space-y-4">
          <Field label="Default terms & conditions" hint="Pre-filled on every new document; editable per document.">
            {(id) => <Textarea id={id} rows={4} value={form.invoiceTerms} onChange={set("invoiceTerms")} />}
          </Field>
          <Field label="Footer note" hint="Printed at the bottom of every document.">
            {(id) => <Textarea id={id} rows={2} value={form.invoiceNotes} onChange={set("invoiceNotes")} />}
          </Field>

          <label className="flex items-start gap-2.5 text-sm text-text">
            <input
              type="checkbox"
              checked={roundOffTotals}
              onChange={(e) => setRoundOffTotals(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--brand)]"
            />
            <span>
              Round document totals to the nearest rupee
              <span className="block text-xs text-subtle">
                Usual on an Indian invoice — the difference prints as its own round-off line. Turn it off to bill to
                the paisa.
              </span>
            </span>
          </label>

          <div className="space-y-1.5">
            <Label>Signature / stamp</Label>
            <div className="flex items-center gap-3">
              {organisation.signatureDataUrl ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={organisation.signatureDataUrl}
                    alt="Signature"
                    className="h-14 w-auto rounded-base border border-line bg-white object-contain p-1"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => startTransition(async () => {
                      await removeSignature();
                      router.refresh();
                    })}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove
                  </Button>
                </>
              ) : (
                <>
                  <input
                    ref={signatureInput}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) uploadSignatureFile(file);
                      e.target.value = "";
                    }}
                  />
                  <Button type="button" variant="secondary" size="sm" onClick={() => signatureInput.current?.click()}>
                    <Upload className="h-3.5 w-3.5" /> Upload
                  </Button>
                  <span className="text-xs text-subtle">PNG, JPEG or WebP, up to 256KB.</span>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save organisation details"}
        </Button>
        {saved && (
          <span className="flex items-center gap-1 text-sm text-success">
            <Check className="h-4 w-4" /> Saved
          </span>
        )}
      </div>

    </div>
  );
}

/** Short names for a status badge; the select below has the long ones. */
const PROVIDER_LABELS: Record<string, string> = { mock: "Mock", nic_sandbox: "NIC sandbox", nic_production: "NIC production" };

/**
 * e-Invoicing: the company's switch and minimum, then one IRP login per GST registration.
 *
 * The switch is the company's because the mandate follows the PAN's turnover, not one GSTIN's (CA
 * question C5); the login is per registration because the NIC issues API users per GSTIN, and e-way
 * bills sign in with the same one. With a single registration this is the form it always was, split
 * at the line between the two saves.
 */
export function EInvoiceSettings({ organisation, registrations }: { organisation: Organisation; registrations: RegistrationRow[] }) {
  const active = registrations.filter((r) => r.active);
  const inactive = registrations.filter((r) => !r.active);

  return (
    <div className="space-y-6">
      <EInvoiceSwitch organisation={organisation} acrossRegistrations={active.length > 1} />

      {active.length === 0 && (
        <Card className="px-4 py-3 text-sm text-muted">
          {registrations.length === 0 ? "No GST registration yet" : "No active GST registration"} — add one under{" "}
          <Link href="/settings/branches" className="text-brand hover:underline">
            Branches &amp; GST registrations
          </Link>
          . The portal issues its login per GSTIN, so there is nothing to connect until there is one.
        </Card>
      )}

      {active.map((registration) => (
        <RegistrationConnection key={registration.id} registration={registration} />
      ))}

      {inactive.length > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-sm text-muted marker:hidden hover:text-text">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
            Inactive registrations ({inactive.length})
            <span className="text-subtle">— kept for cancelling IRNs issued in the last 24 hours</span>
          </summary>
          <div className="mt-3 space-y-6">
            {inactive.map((registration) => (
              <RegistrationConnection key={registration.id} registration={registration} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** The company-wide half: whether IRNs are generated at all, and below what value they are not. */
function EInvoiceSwitch({ organisation, acrossRegistrations }: { organisation: Organisation; acrossRegistrations: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(organisation.einvoiceEnabled);
  const [minValue, setMinValue] = useState(organisation.einvoiceMinValue?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      // Only the two company-wide fields: the logins are saved per registration, below.
      const result = await updateEInvoiceSettings({ einvoiceEnabled: enabled, einvoiceMinValue: minValue });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
        <span>e-Invoicing (IRP)</span>
        {enabled ? <Badge tone="green">On</Badge> : <Badge tone="default">Off</Badge>}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted">
          Generates an IRN and signed QR code with the government portal when a tax invoice or credit note is
          issued. Start on <span className="font-medium text-text">Mock</span> to exercise the whole flow without a
          portal account, move to the NIC sandbox once you have credentials, then to production.
          {acrossRegistrations &&
            " The switch covers every GSTIN below — e-invoicing follows the company's turnover, so once one registration must, they all must."}
        </p>

        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-[var(--brand)]"
          />
          Generate e-invoices automatically when an invoice is issued
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Minimum invoice value" hint="Invoices below this skip IRN generation. Leave blank for none.">
            {(id) => <Input id={id} type="number" min="0" value={minValue} onChange={(e) => setMinValue(e.target.value)} />}
          </Field>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save e-invoice settings"}
          </Button>
          {saved && (
            <span className="flex items-center gap-1 text-sm text-success">
              <Check className="h-4 w-4" /> Saved
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One registration's IRP login. Stored secrets are never sent back to the browser — the fields say
 * whether one is on file and stay blank, so saving without retyping them leaves them untouched.
 */
function RegistrationConnection({ registration }: { registration: RegistrationRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const stored = registration.einvoice;
  const [provider, setProvider] = useState(stored.provider ?? "");
  const [username, setUsername] = useState(stored.username ?? "");
  const [password, setPassword] = useState("");
  const [clientId, setClientId] = useState(stored.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Mock needs no login and "not set up" sends nothing; only the NIC portal asks for all four.
  const nic = provider === "nic_sandbox" || provider === "nic_production";

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveRegistrationEInvoice({
        gstRegistrationId: registration.id,
        provider,
        username,
        password,
        clientId,
        clientSecret,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPassword("");
      setClientSecret("");
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span className="flex flex-wrap items-center gap-2">
          <span>
            <span className="font-mono">{registration.gstin}</span> · {registration.stateName}
          </span>
          {registration.isHeadOffice && <Badge tone="brand">Head office</Badge>}
          {!registration.active && <Badge>Inactive</Badge>}
        </span>
        {stored.provider ? (
          <Badge tone="green">Connected — {PROVIDER_LABELS[stored.provider] ?? stored.provider}</Badge>
        ) : (
          <Badge tone="amber">Not set up</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Provider">
            {(id) => (
              <Select id={id} value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="">Not set up</option>
                {EINVOICE_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {nic && (
            <>
              <Field label="Portal username">
                {(id) => (
                  <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
                )}
              </Field>
              <Field label="Portal password">
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    placeholder={stored.hasPassword ? "Saved — leave blank to keep" : ""}
                  />
                )}
              </Field>
              <Field label="Client ID">
                {(id) => (
                  <Input id={id} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
                )}
              </Field>
              <Field label="Client secret">
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    autoComplete="new-password"
                    placeholder={stored.hasClientSecret ? "Saved — leave blank to keep" : ""}
                  />
                )}
              </Field>
            </>
          )}
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save connection"}
          </Button>
          {saved && (
            <span className="flex items-center gap-1 text-sm text-success">
              <Check className="h-4 w-4" /> Saved
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * A caption above a control is not a label — the accessibility tree only joins the two when the
 * `<label>` names the control's id. So `Field` mints the id itself and hands it to the child, which
 * keeps the pairing impossible to forget and the wording in one place. `useId` rather than the
 * field key because nothing stops two of these cards being on screen at once.
 */
function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  className?: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  );
}
