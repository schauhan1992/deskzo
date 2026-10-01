"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { CheckCircle2, ImageUp } from "lucide-react";
import { uploadBrandingImage } from "@/actions/branding";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { NewUserCreated, NewUserForm, type CreatedUser } from "@/components/settings/new-user-dialog";
import { PhotoManager } from "@/components/profile/photo-manager";
import { TwoFactorSetup } from "@/components/profile/two-factor-setup";
import { COUNTRIES, DEFAULT_COUNTRY, isIndia } from "@/lib/geo/countries";
import { INDIAN_STATES } from "@/lib/geo/india";
import { GST_RATES } from "@/lib/side-rail";
import type { Role } from "@/lib/roles";
import type { CompanyProfileField, CompanyProfileInput, CompanyProfileIssues } from "@/lib/help/company-profile";
import { skuFrom, type HelpDraft, type HelpField, type ItemDraft, type ItemField } from "@/lib/help/onboarding-forms";
import type { OnboardingState } from "@/actions/onboarding";
import { cn } from "@/lib/utils";

/**
 * The onboarding wizard's steps, each with its own form where one fits in a dialog
 * (src/components/onboarding/onboarding-wizard.tsx). They reuse what the full pages use: the
 * organisation profile's action, the branding upload, the new-user form (which sends a setup link —
 * nobody's password is set here), `createItem`, the help links, the profile photo and the two-factor
 * enrolment. The wizard holds the drafts, so moving between steps loses nothing.
 */

/** A field marked invalid shows it in its border as well as in words. */
const INVALID_BORDER = "aria-[invalid=true]:border-danger";

