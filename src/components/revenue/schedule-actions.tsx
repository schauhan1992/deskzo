"use client";

import { useId, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cancelSchedule, editSchedule } from "@/actions/revenue";
import { monthLabel } from "@/lib/revenue/periods";
import { formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ApproveButton } from "@/components/revenue/approve-button";
import { istDay } from "@/components/revenue/labels";

export type EditableSchedule = {
  id: string;
  kind: "RATABLE" | "MILESTONE";
  status: string;
  startDate: string | null;
  endDate: string | null;
  amount: number;
  spreadEvenly: boolean;
  note: string | null;
  /** Still in Deferred Revenue: what a cancellation recognises now. */
  remaining: number;
};

type Patch = { startDate?: string; endDate?: string; amount?: number; spreadEvenly?: boolean; note?: string | null };
type EditConfirm = { reclass: number; date: string; months: { month: string; amount: number }[] };
type CancelConfirm = { amount: number; date: string };

/**
 * What a manager can do to one schedule (spec §3.4): approve it, re-plan it, cancel it.
 *
 * Re-planning and cancelling can post an entry — a changed amount moves the difference between
 * Deferred Revenue and Sales now, and a cancellation recognises what is left now — so each asks the
 * action first, shows the figure and the date it would post on, and only then sends it again with that
 * figure. If the schedule moved in between, the action asks again with the new figure.
 */
