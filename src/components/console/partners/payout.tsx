"use client";

import { useId, useState, useSyncExternalStore, type FormEvent } from "react";
import { EyeOff, KeyRound, Landmark, LoaderCircle } from "lucide-react";
import { consoleRevealPayout, consoleSetPayout } from "@/actions/platform/console-commissions";
import { ConfirmBody } from "@/components/console/kit/confirm-dialog";
import { CopyField } from "@/components/console/kit/copy-field";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import type { PayoutDetails } from "@/lib/partners/payout";
import { cn } from "@/lib/utils";
import { CountrySelect } from "./country-fields";
import { countryName } from "./format";

/**
 * A partner's bank details (spec D12), for PAYERS (owner and billing) only.
 *
 * Reveal payout: the one place full details reach a browser. They come from `consoleRevealPayout`
 * after an explicit click and a confirmation (the view is recorded in both audit logs, and the
 * partner is told), live only in this component's state while its dialog is open, and are gone when
 * it closes — never in the server's markup, the address or any storage.
 *
 * Set payout details: new details typed from scratch — the form never pre-fills, not even from the
 * mask — sealed on arrival; every one of the partner's admins is emailed the mask.
 */

const noSubscribe = () => () => {};

export function RevealPayoutButton({ partner, onFile }: { partner: { id: string; displayName: string }; onFile: boolean }) {
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<PayoutDetails>();
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<PayoutDetails | null>(null);

  function hide() {
    if (action.pending) return;
    action.reset();
    setDetails(null);
    setOpen(false);
  }

  if (!onFile) {
    return (
      <span className="inline-flex items-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled aria-describedby={`${partner.id}-payout-none`}>
          <KeyRound aria-hidden="true" className="h-4 w-4" />
          Reveal payout
        </Button>
        <span id={`${partner.id}-payout-none`} className="text-xs text-muted">
          No payout details on file.
        </span>
      </span>
    );
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          action.reset();
          setDetails(null);
          setOpen(true);
        }}
      >
        <KeyRound aria-hidden="true" className="h-4 w-4" />
        Reveal payout
      </Button>
      <Dialog open={open && isClient} onClose={hide} title={details ? `Payout details — ${partner.displayName}` : "Reveal payout details"}>
        {details ? (
          <PayoutPanel details={details} onHide={hide} />
        ) : (
          <ConfirmBody
            confirmLabel="Reveal"
            pending={action.pending}
            error={action.error}
            onConfirm={() =>
              action.run(() => consoleRevealPayout(partner.id), {
                success: "Payout details viewed — recorded in the audit log.",
                refresh: false,
                onDone: (d) => setDetails(d),
              })
            }
            onCancel={hide}
          >
            <p>{`Shows ${partner.displayName}'s full bank details here, until you hide them.`}</p>
            <p className="text-muted">The view is recorded in the audit log, and the partner is told that platform staff viewed its payout details.</p>
          </ConfirmBody>
        )}
      </Dialog>
    </>
  );
}

function PayoutPanel({ details, onHide }: { details: PayoutDetails; onHide: () => void }) {
  const rows: { term: string; value: string | null; copy?: string }[] = [
    { term: "Account holder", value: details.accountHolder, copy: "account holder" },
    { term: "Bank", value: details.bankName, copy: "bank name" },
    { term: "Country", value: `${countryName(details.country)} (${details.country})` },
    { term: "Currency", value: details.currency },
    { term: "Account number", value: details.accountNumber, copy: "account number" },
    { term: "IFSC", value: details.ifsc, copy: "IFSC" },
    { term: "IBAN", value: details.iban, copy: "IBAN" },
    { term: "SWIFT (BIC)", value: details.swift, copy: "SWIFT code" },
    { term: "Routing or sort code", value: details.routingNumber, copy: "routing code" },
    { term: "Note", value: details.note },
  ];
  return (
    <div className="space-y-4">
      <dl className="divide-y divide-line rounded-lg border border-line bg-surface-sunken">
        {rows
          .filter((r) => r.value)
          .map((r) => (
            <div key={r.term} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
              <dt className="text-xs text-muted">{r.term}</dt>
              <dd className="min-w-0 text-sm text-text">{r.copy ? <CopyField value={r.value ?? ""} label={r.copy} /> : r.value}</dd>
            </div>
          ))}
      </dl>
      <p className="text-xs text-warning">Kept on this screen only — hide them when you are done. Nothing here is saved in the browser.</p>
      <div className="flex justify-end">
        <Button type="button" onClick={onHide}>
          <EyeOff aria-hidden="true" className="h-4 w-4" />
          Hide
        </Button>
      </div>
    </div>
  );
}

// ─── Set payout details ──────────────────────────────────────────────────────────────────────────

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

type PayoutDraft = {
  accountHolder: string;
  bankName: string;
  country: string;
  currency: string;
  accountNumber: string;
  ifsc: string;
  iban: string;
  swift: string;
  routingNumber: string;
  note: string;
};