/** The ids a field's hint and error get, joined for `aria-describedby`. */
export function describedBy(id: string, hint: boolean, error: string | null | undefined): string | undefined {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

/** A field's hint and its error, under it. */
function Note({ id, hint, error }: { id: string; hint?: ReactNode; error?: string | null }) {
  return (
    <>
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </>
  );
}

const invalid = (error: string | null | undefined) => (error ? true : undefined);

// ─── The company profile ─────────────────────────────────────────────────────────────────────────

export function ProfileStep({
  draft,
  issues,
  gstinLocked,
  onChange,
  onLeave,
}: {
  draft: CompanyProfileInput;
  issues: CompanyProfileIssues;
  gstinLocked: boolean;
  onChange: (patch: Partial<CompanyProfileInput>) => void;
  /** A field was left — the wizard checks it. */
  onLeave: (field: CompanyProfileField) => void;
}) {
  const india = isIndia(draft.country);
  const country = draft.country || DEFAULT_COUNTRY;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Label htmlFor="onb-legalName">Legal name</Label>
        <Input
          id="onb-legalName"
          className={INVALID_BORDER}
          value={draft.legalName}
          onChange={(e) => onChange({ legalName: e.target.value })}
          onBlur={() => onLeave("legalName")}
          autoComplete="organization"
          aria-invalid={invalid(issues.legalName)}
          aria-describedby={describedBy("onb-legalName", true, issues.legalName)}
        />
        <Note id="onb-legalName" hint="Exactly as registered — it prints on every quote and invoice." error={issues.legalName} />
      </div>

      {india && (
        <div className="sm:col-span-2">
          <Label htmlFor="onb-gstin">GSTIN</Label>
          <Input
            id="onb-gstin"
            value={draft.gstin}
            onChange={(e) => onChange({ gstin: e.target.value.toUpperCase() })}
            onBlur={() => onLeave("gstin")}
            readOnly={gstinLocked}
            placeholder="27AABCW1234F1ZV"
            className={cn("font-mono", INVALID_BORDER, gstinLocked && "bg-surface-sunken")}
            autoComplete="off"
            aria-invalid={invalid(issues.gstin)}
            aria-describedby={describedBy("onb-gstin", true, issues.gstin)}
          />
          <Note
            id="onb-gstin"
            hint={
              gstinLocked ? (
                <>
                  Your head office has an address of its own, so its GSTIN is changed under{" "}
                  <Link href="/settings/branches" className="text-brand hover:underline">
                    Settings → Branches &amp; GST registrations
                  </Link>
                  .
                </>
              ) : (
                "Leave it blank if you aren't registered for GST — you can add it any time. Its first two digits set your state."
              )
            }
            error={issues.gstin}
          />
        </div>
      )}

      <div className="sm:col-span-2">
        <Label htmlFor="onb-addressLine1">Registered address</Label>
        <Input
          id="onb-addressLine1"
          className={INVALID_BORDER}
          value={draft.addressLine1}
          onChange={(e) => onChange({ addressLine1: e.target.value })}
          onBlur={() => onLeave("addressLine1")}
          placeholder="Building, street, area"
          autoComplete="address-line1"
          aria-invalid={invalid(issues.addressLine1)}
          aria-describedby={describedBy("onb-addressLine1", false, issues.addressLine1)}
        />
        <Note id="onb-addressLine1" error={issues.addressLine1} />
      </div>

      <div>
        <Label htmlFor="onb-country">Country</Label>
        <Select
          id="onb-country"
          value={country}
          // Moving country clears the state, as on the full profile: a state abroad is no GST state.
          onChange={(e) => onChange({ country: e.target.value, state: "", ...(isIndia(e.target.value) ? {} : { gstin: "" }) })}
        >
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.name}>
              {c.name}
            </option>
          ))}
          {!COUNTRIES.some((c) => c.name === country) && <option value={country}>{country}</option>}
        </Select>
      </div>

      <div>
        <Label htmlFor="onb-state">{india ? "State" : "State or region"}</Label>
        {india ? (
          <Select
            id="onb-state"
            className={INVALID_BORDER}
            value={draft.state}
            onChange={(e) => onChange({ state: e.target.value })}
            onBlur={() => onLeave("state")}
            aria-invalid={invalid(issues.state)}
            aria-describedby={describedBy("onb-state", false, issues.state)}
          >
            <option value="">Choose a state…</option>
            {INDIAN_STATES.map((s) => (
              <option key={s.code} value={s.name}>
                {s.name}
              </option>
            ))}
            {draft.state && !INDIAN_STATES.some((s) => s.name === draft.state) && <option value={draft.state}>{draft.state}</option>}
          </Select>
        ) : (
          <Input
            id="onb-state"
            className={INVALID_BORDER}
            value={draft.state}
            onChange={(e) => onChange({ state: e.target.value })}
            onBlur={() => onLeave("state")}
            autoComplete="address-level1"
            aria-invalid={invalid(issues.state)}
            aria-describedby={describedBy("onb-state", false, issues.state)}
          />
        )}
        <Note id="onb-state" error={issues.state} />
      </div>

      <div>
        <Label htmlFor="onb-city">City</Label>
        <Input
          id="onb-city"
          className={INVALID_BORDER}
          value={draft.city}
          onChange={(e) => onChange({ city: e.target.value })}
          onBlur={() => onLeave("city")}
          autoComplete="address-level2"
          aria-invalid={invalid(issues.city)}
          aria-describedby={describedBy("onb-city", false, issues.city)}
        />
        <Note id="onb-city" error={issues.city} />
      </div>

      <div>
        <Label htmlFor="onb-pincode">{india ? "PIN code" : "Postal code (if any)"}</Label>
        <Input
          id="onb-pincode"
          className={INVALID_BORDER}
          value={draft.pincode}
          onChange={(e) => onChange({ pincode: e.target.value })}
          onBlur={() => onLeave("pincode")}
          inputMode={india ? "numeric" : undefined}
          maxLength={india ? 7 : 20}
          autoComplete="postal-code"
          aria-invalid={invalid(issues.pincode)}
          aria-describedby={describedBy("onb-pincode", false, issues.pincode)}
        />
        <Note id="onb-pincode" error={issues.pincode} />
      </div>

      <p className="text-xs text-subtle sm:col-span-2">
        Bank details, PAN, terms and the rest are under{" "}
        <Link href="/settings/organisation" className="text-brand hover:underline">
          Settings → Profile
        </Link>{" "}
        whenever you want them.
      </p>
    </div>
  );
}

// ─── The logo ────────────────────────────────────────────────────────────────────────────────────

const MAX_LOGO_BYTES = 256 * 1024;

