"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Trash2, Upload } from "lucide-react";
import {
  updateOrganisation,
  updateEInvoiceSettings,
  uploadSignature,
  removeSignature,
} from "@/actions/organisation";
import type { Organisation } from "@/lib/organisation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, Badge } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { GST_STATE_OPTIONS } from "@/lib/gst-engine";
import { EINVOICE_PROVIDERS } from "@/lib/einvoice/provider";

export function OrganisationManager({ organisation }: { organisation: Organisation }) {
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

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateOrganisation({ ...form, roundOffTotals });
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
          <Field label="GSTIN" hint="The first two digits set your state code automatically.">
            {(id) => (
              <Input id={id} value={form.gstin} onChange={set("gstin")} placeholder="27AABCW1234F1ZV" className="font-mono" />
            )}
          </Field>
          <Field label="PAN">
            {(id) => <Input id={id} value={form.pan} onChange={set("pan")} className="font-mono" />}
          </Field>
          <Field label="CIN">
            {(id) => <Input id={id} value={form.cin} onChange={set("cin")} className="font-mono" />}
          </Field>
          <Field label="GST state code" hint="Decides CGST + SGST versus IGST on every document.">
            {(id) => (
              <Select id={id} value={form.stateCode} onChange={set("stateCode")}>
                <option value="">Derive from GSTIN</option>
                {GST_STATE_OPTIONS.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Address line 1" className="sm:col-span-2">
            {(id) => <Input id={id} value={form.addressLine1} onChange={set("addressLine1")} />}
          </Field>
          <Field label="Address line 2">
            {(id) => <Input id={id} value={form.addressLine2} onChange={set("addressLine2")} />}
          </Field>
          <Field label="City">
            {(id) => <Input id={id} value={form.city} onChange={set("city")} />}
          </Field>
          <Field label="State">
            {(id) => <Input id={id} value={form.state} onChange={set("state")} />}
          </Field>
          <Field label="PIN code">
            {(id) => <Input id={id} value={form.pincode} onChange={set("pincode")} placeholder="400001" />}
          </Field>
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

/**
 * The IRP credentials. Stored secrets are never sent back to the browser — the fields show whether
 * one is on file and stay blank, so saving the page without retyping them leaves them untouched.
 */
export function EInvoiceSettings({ organisation }: { organisation: Organisation }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(organisation.einvoiceEnabled);
  const [provider, setProvider] = useState(organisation.einvoiceProvider);
  const [username, setUsername] = useState(organisation.einvoiceUsername ?? "");
  const [password, setPassword] = useState("");
  const [clientId, setClientId] = useState(organisation.einvoiceClientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [minValue, setMinValue] = useState(organisation.einvoiceMinValue?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isMock = provider === "mock";

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateEInvoiceSettings({
        einvoiceEnabled: enabled,
        einvoiceProvider: provider,
        einvoiceUsername: username,
        einvoicePassword: password,
        einvoiceClientId: clientId,
        einvoiceClientSecret: clientSecret,
        einvoiceMinValue: minValue,
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
      <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
        <span>e-Invoicing (IRP)</span>
        {enabled ? <Badge tone="green">On</Badge> : <Badge tone="default">Off</Badge>}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted">
          Generates an IRN and signed QR code with the government portal when a tax invoice or credit note is
          issued. Start on <span className="font-medium text-text">Mock</span> to exercise the whole flow without a
          portal account, move to the NIC sandbox once you have credentials, then to production.
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
          <Field label="Provider">
            {(id) => (
              <Select id={id} value={provider} onChange={(e) => setProvider(e.target.value)}>
                {EINVOICE_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {!isMock && (
            <>
              <Field label="Portal username">
                {(id) => (
                  <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
                )}
              </Field>
              <Field
                label="Portal password"
                hint={organisation.hasPassword ? "A password is saved — leave blank to keep it." : undefined}
              >
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    placeholder={organisation.hasPassword ? "••••••••" : ""}
                  />
                )}
              </Field>
              <Field label="Client ID">
                {(id) => (
                  <Input id={id} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
                )}
              </Field>
              <Field
                label="Client secret"
                hint={organisation.hasClientSecret ? "A secret is saved — leave blank to keep it." : undefined}
              >
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    autoComplete="new-password"
                    placeholder={organisation.hasClientSecret ? "••••••••" : ""}
                  />
                )}
              </Field>
            </>
          )}

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
  hint?: string;
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
