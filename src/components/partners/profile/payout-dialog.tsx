"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Landmark, LoaderCircle, ShieldCheck } from "lucide-react";
import { partnerRequestPayoutChange } from "@/actions/partners/profile";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { TextField } from "@/components/partners/common/fields";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/input";
import { WORLD_COUNTRIES } from "@/lib/geo/world-countries";

type PayoutAction = ReturnType<typeof useConsoleAction<{ id: string }>>;

/**
 * "Submit new payout details" (ADMIN, FINANCE): the bank account commission is paid to. What is typed
 * here is sealed on the server the moment it arrives (src/actions/partners/profile.ts
 * partnerRequestPayoutChange) and is never shown again — not in this dialog, not on the page, not to
 * the person who typed it. Platform staff review the change before it takes effect, and every admin
 * of the partner account is emailed about it.
 *
 * So the form never starts from the details on file (the portal only ever holds their mask), and it
 * is emptied the moment it is sent: the dialog closes, its fields unmount with it, and the page says
 * only that new details are waiting for review.
 */
export function SubmitPayoutButton({ hasDetails }: { hasDetails: boolean }) {
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
        variant={hasDetails ? "secondary" : "primary"}
        size="sm"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <Landmark aria-hidden="true" className="h-4 w-4" />
        Submit new payout details
      </Button>
      <Dialog open={open} onClose={close} title="Submit new payout details">
        {open && <PayoutForm action={action} onDone={() => setOpen(false)} onCancel={close} />}
      </Dialog>
    </>
  );
}

const CURRENCY = /^[A-Za-z]{3}$/;

function PayoutForm({ action, onDone, onCancel }: { action: PayoutAction; onDone: () => void; onCancel: () => void }) {
  const firstRef = useRef<HTMLInputElement>(null);
  const countryId = useId();
  const [holder, setHolder] = useState("");
  const [bank, setBank] = useState("");
  const [country, setCountry] = useState("");
  const [currency, setCurrency] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [iban, setIban] = useState("");
  const [swift, setSwift] = useState("");
  const [routing, setRouting] = useState("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => firstRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const india = country === "IN";
  const holderOk = holder.trim().length >= 2;
  const bankOk = bank.trim().length >= 2;
  const currencyOk = CURRENCY.test(currency.trim());
  const accountOk = !!accountNumber.trim() || !!iban.trim();
  const ready = holderOk && bankOk && !!country && currencyOk && accountOk;

  function chooseCountry(code: string) {
    setCountry(code);
    // The account's usual currency, offered once — never over one already typed.
    if (!currency.trim()) setCurrency(WORLD_COUNTRIES.find((c) => c.code === code)?.currency ?? "");
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTried(true);
    if (!ready || action.pending) return;
    const blank = (text: string) => (text.trim() ? text.trim() : null);
    action.run(
      () =>
        partnerRequestPayoutChange({
          accountHolder: holder.trim(),
          bankName: bank.trim(),
          country,
          currency: currency.trim().toUpperCase(),
          accountNumber: blank(accountNumber),
          ifsc: blank(ifsc),
          iban: blank(iban),
          swift: blank(swift),
          routingNumber: blank(routing),
          note: blank(note),
        }),
      { success: "New payout details sent for review. The details on file stay in use until the platform approves the change.", onDone },
    );
  }

  return (
    <form onSubmit={submit} noValidate autoComplete="off" className="space-y-4 p-0.5" aria-busy={action.pending || undefined}>
      <p className="flex items-start gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2.5 text-xs text-muted">
        <ShieldCheck aria-hidden="true" className="mt-px h-4 w-4 shrink-0 text-success" />
        <span>
          Platform staff review the change before it takes effect, and every admin of your partner account is emailed about it. The details you type are sealed as soon as they
          are sent and are never shown again — afterwards the portal shows only the bank and the account&apos;s last four characters.
        </span>
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField inputRef={firstRef} label="Account holder" value={holder} onChange={setHolder} max={120} required readOnly={action.pending} error={tried && !holderOk ? "Give the account holder's name." : null} />
        <TextField label="Bank name" value={bank} onChange={setBank} max={120} required readOnly={action.pending} error={tried && !bankOk ? "Give the bank's name." : null} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={countryId}>
            Country of the account
            <span aria-hidden="true" className="ml-0.5 text-danger">
              *
            </span>
          </Label>
          <Select id={countryId} value={country} onChange={(e) => chooseCountry(e.target.value)} disabled={action.pending} aria-required="true" aria-invalid={tried && !country ? true : undefined}>
            <option value="">Choose a country</option>
            {WORLD_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
          {tried && !country && <p className="text-xs text-danger">Choose the country the account is in.</p>}
        </div>
        <TextField
          label="Currency"
          value={currency}
          onChange={(v) => setCurrency(v.toUpperCase())}
          max={3}
          required
          readOnly={action.pending}
          mono
          placeholder="INR"
          error={tried && !currencyOk ? "Three letters, like INR or USD." : null}
          hint="The currency the account is held in."
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Account number"
          value={accountNumber}
          onChange={setAccountNumber}
          max={34}
          readOnly={action.pending}
          mono
          inputMode={india ? "numeric" : undefined}
          error={tried && !accountOk ? "Give an account number or an IBAN." : null}
          hint={india ? "6 to 20 digits." : "Or give an IBAN instead."}
        />
        <TextField label="IFSC" value={ifsc} onChange={(v) => setIfsc(v.toUpperCase())} max={11} readOnly={action.pending} mono placeholder="HDFC0001234" hint={india ? "Needed for an account in India." : "Accounts in India only."} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="IBAN" value={iban} onChange={(v) => setIban(v.toUpperCase())} max={42} readOnly={action.pending} mono hint="Where the bank uses one." />
        <TextField label="SWIFT (BIC)" value={swift} onChange={(v) => setSwift(v.toUpperCase())} max={11} readOnly={action.pending} mono hint="8 or 11 characters." />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Routing or sort code" value={routing} onChange={setRouting} max={20} readOnly={action.pending} mono hint="Where the bank uses one." />
        <TextField label="Note for the platform" value={note} onChange={setNote} max={200} readOnly={action.pending} hint="Optional — why the account is changing." />
      </div>
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" aria-disabled={action.pending || undefined} aria-busy={action.pending || undefined} className={action.pending ? "cursor-wait opacity-70" : undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Send for review
        </Button>
      </div>
    </form>
  );
}