const EMPTY: PayoutDraft = { accountHolder: "", bankName: "", country: "", currency: "", accountNumber: "", ifsc: "", iban: "", swift: "", routingNumber: "", note: "" };

function payoutProblem(d: PayoutDraft): string | null {
  const compact = (v: string) => v.replace(/[\s-]+/g, "").toUpperCase();
  if (d.accountHolder.trim().length < 2) return "Give the account holder's name.";
  if (d.bankName.trim().length < 2) return "Give the bank's name.";
  if (!d.country) return "Choose the country the account is in.";
  if (!/^[A-Za-z]{3}$/.test(d.currency.trim())) return "Give the account's currency as three letters, like INR or USD.";
  if (!compact(d.accountNumber) && !compact(d.iban)) return "Give an account number or an IBAN.";
  if (d.country === "IN" && compact(d.accountNumber) && !/^[0-9]{6,20}$/.test(compact(d.accountNumber))) return "An Indian account number is 6 to 20 digits.";
  if (d.country === "IN" && compact(d.accountNumber) && !compact(d.ifsc)) return "Give the branch's IFSC.";
  if (compact(d.ifsc) && !IFSC.test(compact(d.ifsc))) return "An IFSC is 11 characters: four letters, a zero, then six letters or digits.";
  return null;
}

export function SetPayoutButton({ partner }: { partner: { id: string; displayName: string } }) {
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<unknown>();
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
        size="sm"
        variant="secondary"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <Landmark aria-hidden="true" className="h-4 w-4" />
        Set payout details
      </Button>
      <Dialog open={open && isClient} onClose={close} title={`Set payout details for ${partner.displayName}`}>
        <PayoutForm partner={partner} action={action} onClose={close} />
      </Dialog>
    </>
  );
}

/** Mounted only while the dialog is open: every field starts empty, and nothing typed outlives it. */
function PayoutForm({ partner, action, onClose }: { partner: { id: string; displayName: string }; action: ReturnType<typeof useConsoleAction<unknown>>; onClose: () => void }) {
  const id = useId();
  const [d, setD] = useState<PayoutDraft>(EMPTY);
  const set = (patch: Partial<PayoutDraft>) => setD((prev) => ({ ...prev, ...patch }));
  const problem = payoutProblem(d);
  const ready = problem === null && !action.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    const orNull = (v: string) => (v.trim() ? v.trim() : null);
    action.run(
      () =>
        consoleSetPayout(partner.id, {
          accountHolder: d.accountHolder.trim(),
          bankName: d.bankName.trim(),
          country: d.country,
          currency: d.currency.trim().toUpperCase(),
          accountNumber: orNull(d.accountNumber),
          ifsc: orNull(d.ifsc),
          iban: orNull(d.iban),
          swift: orNull(d.swift),
          routingNumber: orNull(d.routingNumber),
          note: orNull(d.note),
        }),
      { success: `Payout details set for ${partner.displayName} — its admins were emailed the change.`, onDone: onClose },
    );
  }

  const field = (key: keyof PayoutDraft, label: string, opts: { mono?: boolean; max?: number; placeholder?: string } = {}) => {
    const fieldId = `${id}-${key}`;
    return (
      <div className="space-y-1.5">
        <Label htmlFor={fieldId}>{label}</Label>
        <Input
          id={fieldId}
          value={d[key]}
          onChange={(e) => set({ [key]: e.target.value } as Partial<PayoutDraft>)}
          maxLength={opts.max ?? 120}
          placeholder={opts.placeholder}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          readOnly={action.pending}
          className={cn(opts.mono && "font-mono")}
        />
      </div>
    );
  };

  const noteId = `${id}-note`;
  return (
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate autoComplete="off">
      <p className="text-sm text-text">Replaces the details on file. They are sealed as soon as they arrive; only the last four digits are shown again.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {field("accountHolder", "Account holder")}
        {field("bankName", "Bank")}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <CountrySelect id={`${id}-country`} label="Account's country" value={d.country} onChange={(country) => set({ country })} disabled={action.pending} />
        {field("currency", "Currency", { max: 3, placeholder: "INR" })}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {field("accountNumber", "Account number", { mono: true, max: 40 })}
        {field("ifsc", "IFSC (India)", { mono: true, max: 11 })}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {field("iban", "IBAN", { mono: true, max: 40 })}
        {field("swift", "SWIFT (BIC)", { mono: true, max: 11 })}
        {field("routingNumber", "Routing or sort code", { mono: true, max: 20 })}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={noteId}>Note (optional)</Label>
        <Textarea id={noteId} value={d.note} onChange={(e) => set({ note: e.target.value })} maxLength={300} rows={2} readOnly={action.pending} />
      </div>
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:items-center sm:justify-end">
        {problem && <p className="text-xs text-muted sm:mr-auto">{problem}</p>}
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-busy={action.pending || undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Save payout details
        </Button>
      </div>
    </form>
  );
}
