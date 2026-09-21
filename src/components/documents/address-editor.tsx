"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { GST_STATE_OPTIONS } from "@/lib/gst-engine";
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
            <div className="space-y-1.5">
              <Label htmlFor="city">City</Label>
              <Input id="city" value={draft.city} onChange={set("city")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pincode">PIN code</Label>
              <Input id="pincode" value={draft.pincode} onChange={set("pincode")} placeholder="400001" />
            </div>
            <div className="col-span-2 space-y-1.5">
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
              <Label htmlFor="country">Country</Label>
              <Input id="country" value={draft.country} onChange={set("country")} />
            </div>
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
