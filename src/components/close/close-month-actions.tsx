"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, LockOpen } from "lucide-react";
import { closeMonth, reopenMonth } from "@/actions/close";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { listOf } from "@/components/close/format";

/**
 * "Close September" and "Reopen September".
 *
 * Both move the period lock, so both need `close.manage` *and* the ledger's own `books.close`, and
 * both say what they will do before doing it. Closing is refused while tasks are open unless a reason
 * is written — the reason goes into the audit log with the person's name — and never before the month
 * has ended or an earlier month is closed.
 */
export function CloseMonthActions({
  monthKey,
  name,
  label,
  status,
  canClose,
  canManage,
  openTasks,
  hardBlockers,
  lockDay,
  previousLockDay,
  laterClosed,
}: {
  monthKey: string;
  /** "September". */
  name: string;
  /** "September 2026". */
  label: string;
  status: "OPEN" | "CLOSED";
  canClose: boolean;
  canManage: boolean;
  openTasks: number;
  /** Reasons no override gets past: the month hasn't ended, an earlier month is open. */
  hardBlockers: string[];
  /** "30 Sep 2026": where the lock goes. */
  lockDay: string;
  /** "31 Aug 2026": where a reopening moves it back to. */
  previousLockDay: string;
  /** Closed months after this one, which a reopening reopens too. */
  laterClosed: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"close" | "override" | "reopen" | null>(null);
  const [reason, setReason] = useState("");

  function openDialog(which: "close" | "override" | "reopen") {
    setReason("");
    setError(null);
    setDialog(which);
  }

  function submit() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      if (dialog === "reopen") {
        const result = await reopenMonth(monthKey, reason);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setMessage(`Reopened ${listOf(result.data.reopened)}.`);
      } else {
        const result = await closeMonth(monthKey, { override: dialog === "override" ? reason : null });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setMessage(
          result.data.lockedUntil
            ? `${label} is closed. The books are locked to ${lockDay}.`
            : `${label} is closed. The lock was already later than ${lockDay}, so it hasn't moved.`,
        );
      }
      setDialog(null);
      router.refresh();
    });
  }

  const blocked = hardBlockers.length > 0 || openTasks > 0;
  const reasonId = `close-${monthKey}-reason`;
  const whyId = `close-${monthKey}-why`;

  if (!canClose) {
    return (
      <p className="text-xs text-subtle">
        {canManage
          ? `Closing ${name} also needs “Close the books”, because it moves the period lock.`
          : `Closing ${name} is for somebody who manages the close and may close the books.`}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {message && <Card className="border-success/40 bg-success-bg px-4 py-2.5 text-sm text-success">{message}</Card>}
      {error && !dialog && <Card className="border-danger/40 bg-danger-bg px-4 py-2.5 text-sm text-danger">{error}</Card>}

      {status === "OPEN" ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={pending || blocked}
              onClick={() => openDialog("close")}
              aria-describedby={blocked ? whyId : undefined}
              aria-controls={`close-${monthKey}-confirm`}
            >
              <Lock className="h-3.5 w-3.5" aria-hidden />
              Close {name}
            </Button>
            {hardBlockers.length === 0 && openTasks > 0 && (
              <Button variant="secondary" disabled={pending} onClick={() => openDialog("override")} aria-controls={`close-${monthKey}-confirm`}>
                Close with open tasks…
              </Button>
            )}
          </div>
          {blocked && (
            <p id={whyId} className="text-xs text-muted">
              {[...hardBlockers, ...(openTasks > 0 ? [`${openTasks} task${openTasks === 1 ? " is" : "s are"} still open.`] : [])].join(" ")}
              {hardBlockers.length === 0 && openTasks > 0 && " Finish them, mark them not applicable, or close with a written reason."}
            </p>
          )}
        </>
      ) : (
        <Button variant="secondary" disabled={pending} onClick={() => openDialog("reopen")} aria-controls={`close-${monthKey}-reopen`}>
          <LockOpen className="h-3.5 w-3.5" aria-hidden />
          Reopen {name}
        </Button>
      )}

      {/*
        The confirm steps sit in the page rather than in a dialog, each hidden until asked for: what
        closing does is read before it is done, and the override's reason field is right under the
        button that needed it.
      */}
      {status === "OPEN" && (
        <section
          id={`close-${monthKey}-confirm`}
          hidden={dialog !== "close" && dialog !== "override"}
          aria-label={dialog === "override" ? `Close ${label} with open tasks` : `Close ${label}`}
          className="max-w-2xl space-y-3 rounded-base border border-line bg-surface-sunken/60 p-4"
        >
          <p className="text-sm text-muted">
            Closing locks the books to <span className="text-text">{lockDay}</span>: nothing dated on or before it can be
            posted, reversed or corrected until {name} is reopened. {label} is marked closed, and its checklist can&apos;t be
            changed.
          </p>
          {openTasks > 0 && hardBlockers.length === 0 && (
            <div hidden={dialog !== "override"} className="space-y-1.5">
              <Label htmlFor={reasonId}>
                Why close with {openTasks} task{openTasks === 1 ? "" : "s"} still open?
              </Label>
              <Textarea
                id={reasonId}
                value={reason}
                maxLength={1000}
                onChange={(e) => setReason(e.target.value)}
                placeholder="GST filed offline; the TDS reconciliation follows next week"
              />
              <p className="text-xs text-subtle">Audited: the reason is recorded in the audit log with your name, and kept on the month.</p>
            </div>
          )}
          {error && dialog && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending || (dialog === "override" && !reason.trim())} onClick={submit}>
              {pending ? "Closing…" : `Lock the books and close ${name}`}
            </Button>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
          </div>
        </section>
      )}

      {status === "CLOSED" && (
        <section
          id={`close-${monthKey}-reopen`}
          hidden={dialog !== "reopen"}
          aria-label={`Reopen ${label}`}
          className="max-w-2xl space-y-3 rounded-base border border-line bg-surface-sunken/60 p-4"
        >
          <p className="text-sm text-muted">
            The lock moves back to <span className="text-text">{previousLockDay}</span>, so {name} can be posted into again and
            its checklist worked. It will need closing again.
          </p>
          {laterClosed.length > 0 && (
            <p className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
              {listOf(laterClosed)} {laterClosed.length === 1 ? "is" : "are"} closed after it and reopen{laterClosed.length === 1 ? "s" : ""} too
              — a month closed on top of figures that are changing is not closed.
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={`${reasonId}-reopen`}>Why reopen it?</Label>
            <Textarea
              id={`${reasonId}-reopen`}
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
              placeholder="A vendor bill for September arrived late"
            />
            <p className="text-xs text-subtle">Audited: recorded in the audit log with your name.</p>
          </div>
          {error && dialog && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" disabled={pending || !reason.trim()} onClick={submit}>
              {pending ? "Reopening…" : `Reopen ${name}`}
            </Button>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
