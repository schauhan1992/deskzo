"use client";

import { useId } from "react";
import { Plus, X } from "lucide-react";
import { Checkbox } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import type { PartnerKind, PartnerInput, PartnerStatus } from "@/lib/partners/types";
import { cn } from "@/lib/utils";
import { CountrySelect, TerritoryPicker } from "./country-fields";
import { EMAIL, outsideOf, slugProblem } from "./format";

/**
 * A partner's profile as a form (spec §3.1): its console address (with a live format hint), kind and
 * distributor, names, country and territories, contact, address, tax ids and the public listing.
 * Shared by New partner, "Create partner from this" (an application) and Edit. The server checks
 * every field again; the hints here only say what it would refuse.
 */

export type DistributorOption = { slug: string; displayName: string; status: PartnerStatus; territories: string[] };

export type PartnerDraft = {
  slug: string;
  kind: PartnerKind;
  parentSlug: string;
  legalName: string;
  displayName: string;
  country: string;
  territories: string[];
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  website: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  taxIds: { key: number; kind: string; value: string }[];
  publicListing: boolean;
  publicBlurb: string;
  seq: number;
};

const MAX_TAX_IDS = 4;
const BLURB_MAX = 400;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function emptyPartnerDraft(kind: PartnerKind = "RESELLER"): PartnerDraft {
  return {
    slug: "",
    kind,
    parentSlug: "",
    legalName: "",
    displayName: "",
    country: "",
    territories: [],
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    website: "",
    line1: "",
    line2: "",
    city: "",
    region: "",
    postalCode: "",
    taxIds: [],
    publicListing: false,
    publicBlurb: "",
    seq: 0,
  };
}

/** The draft as the actions take it. A distributor never names a distributor. */
export function partnerFromDraft(d: PartnerDraft): PartnerInput {
  const orNull = (v: string) => (v.trim() ? v.trim() : null);
  return {
    slug: d.slug.trim().toLowerCase(),
    kind: d.kind,
    parentSlug: d.kind === "RESELLER" ? orNull(d.parentSlug) : null,
    legalName: d.legalName.trim(),
    displayName: d.displayName.trim(),
    country: d.country,
    territories: d.territories,
    contactName: d.contactName.trim(),
    contactEmail: d.contactEmail.trim(),
    contactPhone: orNull(d.contactPhone),
    website: orNull(d.website),
    address: { line1: orNull(d.line1), line2: orNull(d.line2), city: orNull(d.city), region: orNull(d.region), postalCode: orNull(d.postalCode) },
    taxIds: d.taxIds.map((t) => ({ kind: t.kind, value: t.value.trim() })),
    publicListing: d.publicListing,
    publicBlurb: orNull(d.publicBlurb),
  };
}

function taxIdProblem(kind: string, raw: string): string | null {
  const value = ["GSTIN", "PAN", "VAT"].includes(kind) ? raw.trim().toUpperCase() : raw.trim();
  if (!kind) return "Choose the kind of each tax id.";
  if (value.length < 3 || value.length > 40) return "Each tax id is 3 to 40 characters.";
  if (kind === "GSTIN" && !GSTIN.test(value)) return "A GSTIN is 15 characters, like 27ABCDE1234F1Z5.";
  if (kind === "PAN" && !PAN.test(value)) return "A PAN is 10 characters, like ABCDE1234F.";
  return null;
}

/** The first thing the server would refuse, in words — null when the draft looks sendable. */
export function partnerProblem(d: PartnerDraft, distributors: DistributorOption[]): string | null {
  const slug = slugProblem(d.slug);
  if (slug) return `Address: ${slug}`;
  if (d.legalName.trim().length < 2) return "Give the legal name.";
  if (d.displayName.trim().length < 2) return "Give the display name.";
  if (!d.country) return "Choose the partner's country.";
  if (d.territories.length === 0) return "Add at least one territory.";
  if (d.kind === "RESELLER" && d.parentSlug) {
    const parent = distributors.find((p) => p.slug === d.parentSlug);
    const outside = parent ? outsideOf(d.territories, parent.territories) : [];
    if (parent && outside.length) return `Outside ${parent.displayName}'s territories: ${outside.join(", ")}.`;
  }
  if (d.contactName.trim().length < 2) return "Give the contact's name.";
  if (!EMAIL.test(d.contactEmail.trim())) return "Give the contact's email address.";
  for (const t of d.taxIds) {
    const problem = taxIdProblem(t.kind, t.value);
    if (problem) return problem;
  }
  if (d.publicBlurb.trim().length > BLURB_MAX) return "Keep the public blurb to 400 characters.";
  return null;
}

