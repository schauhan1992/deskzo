"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { FollowUpChannel } from "@prisma/client";
import { logFollowUp } from "@/actions/collections";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { FOLLOW_UP_CHANNELS, REMARKS_MAX, followUpChannelLabels } from "@/lib/collections/rules";
import { useClock } from "@/components/time/clock-provider";
import { formatMoney, isBaseCurrency } from "@/lib/currency";

export type LogFollowUpTarget = {
  documentId?: string;
  companyProductId?: string;
  /** INV-0012 / ORD-000034. */
  label: string;
  /** Shown above the form; left empty where the page is already the customer's own. */
  companyName: string;
  /** Outstanding, in `currency`. */
  balance: number;
  currency: string;
};

/**
 * "Log follow-up": what the client said, and any promise to pay by a date. From a due on the
 * Collections page, and from the invoice, the order and the customer statement.
 */
export function LogFollowUpButton({
  target,
  label = "Log follow-up",
  variant = "secondary",
}: {
  target: LogFollowUpTarget;
  label?: string;
  variant?: "primary" | "secondary" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {/* The dialog renders nothing while closed, so each opening starts with an empty form. */}
      <Dialog open={open} onClose={() => setOpen(false)} title={`Log follow-up — ${target.label}`}>
        <LogFollowUpForm target={target} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

/**
 * The form itself. The dates can't be before the workspace's today — the server says so too
 * (`checkFutureDay`), since a date input's `min` is only a hint. A promised amount is in the invoice's
 * own currency.
 */
export function LogFollowUpForm({ target, onDone, onCancel }: { target: LogFollowUpTarget; onDone: () => void; onCancel: () => void }) {
  const router = useRouter();
  const id = useId();
  const clock = useClock();
  const [channel, setChannel] = useState<FollowUpChannel>("CALL");
  const [remarks, setRemarks] = useState("");
  const [promisedOn, setPromisedOn] = useState("");
  const [promisedAmount, setPromisedAmount] = useState("");
  const [nextFollowUpOn, setNextFollowUpOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [today] = useState(() => clock.today());
  const [pending, startTransition] = useTransition();
  const foreign = !isBaseCurrency(target.currency);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!remarks.trim()) {
      setError("Say what the client said.");
      return;
    }
    if (promisedAmount && !promisedOn) {
      setError("A promised amount needs the date they promised it by.");
      return;
    }
    startTransition(async () => {
      const result = await logFollowUp({
        documentId: target.documentId ?? "",
        companyProductId: target.companyProductId ?? "",
        channel,
        remarks,
        promisedOn,
        promisedAmount,
        nextFollowUpOn,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone();
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-muted">
        {target.companyName ? `${target.companyName} · ` : ""}
        {formatMoney(target.balance, target.currency)} outstanding on {target.label}
      </p>

      <div className="space-y-1.5">
        <Label htmlFor={`${id}-channel`}>How you reached them</Label>
        <Select id={`${id}-channel`} value={channel} onChange={(e) => setChannel(e.target.value as FollowUpChannel)}>
          {FOLLOW_UP_CHANNELS.map((c) => (
            <option key={c} value={c}>
              {followUpChannelLabels[c]}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${id}-remarks`}>What the client said</Label>
        <Textarea
          id={`${id}-remarks`}
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          maxLength={REMARKS_MAX}
          required
          aria-describedby={`${id}-remarks-count`}
          placeholder="e.g. Accounts will release it after the 10th — cheque to be couriered"
        />
        <p id={`${id}-remarks-count`} className="text-right text-xs text-subtle">
          {remarks.length.toLocaleString("en-IN")} / {REMARKS_MAX.toLocaleString("en-IN")}
        </p>
      </div>

      <fieldset className="space-y-3 rounded-lg border border-line p-3">
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-subtle">A promise to pay (optional)</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-promised-on`}>Will pay by</Label>
            <Input id={`${id}-promised-on`} type="date" min={today} value={promisedOn} onChange={(e) => setPromisedOn(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-promised-amount`}>Amount{foreign ? ` (${target.currency})` : ""}</Label>
            <Input
              id={`${id}-promised-amount`}
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              max={target.balance}
              value={promisedAmount}
              onChange={(e) => setPromisedAmount(e.target.value)}
              aria-describedby={`${id}-amount-hint`}
            />
          </div>
        </div>
        <p id={`${id}-amount-hint`} className="text-xs text-subtle">
          {foreign ? `In ${target.currency}, the invoice's currency. ` : ""}Leave the amount blank if they promised to clear it all. A new
          promise replaces the one still open on {target.label}.
        </p>
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor={`${id}-next`}>Next follow-up (optional)</Label>
        <Input id={`${id}-next`} type="date" min={today} value={nextFollowUpOn} onChange={(e) => setNextFollowUpOn(e.target.value)} />
        <p className="text-xs text-subtle">You&apos;ll get a task for that day, or a reminder that morning.</p>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save follow-up"}
        </Button>
      </div>
    </form>
  );
}
