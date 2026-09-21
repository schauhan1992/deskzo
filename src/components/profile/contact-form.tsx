"use client";

import { useState, useTransition } from "react";
import { updateOwnContact } from "@/actions/profile";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/**
 * The number a customer is given when this person sends them a quote.
 *
 * Their own, and only their own — the action takes no id. Somebody else's contact details are a
 * Users & Access matter, not something a person edits from their own profile page.
 */
export function ContactForm({ email, phone }: { email: string; phone: string | null }) {
  const [value, setValue] = useState(phone ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateOwnContact({ phone: value });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
    });
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>Email</Label>
        {/* Not editable here: an address is how somebody signs in, so changing it is an account
            change rather than a contact one. */}
        <p className="text-sm text-text">{email}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="work-phone">Work phone</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="work-phone"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            placeholder="+91 98765 43210"
            className="max-w-xs"
          />
          <Button size="sm" variant="secondary" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
          {saved && <span className="text-xs text-success">Saved.</span>}
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <p className="text-xs text-subtle">
          Shown on quotes and invoices you raise, so the customer can reach you. Leave it blank and only your
          email is given.
        </p>
      </div>
    </div>
  );
}