export function PartnerFields({
  draft,
  onChange,
  distributors,
  taxIdKinds,
  disabled,
  withTaxIds = true,
}: {
  draft: PartnerDraft;
  onChange: (next: PartnerDraft) => void;
  /** Distributors a reseller may sit under (terminated ones are left out here). */
  distributors: DistributorOption[];
  taxIdKinds: readonly string[];
  disabled?: boolean;
  /** Tax ids are money-side facts (SELLERS); an editor without them leaves them as they are. */
  withTaxIds?: boolean;
}) {
  const id = useId();
  const set = (patch: Partial<PartnerDraft>) => onChange({ ...draft, ...patch });
  const ids = {
    slug: `${id}-slug`,
    slugHint: `${id}-slug-hint`,
    kind: `${id}-kind`,
    parent: `${id}-parent`,
    parentHint: `${id}-parent-hint`,
    legal: `${id}-legal`,
    display: `${id}-display`,
    country: `${id}-country`,
    contactName: `${id}-contact-name`,
    contactEmail: `${id}-contact-email`,
    contactPhone: `${id}-contact-phone`,
    website: `${id}-website`,
    line1: `${id}-line1`,
    line2: `${id}-line2`,
    city: `${id}-city`,
    region: `${id}-region`,
    postal: `${id}-postal`,
    blurb: `${id}-blurb`,
  };
  const liveParents = distributors.filter((p) => p.status !== "TERMINATED" && p.slug !== draft.slug);
  const parent = draft.kind === "RESELLER" && draft.parentSlug ? distributors.find((p) => p.slug === draft.parentSlug) : undefined;
  const outside = parent ? outsideOf(draft.territories, parent.territories) : [];
  const slugHint = draft.slug ? slugProblem(draft.slug) : null;
  const emailBad = draft.contactEmail.trim() !== "" && !EMAIL.test(draft.contactEmail.trim());

  function addTaxId() {
    set({ taxIds: [...draft.taxIds, { key: draft.seq, kind: taxIdKinds[0] ?? "OTHER", value: "" }], seq: draft.seq + 1 });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={ids.slug}>Console address</Label>
          <Input
            id={ids.slug}
            value={draft.slug}
            onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/\s+/g, "-") })}
            maxLength={40}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={!!slugHint || undefined}
            aria-describedby={ids.slugHint}
            readOnly={disabled}
            className="font-mono"
          />
          <p id={ids.slugHint} className={cn("text-xs", slugHint ? "text-danger" : "text-muted")}>
            {slugHint ?? (draft.slug ? `/partners/${draft.slug}` : "3 to 40 lower-case letters, digits and hyphens.")}
          </p>
        </div>
        <fieldset className="space-y-1.5">
          <legend className="text-[13px] font-medium text-muted">Kind</legend>
          <div className="flex flex-wrap gap-4 pt-1.5">
            {(["DISTRIBUTOR", "RESELLER"] as const).map((k) => (
              <label key={k} className="inline-flex cursor-pointer items-center gap-2 text-sm text-text">
                <input
                  type="radio"
                  name={ids.kind}
                  value={k}
                  checked={draft.kind === k}
                  onChange={() => set({ kind: k, parentSlug: k === "DISTRIBUTOR" ? "" : draft.parentSlug })}
                  disabled={disabled}
                  className="h-4 w-4 accent-brand"
                />
                {k === "DISTRIBUTOR" ? "Distributor" : "Reseller"}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted">{draft.kind === "DISTRIBUTOR" ? "Holds a territory, may have resellers under it." : "Sells to customers; may sit under a distributor."}</p>
        </fieldset>
      </div>

      {draft.kind === "RESELLER" && (
        <div className="space-y-1.5">
          <Label htmlFor={ids.parent}>Distributor</Label>
          <Select id={ids.parent} value={draft.parentSlug} onChange={(e) => set({ parentSlug: e.target.value })} disabled={disabled} aria-describedby={ids.parentHint}>
            <option value="">None — sells directly under the platform</option>
            {liveParents.map((p) => (
              <option key={p.slug} value={p.slug}>
                {`${p.displayName} (${p.slug})`}
              </option>
            ))}
          </Select>
          <p id={ids.parentHint} className={cn("text-xs", outside.length ? "text-danger" : "text-muted")}>
            {parent
              ? outside.length
                ? `Outside ${parent.displayName}'s territories: ${outside.join(", ")}.`
                : `Its territories must lie within ${parent.displayName}'s: ${parent.territories.join(", ") || "none"}.`
              : "A reseller under a distributor earns that distributor an override on its customers."}
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={ids.legal}>Legal name</Label>
          <Input id={ids.legal} value={draft.legalName} onChange={(e) => set({ legalName: e.target.value })} maxLength={200} autoComplete="off" readOnly={disabled} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.display}>Display name</Label>
          <Input id={ids.display} value={draft.displayName} onChange={(e) => set({ displayName: e.target.value })} maxLength={120} autoComplete="off" readOnly={disabled} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <CountrySelect id={ids.country} label="Country" value={draft.country} onChange={(country) => set({ country })} disabled={disabled} />
        <TerritoryPicker
          label="Territories"
          value={draft.territories}
          onChange={(territories) => set({ territories })}
          disabled={disabled}
          outside={outside}
          hint={draft.territories.length === 0 ? "The countries it sells in — at least one." : undefined}
        />
      </div>

      <fieldset className="space-y-3">
        <legend className="text-[13px] font-medium text-muted">Contact</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor={ids.contactName}>Name</Label>
            <Input id={ids.contactName} value={draft.contactName} onChange={(e) => set({ contactName: e.target.value })} maxLength={120} autoComplete="off" readOnly={disabled} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.contactEmail}>Email</Label>
            <Input
              id={ids.contactEmail}
              type="email"
              value={draft.contactEmail}
              onChange={(e) => set({ contactEmail: e.target.value })}
              maxLength={254}
              autoComplete="off"
              aria-invalid={emailBad || undefined}
              readOnly={disabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.contactPhone}>Phone (optional)</Label>
            <Input id={ids.contactPhone} type="tel" value={draft.contactPhone} onChange={(e) => set({ contactPhone: e.target.value })} maxLength={40} autoComplete="off" readOnly={disabled} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.website}>Website (optional)</Label>
          <Input id={ids.website} value={draft.website} onChange={(e) => set({ website: e.target.value })} maxLength={200} placeholder="https://" autoComplete="off" readOnly={disabled} />
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-[13px] font-medium text-muted">Address (optional)</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={ids.line1}>Line 1</Label>
            <Input id={ids.line1} value={draft.line1} onChange={(e) => set({ line1: e.target.value })} maxLength={200} autoComplete="off" readOnly={disabled} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.line2}>Line 2</Label>
            <Input id={ids.line2} value={draft.line2} onChange={(e) => set({ line2: e.target.value })} maxLength={200} autoComplete="off" readOnly={disabled} />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor={ids.city}>City</Label>
            <Input id={ids.city} value={draft.city} onChange={(e) => set({ city: e.target.value })} maxLength={120} autoComplete="off" readOnly={disabled} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.region}>State or region</Label>
            <Input id={ids.region} value={draft.region} onChange={(e) => set({ region: e.target.value })} maxLength={120} autoComplete="off" readOnly={disabled} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.postal}>Postal code</Label>
            <Input id={ids.postal} value={draft.postalCode} onChange={(e) => set({ postalCode: e.target.value })} maxLength={20} autoComplete="off" readOnly={disabled} />
          </div>
        </div>
      </fieldset>

      {withTaxIds && (
        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium text-muted">Tax ids (optional)</legend>
          {draft.taxIds.length === 0 && <p className="text-xs text-muted">None. Checked for format only, never looked up.</p>}
          {draft.taxIds.map((row, i) => {
            const problem = row.value.trim() ? taxIdProblem(row.kind, row.value) : null;
            return (
              <div key={row.key} className="space-y-1">
                <div className="flex items-center gap-2">
                  <Select
                    aria-label={`Kind of tax id ${i + 1}`}
                    value={row.kind}
                    onChange={(e) => set({ taxIds: draft.taxIds.map((t) => (t.key === row.key ? { ...t, kind: e.target.value } : t)) })}
                    disabled={disabled}
                    className="w-32"
                  >
                    {taxIdKinds.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </Select>
                  <Input
                    aria-label={`Tax id ${i + 1}`}
                    value={row.value}
                    onChange={(e) => set({ taxIds: draft.taxIds.map((t) => (t.key === row.key ? { ...t, value: e.target.value } : t)) })}
                    maxLength={40}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={!!problem || undefined}
                    readOnly={disabled}
                    className="flex-1 font-mono"
                  />
                  <IconButton icon={X} label={`Remove tax id ${i + 1}`} onClick={() => set({ taxIds: draft.taxIds.filter((t) => t.key !== row.key) })} disabled={disabled} />
                </div>
                {problem && <p className="text-xs text-danger">{problem}</p>}
              </div>
            );
          })}
          {draft.taxIds.length < MAX_TAX_IDS && (
            <Button type="button" variant="ghost" size="sm" onClick={addTaxId} disabled={disabled}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add a tax id
            </Button>
          )}
        </fieldset>
      )}

      <div className="space-y-2">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-text">
          <Checkbox checked={draft.publicListing} onChange={(e) => set({ publicListing: e.target.checked })} disabled={disabled} />
          List it on the public &ldquo;Find a partner&rdquo; page
        </label>
        {draft.publicListing && (
          <div className="space-y-1.5">
            <Label htmlFor={ids.blurb}>Public blurb (optional)</Label>
            <Textarea id={ids.blurb} value={draft.publicBlurb} onChange={(e) => set({ publicBlurb: e.target.value })} maxLength={BLURB_MAX} rows={2} readOnly={disabled} />
          </div>
        )}
      </div>
    </div>
  );
}
