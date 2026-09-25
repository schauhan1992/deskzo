"use client";

import { useState } from "react";
import { addContact } from "@/actions/company";
import { contactDesignationValues } from "@/lib/validation/company";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";

type Designation = (typeof contactDesignationValues)[number];
const EMPTY = { name: "", designation: "OTHER" as Designation, email: "", phone: "" };

export type CreatedContact = { id: string; name: string; designation: string };

/**
 * A new person at a company that already exists — from inside whatever form needed them.
 *
 * The lead form lists the company's contacts, and the person a new requirement came from is often
 * somebody not on it yet. Without this the only way to add them was to abandon the lead, go to the
 * company, add the contact, and start the lead again.
 *
 * Saved through `addContact`, so the same validation and the same account scope apply as on the
 * company page — a company this person cannot see answers "not found" here too.
 */
export function NewContactDialog({
  open,
  companyId,
  companyName,
  onClose,
  onCreated,
}: {
  open: boolean;
  companyId: string;
  companyName: string;
  onClose: () => void;
  onCreated: (contact: CreatedContact) => void;
}) {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);

  // Fresh each time it opens — adjusted during render, as the quick-create dialog does.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm(EMPTY);
      setError(null);
    }
  }

  const set = (key: keyof typeof EMPTY) => (e: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    // The dialog is portalled to <body>, but React still bubbles its events up the component tree —
    // so without this, submitting it from inside another form would submit that form as well.
    e.stopPropagation();
    const name = form.name.trim();
    if (!name) {
      setError("Their name is needed.");
      return;
    }
    setSaving(true);
    setError(null);
    const result = await addContact(companyId, {
      name,
      designation: form.designation,
      email: form.email.trim(),
      phone: form.phone.trim(),
      isPrimary: false,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onCreated({ id: result.data.id, name, designation: form.designation });
  }

  return (
    <Dialog open={open} onClose={onClose} title={`New contact at ${companyName}`}>
      <form onSubmit={save} className="space-y-3">
        {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="nc-name">Name *</Label>
            <Input id="nc-name" value={form.name} onChange={set("name")} autoComplete="off" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nc-designation">Designation</Label>
            <Select id="nc-designation" value={form.designation} onChange={set("designation")}>
              {contactDesignationValues.map((d) => (
                <option key={d} value={d}>
                  {d.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nc-email">Email</Label>
            <Input id="nc-email" type="email" value={form.email} onChange={set("email")} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nc-phone">Phone</Label>
            <Input id="nc-phone" value={form.phone} onChange={set("phone")} autoComplete="off" />
          </div>
        </div>
        <p className="text-xs text-subtle">Added to the company&apos;s contacts, and picked for this lead.</p>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Adding…" : "Add contact"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