export function LogoStep({ logoDataUrl, onSaved }: { logoDataUrl: string | null; onSaved: () => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const shown = preview ?? logoDataUrl;

  function choose(file: File) {
    setError(null);
    if (file.size > MAX_LOGO_BYTES) {
      setError(`That image is ${Math.round(file.size / 1024)}KB — keep it under ${MAX_LOGO_BYTES / 1024}KB. Exporting it as a PNG or SVG usually does it.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      setPreview(dataUrl);
      startSaving(async () => {
        const result = await uploadBrandingImage("logo", dataUrl);
        if (!result.ok) {
          setError(result.error);
          setPreview(null);
          return;
        }
        onSaved();
      });
    };
    reader.onerror = () => setError("That file couldn't be read — try saving it again and choosing it once more.");
    reader.readAsDataURL(file);
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="grid h-20 w-40 shrink-0 place-items-center overflow-hidden rounded-xl border border-dashed border-line-strong bg-surface-sunken">
        {shown ? (
          // A data URL, so next/image has nothing to optimise.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shown} alt="Your logo" className="h-full w-full object-contain p-2" />
        ) : (
          <ImageUp className="h-6 w-6 text-subtle" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 space-y-2">
        <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => fileRef.current?.click()}>
          {shown ? "Choose another logo…" : "Choose a logo…"}
        </Button>
        <p className="max-w-sm text-xs text-subtle">PNG, JPEG, SVG or WebP, under 256KB. A wide logo works best.</p>
        {saving && (
          <p className="text-xs text-muted" role="status">
            Saving…
          </p>
        )}
        {error && (
          <p className="text-xs font-medium text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/webp"
        className="hidden"
        aria-label="Logo file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) choose(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}

// ─── The team ────────────────────────────────────────────────────────────────────────────────────

export function TeamStep({ team, done, onAdded }: { team: OnboardingState["team"]; done: boolean; onAdded: () => void }) {
  const [created, setCreated] = useState<CreatedUser | null>(null);
  const [attempt, setAttempt] = useState(0);

  if (!team) {
    return (
      <p className="text-sm text-muted">
        Adding people is done under{" "}
        <Link href="/settings/access" className="font-medium text-brand hover:underline">
          Settings → Users &amp; access
        </Link>
        {" "}— come back here when you have, and carry on.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {done && !created && (
        <p className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          Your team has started — add more people here, or carry on.
        </p>
      )}
      {created ? (
        <NewUserCreated
          created={created}
          onDone={() => {
            setCreated(null);
            setAttempt((n) => n + 1);
          }}
        />
      ) : (
        <NewUserForm
          key={attempt}
          roles={team.roles as Role[]}
          departments={team.departments}
          onCancel={() => setAttempt((n) => n + 1)}
          onCreated={(made) => {
            setCreated(made);
            onAdded();
          }}
        />
      )}
      <p className="text-xs text-subtle">
        Each person gets an email with a link to choose their own password. Roles, departments and access are under{" "}
        <Link href="/settings/access" className="text-brand hover:underline">
          Settings → Users &amp; access
        </Link>
        .
      </p>
    </div>
  );
}

// ─── What you sell ───────────────────────────────────────────────────────────────────────────────

export function ItemStep({
  draft,
  issues,
  india,
  added,
  onChange,
  onLeave,
}: {
  draft: ItemDraft;
  issues: Partial<Record<ItemField, string>>;
  india: boolean;
  /** The items added in this wizard, by name. */
  added: string[];
  onChange: (patch: Partial<ItemDraft>) => void;
  onLeave: (field: ItemField) => void;
}) {
  return (
    <div className="space-y-4">
      {added.length > 0 && (
        <p className="flex items-center gap-2 text-sm text-success" role="status">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          Added {added.join(", ")}. Add another, or carry on — the rest can come from a spreadsheet under Items.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="onb-item-name">Name</Label>
          <Input
            id="onb-item-name"
            className={INVALID_BORDER}
            value={draft.name}
            onChange={(e) => onChange({ name: e.target.value, ...(draft.skuTyped ? {} : { sku: skuFrom(e.target.value) }) })}
            onBlur={() => onLeave("name")}
            placeholder="Annual support plan"
            autoComplete="off"
            aria-invalid={invalid(issues.name)}
            aria-describedby={describedBy("onb-item-name", false, issues.name)}
          />
          <Note id="onb-item-name" error={issues.name} />
        </div>
        <div>
          <Label htmlFor="onb-item-sku">SKU</Label>
          <Input
            id="onb-item-sku"
            value={draft.sku}
            onChange={(e) => onChange({ sku: e.target.value, skuTyped: e.target.value.trim() !== "" })}
            onBlur={() => onLeave("sku")}
            className={cn("font-mono", INVALID_BORDER)}
            autoComplete="off"
            aria-invalid={invalid(issues.sku)}
            aria-describedby={describedBy("onb-item-sku", true, issues.sku)}
          />
          <Note id="onb-item-sku" hint="Made from the name — change it to your own code if you have one." error={issues.sku} />
        </div>
        <div>
          <Label htmlFor="onb-item-type">Kind</Label>
          <Select id="onb-item-type" value={draft.type} onChange={(e) => onChange({ type: e.target.value === "GOOD" ? "GOOD" : "SERVICE" })}>
            <option value="SERVICE">A service</option>
            <option value="GOOD">A product (goods)</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="onb-item-price">{india ? "Selling price (₹)" : "Selling price"}</Label>
          <Input
            id="onb-item-price"
            className={INVALID_BORDER}
            value={draft.price}
            onChange={(e) => onChange({ price: e.target.value })}
            onBlur={() => onLeave("price")}
            inputMode="decimal"
            autoComplete="off"
            aria-invalid={invalid(issues.price)}
            aria-describedby={describedBy("onb-item-price", true, issues.price)}
          />
          <Note id="onb-item-price" hint="Before tax." error={issues.price} />
        </div>
        <div>
          <Label htmlFor="onb-item-tax">{india ? "GST rate" : "Tax rate (%)"}</Label>
          {india ? (
            <Select id="onb-item-tax" value={draft.tax} onChange={(e) => onChange({ tax: e.target.value })}>
              {GST_RATES.map((rate) => (
                <option key={rate} value={String(rate)}>
                  {rate}%
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id="onb-item-tax"
              className={INVALID_BORDER}
              value={draft.tax}
              onChange={(e) => onChange({ tax: e.target.value })}
              onBlur={() => onLeave("tax")}
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={invalid(issues.tax)}
              aria-describedby={describedBy("onb-item-tax", false, issues.tax)}
            />
          )}
          <Note id="onb-item-tax" error={issues.tax} />
        </div>
      </div>
      <p className="text-xs text-subtle">
        HSN codes, stock and the rest are on the full form under{" "}
        <Link href="/items/new" className="text-brand hover:underline">
          Items
        </Link>
        .
      </p>
    </div>
  );
}

// ─── Help ────────────────────────────────────────────────────────────────────────────────────────

export function HelpStep({
  draft,
  issues,
  added,
  onChange,
  onLeave,
}: {
  draft: HelpDraft;
  issues: Partial<Record<HelpField, string>>;
  added: string[];
  onChange: (patch: Partial<HelpDraft>) => void;
  onLeave: (field: HelpField) => void;
}) {
  return (
    <div className="space-y-4">
      {added.length > 0 && (
        <p className="flex items-center gap-2 text-sm text-success" role="status">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          Added {added.join(", ")} to the Help panel.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <div>
          <Label htmlFor="onb-help-kind">What it is</Label>
          <Select id="onb-help-kind" value={draft.kind} onChange={(e) => onChange({ kind: e.target.value === "VIDEO" ? "VIDEO" : "ARTICLE" })}>
            <option value="ARTICLE">An article</option>
            <option value="VIDEO">A video</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="onb-help-title">Title</Label>
          <Input
            id="onb-help-title"
            className={INVALID_BORDER}
            value={draft.title}
            onChange={(e) => onChange({ title: e.target.value })}
            onBlur={() => onLeave("title")}
            placeholder="How we raise a quote"
            autoComplete="off"
            aria-invalid={invalid(issues.title)}
            aria-describedby={describedBy("onb-help-title", false, issues.title)}
          />
          <Note id="onb-help-title" error={issues.title} />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="onb-help-url">Link</Label>
          <Input
            id="onb-help-url"
            className={INVALID_BORDER}
            value={draft.url}
            onChange={(e) => onChange({ url: e.target.value })}
            onBlur={() => onLeave("url")}
            placeholder={draft.kind === "VIDEO" ? "https://www.youtube.com/watch?v=…" : "https://…"}
            inputMode="url"
            autoComplete="off"
            aria-invalid={invalid(issues.url)}
            aria-describedby={describedBy("onb-help-url", true, issues.url)}
          />
          <Note id="onb-help-url" hint="An https:// address, or a page in the app starting with /." error={issues.url} />
        </div>
      </div>
      <p className="text-xs text-subtle">
        The support contact on everybody&apos;s dashboard is ours; these are your own guides. Manage them under{" "}
        <Link href="/settings/help" className="text-brand hover:underline">
          Settings → Help &amp; support
        </Link>
        .
      </p>
    </div>
  );
}

// ─── You ─────────────────────────────────────────────────────────────────────────────────────────

export function PhotoStep({ me, onSaved }: { me: OnboardingState["me"]; onSaved: () => void }) {
  return <PhotoManager user={{ id: me.id, name: me.name, photoUpdatedAt: me.photoUpdatedAt }} onSaved={onSaved} />;
}

export function TwoFactorStep({ enabled, onEnabled }: { enabled: boolean; onEnabled: () => void }) {
  if (enabled) {
    return (
      <p className="flex items-center gap-2 text-sm text-success">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        Two-factor sign-in is on. Keep your phone&apos;s authenticator app — you&apos;ll need its code each time you sign in.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        You&apos;ll need an authenticator app on your phone — Microsoft Authenticator, Google Authenticator or any other.
        First you&apos;ll confirm your password, then scan a QR code and type the 6-digit code it shows.
      </p>
      <TwoFactorSetup enabled={false} onEnabled={onEnabled} />
    </div>
  );
}
