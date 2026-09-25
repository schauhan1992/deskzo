"use client";

import { useId, useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { GST_STATE_OPTIONS } from "@/lib/gst-engine";
import { COUNTRIES, DEFAULT_COUNTRY, isIndia } from "@/lib/geo/countries";
import { PincodeField } from "@/components/ui/pincode-field";
import { useCitySuggestions } from "@/components/ui/use-address-lookup";
import { formatAddress, type AddressDraft } from "@/lib/document-draft";

/**
 * An address shown as the block it will print as, with a pencil to edit it — Zoho's pattern, and
 * the right one here because the address is usually inherited and only occasionally overridden.
 *
 * Editing is against a local copy committed on Save, so abandoning the dialog leaves the document
 * as it was rather than half-changed.
 */
export function AddressEditor({
  title,
  value,
  onChange,
  emptyText = "No address on file",
  disabled = false,
  action,
}: {
  title: string;
  value: AddressDraft;
  onChange: (next: AddressDraft) => void;
  emptyText?: string;
  disabled?: boolean;
  /** Rendered beside the title — used for the "same as billing" toggle. */
  action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const uid = useId();
  /**
   * Suggestions come off the state *name*, not the code.
   *
   * The select below sets both and keeps them together, so by the time anything is typed into the
   * city box the state name is already there — which is what makes the two fields a hierarchy
   * rather than two boxes that happen to sit next to each other.
   */
  const domestic = isIndia(draft.country);
  const suggestions = useCitySuggestions(draft.state, open && domestic);

  const lines = formatAddress(value);
  const set = (key: keyof AddressDraft) => (e: { target: { value: string } }) =>
    setDraft((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-subtle">{title}</span>
        {!disabled && (
          <button
            type="button"
            aria-label={`Edit ${title.toLowerCase()}`}
            className="text-subtle hover:text-text"
            onClick={() => {
              setDraft(value);
              setOpen(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        {action}
      </div>
      {lines.length > 0 ? (
        <div className="text-sm leading-5 text-text">
          {lines.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
          {value.phone && <div className="text-muted">{value.phone}</div>}
        </div>
      ) : (
        <p className="text-sm text-subtle">{emptyText}</p>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} title={`Edit ${title.toLowerCase()}`}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="attention">Attention</Label>
              <Input id="attention" value={draft.attention} onChange={set("attention")} placeholder="Contact name" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="line1">Address line 1</Label>
              <Input id="line1" value={draft.line1} onChange={set("line1")} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="line2">Address line 2</Label>
              <Input id="line2" value={draft.line2} onChange={set("line2")} />
            </div>
            {/* Country → state → city → PIN: the order the answers narrow each other down in. */}
            <div className="space-y-1.5">
              <Label htmlFor="country">Country</Label>
              {/* A select rather than a box, so "Bharat", "IN" and "india" stop being three
                  countries on three documents. The state beside it stays the GST list either way:
                  an export carries place-of-supply code 96 or 97, which are options in it. */}
              <Select id="country" value={draft.country || DEFAULT_COUNTRY} onChange={set("country")}>
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.name}>
                    {c.name}
                  </option>
                ))}
                {/* Whatever is already stored, if it is not one of the above — so opening a
                    document does not silently rewrite its printed address. */}
                {draft.country && !COUNTRIES.some((c) => c.name === draft.country) && (
                  <option value={draft.country}>{draft.country}</option>
                )}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stateCode">State</Label>
              <Select
                id="stateCode"
                value={draft.stateCode}
                onChange={(e) => {
                  const option = GST_STATE_OPTIONS.find((s) => s.code === e.target.value);
                  // The name and the code travel together — the code drives tax, the name prints.
                  setDraft((prev) => ({ ...prev, stateCode: e.target.value, state: option?.name ?? "" }));
                }}
              >
                <option value="">Not set</option>
                {GST_STATE_OPTIONS.map((s) => (
                  <option key={s.code} value={s.code}>
                    [{s.code}] {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="city">City</Label>
              <Input
                id="city"
                value={draft.city}
                onChange={set("city")}
                list={suggestions.length > 0 ? `${uid}-cities` : undefined}
                placeholder={draft.stateCode ? "City" : "Pick a state first for suggestions"}
                autoComplete="off"
              />
              {/* A suggestion list, not a closed one — a customer is as likely to be in Hosur as in
                  Chennai, and an address that cannot say where somebody is would be worse than the
                  free text it replaced. Same reasoning as `AddressFields`. */}
              {suggestions.length > 0 && (
                <datalist id={`${uid}-cities`}>
                  {suggestions.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              )}
            </div>
            {domestic ? (
              <PincodeField
                id="pincode"
                value={draft.pincode}
                stateName={draft.state}
                stateCode={draft.stateCode || null}
                city={draft.city}
                onPincode={(pincode) => setDraft((prev) => ({ ...prev, pincode }))}
                onPlace={(place) =>
                  setDraft((prev) => ({
                    ...prev,
                    // The code and the name move together here as they do in the select above.
                    ...(place.stateCode ? { stateCode: place.stateCode, state: place.stateName ?? prev.state } : {}),
                    ...(place.city ? { city: place.city } : {}),
                  }))
                }
              />
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="pincode">Postal code</Label>
                <Input id="pincode" value={draft.pincode} onChange={set("pincode")} maxLength={12} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" value={draft.phone} onChange={set("phone")} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => {
                onChange(draft);
                setOpen(false);
              }}
            >
              Save
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
