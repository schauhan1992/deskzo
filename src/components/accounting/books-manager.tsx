"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, LockOpen, ShieldCheck } from "lucide-react";
import type { getBooksStatus } from "@/actions/books";
import { closeFinancialYear, reopenFinancialYear, setBooksLock } from "@/actions/books";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/utils";
import { formatIstDate } from "@/lib/india-time";
import { closableYears } from "@/lib/ledger/period";

type Status = Awaited<ReturnType<typeof getBooksStatus>>;

/**
 * Closing the books.
 *
 * Every action here is destructive in the sense that matters — it changes what somebody else can
 * post — so each one says what it will do before it does it, and reopening a closed year asks for
 * the year to be typed rather than offering a button next to the close.
 */
export function BooksManager({ status, isAdmin }: { status: Status; isAdmin: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The lock arrives as a Date (a calendar day at UTC midnight); `String(date)` would give "Sat Aug 15",
  // which a date field silently drops — and the note below compares `yyyy-mm-dd` strings.
  const [lockDate, setLockDate] = useState(
    status.lockedUntil ? new Date(status.lockedUntil).toISOString().slice(0, 10) : "",
  );
  const [note, setNote] = useState(status.lockNote ?? "");
  const [closing, setClosing] = useState<string | null>(null);
  const [reopening, setReopening] = useState<string | null>(null);
  const [confirmLabel, setConfirmLabel] = useState("");

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      onOk?.();
      router.refresh();
    });
  }

  // Months the month-end close shows as closed that a change here would reopen: a lock moved back
  // below a closed month's last day (or removed) reopens that month and every later one.
  const closedMonths = status.closedMonths ?? [];
  const reopenedByLock = lockDate ? closedMonths.filter((m) => m.end > lockDate) : [];
  const reopeningYear = reopening ? status.closes.find((c) => c.label === reopening) : undefined;
  const reopenedByYear = reopeningYear
    ? closedMonths.filter((m) => m.end >= new Date(reopeningYear.fromDate).toISOString().slice(0, 10))
    : [];

  // Years that have finished and aren't closed yet — the only ones that can be closed.
  const closedLabels = new Set(status.closes.map((c) => c.label));
  // On India's calendar (period.ts `closableYears`).
  const closable = closableYears(new Date(), closedLabels);

  return (
    <div className="space-y-4">
      {error && <Card className="border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</Card>}
      {message && <Card className="border-success/40 bg-success-bg px-4 py-3 text-sm text-success">{message}</Card>}

      {/* ── The lock ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
          <span className="flex items-center gap-1.5">
            {status.lockedUntil ? <Lock className="h-3.5 w-3.5 text-success" /> : <LockOpen className="h-3.5 w-3.5 text-warning" />}
            Period lock
          </span>
          {status.lockedUntil ? (
            <Badge tone="green">Closed to {formatDate(status.lockedUntil)}</Badge>
          ) : (
            <Badge tone="amber">Nothing is locked</Badge>
          )}
        </CardHeader>

        <CardContent className="space-y-4">
          {status.lockedUntil ? (
            <p className="text-sm text-muted">
              Nothing dated on or before <span className="text-text">{formatDate(status.lockedUntil)}</span> can be
              posted, reversed or corrected. To fix something in a closed period, post the correction in an open one —
              which is what an accountant would do on paper.
              {status.lockedBy && (
                <span className="block text-xs text-subtle">
                  Set by {status.lockedBy}
                  {status.lockUpdatedAt && ` on ${formatDate(status.lockUpdatedAt)}`}
                  {status.lockNote && ` — ${status.lockNote}`}
                </span>
              )}
            </p>
          ) : (
            <p className="text-sm text-muted">
              Anybody who can write a journal can currently back-date one into any period, including one you have
              already filed a return for. Lock up to the end of your last filed month.
            </p>
          )}

          {isAdmin && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lockDate">Lock everything up to and including</Label>
                <Input id="lockDate" type="date" value={lockDate} onChange={(e) => setLockDate(e.target.value)} />
              </div>
              <div className="min-w-48 flex-1 space-y-1.5">
                <Label htmlFor="lockNote">Why</Label>
                <Input
                  id="lockNote"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="GST filed to September"
                />
              </div>
              <Button
                disabled={pending || !lockDate}
                onClick={() =>
                  run(() => setBooksLock({ lockedUntil: lockDate, note }), () => setMessage("The books are locked."))
                }
              >
                <Lock className="mr-1.5 h-3.5 w-3.5" />
                {pending ? "Saving…" : "Lock"}
              </Button>
              {status.lockedUntil && (
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => setBooksLock({ lockedUntil: null }),
                      () => {
                        setLockDate("");
                        setMessage("The lock has been removed. Everything is postable again.");
                      },
                    )
                  }
                >
                  Remove the lock
                </Button>
              )}
            </div>
          )}

          {isAdmin && reopenedByLock.length > 0 && (
            <p className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
              Locking to {formatIstDate(`${lockDate}T00:00:00.000Z`)} reopens {listOf(reopenedByLock.map((m) => m.label))} on
              the{" "}
              <Link href="/accounting/close" className="font-medium underline underline-offset-2">
                month-end close
              </Link>
              : {reopenedByLock.length === 1 ? "it is" : "they are"} closed there, and the lock would no longer cover{" "}
              {reopenedByLock.length === 1 ? "it" : "them"}. {reopenedByLock.length === 1 ? "It" : "They"} will need
              closing again.
            </p>
          )}
          {isAdmin && status.lockedUntil && closedMonths.length > 0 && (
            <p className="text-xs text-subtle">
              Removing the lock reopens every month closed on the month-end close ({listOf(closedMonths.map((m) => m.label))}).
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Year end ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="text-sm font-medium text-text">Financial years</CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted">
            Closing a year writes one entry that moves the profit into reserves and zeroes every income and expense
            account, so the next year opens at nil while the balance sheet carries forward. Until a year is closed,
            the balance sheet still shows the right reserves — it just can&apos;t separate last year&apos;s from this
            year&apos;s.
          </p>

          {status.closes.length > 0 && (
            <ul className="divide-y divide-line rounded-base border border-line">
              {status.closes.map((close) => (
                <li key={close.label} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <span className="flex items-center gap-1.5 font-medium text-text">
                    <ShieldCheck className="h-3.5 w-3.5 text-success" />
                    {close.label}
                  </span>
                  <span className="text-sm tabular-nums text-muted">
                    Net {Number(close.netProfit) >= 0 ? "profit" : "loss"}{" "}
                    {formatCurrency(Math.abs(Number(close.netProfit)))}
                  </span>
                  {close.closingEntry && (
                    <Link
                      href="/accounting/journal"
                      className="font-mono text-xs text-brand hover:underline"
                    >
                      {close.closingEntry.entryNumber}
                    </Link>
                  )}
                  <span className="text-xs text-subtle">
                    Closed by {close.closedBy.name} on {formatDate(close.closedAt)}
                  </span>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => {
                        setReopening(close.label);
                        setConfirmLabel("");
                      }}
                      className="ml-auto text-xs text-subtle hover:text-danger"
                    >
                      Reopen
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {isAdmin && closable.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted">Ready to close:</span>
              {closable.map((label) => (
                <Button key={label} variant="secondary" size="sm" onClick={() => setClosing(label)}>
                  {label}
                </Button>
              ))}
            </div>
          )}
          {closable.length === 0 && status.closes.length === 0 && (
            <p className="text-sm text-subtle">
              No finished year is waiting to be closed. The current year, {status.currentYear.label}, can be closed
              after {formatDate(status.currentYear.to)}.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Confirmations ─────────────────────────────────────────────── */}
      <Dialog open={!!closing} onClose={() => setClosing(null)} title={`Close ${closing ?? ""}`}>
        <div className="space-y-4">
          <p className="text-sm text-muted">This will, in one transaction:</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Debit every income account and credit every expense account by its own balance, back to nil.</li>
            <li>Post the difference to Retained Earnings.</li>
            <li>Lock the books to 31 March {closing ? Number(closing.slice(0, 4)) + 1 : ""} — a closed year that can still be posted into is not closed.</li>
          </ul>
          <p className="text-sm text-muted">
            It can be undone by reopening the year, which reverses the entry rather than deleting it.
          </p>
          <div className="flex gap-2">
            <Button
              disabled={pending}
              onClick={() =>
                run(
                  async () => {
                    const result = await closeFinancialYear(closing!);
                    if (result.ok) {
                      setMessage(
                        `${closing} is closed. Net ${result.data.netProfit >= 0 ? "profit" : "loss"} ${formatCurrency(Math.abs(result.data.netProfit))}${result.data.entryNumber ? ` — entry ${result.data.entryNumber}` : ""}.`,
                      );
                    }
                    return result;
                  },
                  () => setClosing(null),
                )
              }
            >
              {pending ? "Closing…" : `Close ${closing}`}
            </Button>
            <Button variant="secondary" onClick={() => setClosing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={!!reopening} onClose={() => setReopening(null)} title={`Reopen ${reopening ?? ""}`}>
        <div className="space-y-4">
          <p className="text-sm text-muted">
            The closing entry will be <span className="text-text">reversed, not deleted</span>, so the year reads as
            one that was closed and reopened. The lock rolls back to the start of the year, and everything in it
            becomes postable again — including figures you may already have filed against.
          </p>
          {reopenedByYear.length > 0 && (
            <p className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
              It also reopens {listOf(reopenedByYear.map((m) => m.label))} on the month-end close.
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="confirmYear">Type {reopening} to confirm</Label>
            <Input id="confirmYear" value={confirmLabel} onChange={(e) => setConfirmLabel(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button
              variant="danger"
              disabled={pending || confirmLabel.trim() !== reopening}
              onClick={() =>
                run(
                  () => reopenFinancialYear(reopening!),
                  () => {
                    setReopening(null);
                    setMessage(`${reopening} is open again.`);
                  },
                )
              }
            >
              {pending ? "Reopening…" : "Reopen the year"}
            </Button>
            <Button variant="secondary" onClick={() => setReopening(null)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/** "May 2025", "May 2025 and June 2025", "May 2025, June 2025 and July 2025". */
function listOf(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