export function ScheduleActions({
  schedule,
  mayApprove,
  approveOwn,
}: {
  schedule: EditableSchedule;
  mayApprove: boolean;
  approveOwn: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const live = schedule.status === "ACTIVE" || schedule.status === "PENDING_APPROVAL";

  return (
    <div className="space-y-3">
      {message && (
        <p role="status" className="rounded-lg border border-success/40 bg-success-bg px-3 py-2 text-sm text-success">
          {message}
        </p>
      )}
      <div className="flex flex-wrap items-start gap-2">
        {mayApprove && <ApproveButton id={schedule.id} own={approveOwn} size="md" />}
        {live && (
          <>
            <Button type="button" variant="secondary" onClick={() => { setMessage(null); setEditing(true); }}>
              Edit
            </Button>
            <Button type="button" variant="ghost" className="text-danger hover:text-danger" onClick={() => { setMessage(null); setCancelling(true); }}>
              Cancel schedule
            </Button>
          </>
        )}
      </div>
      {!live && <p className="text-xs text-subtle">A {schedule.status === "COMPLETED" ? "completed" : "cancelled"} schedule can&apos;t be changed.</p>}

      <EditDialog
        open={editing}
        schedule={schedule}
        onClose={() => setEditing(false)}
        onDone={(text) => {
          setEditing(false);
          setMessage(text);
          router.refresh();
        }}
      />
      <CancelDialog
        open={cancelling}
        schedule={schedule}
        onClose={() => setCancelling(false)}
        onDone={(text) => {
          setCancelling(false);
          setMessage(text);
          router.refresh();
        }}
      />
    </div>
  );
}

function EditDialog({
  open,
  schedule,
  onClose,
  onDone,
}: {
  open: boolean;
  schedule: EditableSchedule;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const ids = { start: useId(), end: useId(), amount: useId(), evenly: useId(), note: useId() };
  const [start, setStart] = useState(schedule.startDate ?? "");
  const [end, setEnd] = useState(schedule.endDate ?? "");
  const [amount, setAmount] = useState(String(schedule.amount));
  const [evenly, setEvenly] = useState(schedule.spreadEvenly);
  const [note, setNote] = useState(schedule.note ?? "");
  const [confirm, setConfirm] = useState<{ patch: Patch; figures: EditConfirm } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ratable = schedule.kind === "RATABLE";

  function close() {
    setConfirm(null);
    setError(null);
    onClose();
  }

  /** Only what changed — an unchanged field sent anyway would read as a re-plan. */
  function patchOf(): Patch | string {
    const patch: Patch = {};
    if (ratable && start !== (schedule.startDate ?? "")) patch.startDate = start;
    if (ratable && end !== (schedule.endDate ?? "")) patch.endDate = end;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return "The amount has to be more than nil.";
    if (Math.round(value * 100) !== Math.round(schedule.amount * 100)) patch.amount = Math.round(value * 100) / 100;
    if (evenly !== schedule.spreadEvenly) patch.spreadEvenly = evenly;
    if (note.trim() !== (schedule.note ?? "").trim()) patch.note = note.trim() || null;
    if (Object.keys(patch).length === 0) return "Nothing has changed.";
    return patch;
  }

  function send(patch: Patch, confirmReclass?: number) {
    setError(null);
    startTransition(async () => {
      const result = await editSchedule(schedule.id, confirmReclass === undefined ? patch : { ...patch, confirmReclass });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.data.status === "confirm") {
        setConfirm({ patch, figures: { reclass: result.data.reclass, date: result.data.date, months: result.data.months } });
        return;
      }
      const replans = Object.keys(patch).some((k) => k !== "note");
      setConfirm(null);
      onDone(
        replans
          ? `Saved${result.data.entryNumber ? `, and ${formatCurrency(Math.abs(result.data.reclass))} moved in ${result.data.entryNumber}` : ""}. The schedule now waits for approval by somebody else with Revenue & Close management, and recognises nothing until then.`
          : "The note is saved.",
      );
    });
  }

  return (
    <Dialog open={open} onClose={close} title="Edit the schedule">
      {confirm ? (
        <div className="space-y-4">
          <ReclassConfirm {...confirm.figures} />
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={pending} onClick={() => send(confirm.patch, confirm.figures.reclass)}>
              {pending ? "Posting…" : "Post and save"}
            </Button>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => setConfirm(null)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const patch = patchOf();
            if (typeof patch === "string") {
              setError(patch);
              return;
            }
            send(patch);
          }}
        >
          <p className="text-sm text-muted">
            Months already recognised never change: what is left is spread afresh over the unposted months. Changing the
            period, the amount or how it is spread sends the schedule back for approval by somebody else.
          </p>
          {ratable ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={ids.start}>Service from</Label>
                <Input id={ids.start} type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={ids.end}>Service to</Label>
                <Input id={ids.end} type="date" value={end} onChange={(e) => setEnd(e.target.value)} required />
              </div>
            </div>
          ) : (
            <p className="text-xs text-subtle">A milestone schedule has no period: it is earned when its delivery milestone is done.</p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={ids.amount}>Amount (₹)</Label>
            <Input id={ids.amount} type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            <p className="text-xs text-subtle">A new amount moves the difference between Deferred Revenue and Sales straight away — you&apos;ll see the figure first.</p>
          </div>
          {ratable && (
            <label htmlFor={ids.evenly} className="flex items-start gap-2 text-sm text-text">
              <input id={ids.evenly} type="checkbox" className="mt-1" checked={evenly} onChange={(e) => setEvenly(e.target.checked)} />
              <span>
                Spread evenly by month
                <span className="block text-xs text-muted">Otherwise by day: each month in proportion to its days in the period.</span>
              </span>
            </label>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={ids.note}>Note</Label>
            <Textarea id={ids.note} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Checking…" : "Save"}
            </Button>
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function CancelDialog({
  open,
  schedule,
  onClose,
  onDone,
}: {
  open: boolean;
  schedule: EditableSchedule;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState<CancelConfirm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function close() {
    setConfirm(null);
    setError(null);
    onClose();
  }

  function send(confirmAmount?: number) {
    setError(null);
    if (!reason.trim()) {
      setError("Say why it is being cancelled.");
      return;
    }
    startTransition(async () => {
      const result = await cancelSchedule(schedule.id, reason, confirmAmount);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.data.status === "confirm") {
        setConfirm({ amount: result.data.amount, date: result.data.date });
        return;
      }
      setConfirm(null);
      onDone(
        `Cancelled.${result.data.amount > 0 ? ` ${formatCurrency(result.data.amount)} was recognised now${result.data.entryNumber ? ` in ${result.data.entryNumber}` : ""}.` : ""}`,
      );
    });
  }

  return (
    <Dialog open={open} onClose={close} title="Cancel the schedule">
      <div className="space-y-4">
        {confirm ? (
          <CancelConfirmStep {...confirm} />
        ) : (
          <>
            <p className="text-sm text-muted">
              Cancelling recognises whatever the schedule still holds in Deferred Revenue at once, in one entry, and drops
              its unposted months. Months already recognised stay as they are. To take revenue back from a customer, raise
              a credit note instead.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor={reasonId}>Why</Label>
              <Textarea id={reasonId} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Contract ended early" />
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {confirm ? (
            <Button type="button" variant="danger" disabled={pending} onClick={() => send(confirm.amount)}>
              {pending ? "Cancelling…" : confirm.amount > 0 ? `Recognise ${formatCurrency(confirm.amount)} and cancel` : "Cancel it"}
            </Button>
          ) : (
            <Button type="button" variant="danger" disabled={pending || !reason.trim()} onClick={() => send()}>
              {pending ? "Checking…" : "Continue"}
            </Button>
          )}
          <Button type="button" variant="secondary" disabled={pending} onClick={close}>
            Keep it
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** The edit's confirm step: the figure a changed amount moves, which way, on what date, and the months it leaves. */
export function ReclassConfirm({ reclass, date, months }: EditConfirm) {
  const toSales = reclass > 0;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-text">
        This posts one entry on <span className="font-medium">{istDay(date)}</span>, moving{" "}
        <span className="font-semibold tabular-nums">{formatCurrency(Math.abs(reclass))}</span>{" "}
        {toSales ? "from Deferred Revenue to Sales" : "from Sales to Deferred Revenue"}.
      </p>
      <p className="text-muted">
        {toSales
          ? "The schedule is worth less than it was, so the difference is recognised now rather than left in Deferred Revenue."
          : "The schedule is worth more than it was, so the difference comes out of Sales now and is recognised over the months below."}{" "}
        It then waits for approval by somebody else with Revenue &amp; Close management.
      </p>
      {months.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded-base border border-line">
          <table className="w-full text-sm">
            <caption className="sr-only">The months still to recognise</caption>
            <tbody>
              {months.map((m) => (
                <tr key={m.month} className="border-b border-line last:border-0">
                  <td className="px-3 py-1 text-muted">{monthLabel(m.month)}</td>
                  <td className="whitespace-nowrap px-3 py-1 text-right tabular-nums text-text">{formatCurrency(m.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-subtle">
        Posted by you, and in the <Link href="/accounting/journal" className="underline">journal</Link> like any other entry.
      </p>
    </div>
  );
}

/** The cancellation's confirm step: what is recognised now, and when. */
export function CancelConfirmStep({ amount, date }: CancelConfirm) {
  return amount > 0 ? (
    <p className="text-sm text-text">
      <span className="font-semibold tabular-nums">{formatCurrency(amount)}</span> still in Deferred Revenue will be recognised
      into Sales in one entry on <span className="font-medium">{istDay(date)}</span>, and the schedule&apos;s unposted
      months are dropped. This can&apos;t be undone.
    </p>
  ) : (
    <p className="text-sm text-text">
      Nothing is left in Deferred Revenue on this schedule, so no entry is posted; it is simply marked cancelled on{" "}
      {istDay(date)}.
    </p>
  );
}
