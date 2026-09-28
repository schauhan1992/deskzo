"use client";

import { useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { partnerSetStatementInvoiceNumber } from "@/actions/partners/commissions";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { TextField } from "@/components/partners/common/fields";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";

/** The server's limit (src/lib/partners/statements.ts setPartnerInvoiceNumber). */
const MAX = 60;

/**
 * "Your invoice number" on an approved statement: the number of the invoice the partner raised for
 * this commission (a GST- or VAT-registered partner invoices the platform), so the platform's
 * accounts can match the payment to it. It can change until the statement is paid; the server says
 * so if it has been paid meanwhile.
 */
export function InvoiceNumberForm({ number, current }: { number: string; current: string | null }) {
  const action = useConsoleAction<{ number: string; invoiceNumber: string }>();
  const saved = current ?? "";
  const [value, setValue] = useState(saved);
  const [seen, setSeen] = useState(saved);
  // A save (or a change made in another tab) arrives as a new prop after the refresh: follow it.
  if (seen !== saved) {
    setSeen(saved);
    setValue(saved);
  }
  const clean = value.replace(/\s+/g, " ").trim();
  const changed = clean !== saved;
  const valid = clean.length >= 1 && clean.length <= MAX;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!changed || !valid || action.pending) return;
    action.run(() => partnerSetStatementInvoiceNumber(number, clean), { success: `Invoice number ${clean} saved on this statement.` });
  }

  return (
    <form onSubmit={submit} className="max-w-md space-y-3" aria-busy={action.pending || undefined}>
      <TextField
        label="Your invoice number"
        value={value}
        onChange={setValue}
        max={MAX}
        readOnly={action.pending}
        mono
        placeholder="e.g. INV-2026-014"
        error={changed && clean.length > MAX ? `At most ${MAX} characters.` : null}
        hint="If you invoice the platform for this commission, give that invoice's number. It can change until the statement is paid."
      />
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      {changed && (
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={!valid} aria-disabled={action.pending || undefined} aria-busy={action.pending || undefined} className={action.pending ? "cursor-wait opacity-70" : undefined}>
            {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            Save invoice number
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setValue(saved)} disabled={action.pending}>
            Cancel
          </Button>
        </div>
      )}
    </form>
  );
}
