"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Check, X } from "lucide-react";
import type { BalanceRow, leaveApprovalQueue, myLeaveRequests, upcomingLeave } from "@/actions/leave";
import { applyForLeave, cancelLeave, decideLeave, previewLeaveDays } from "@/actions/leave";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/bulk-select";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";
import { toKey } from "@/lib/hr/calendar";
import { leaveStatusTone } from "@/lib/validation/hr";

type MyRequest = Awaited<ReturnType<typeof myLeaveRequests>>[number];
type Queue = Awaited<ReturnType<typeof leaveApprovalQueue>>;
type Upcoming = Awaited<ReturnType<typeof upcomingLeave>>;

export function LeaveWorkspace({
  balances,
  mine,
  queue,
  upcoming,
  leaveTypes,
}: {
  balances: BalanceRow[];
  mine: MyRequest[];
  queue: Queue;
  upcoming: Upcoming;
  leaveTypes: { id: string; name: string; code: string; paid: boolean }[];
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {balances.map((b) => (
            <Card key={b.typeId} className="px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-subtle">
                {b.code}
                {!b.paid && " · unpaid"}
              </div>
              <div className="mt-0.5 text-lg font-semibold text-text">{b.paid ? b.available : "—"}</div>
              <div className="text-[11px] text-muted">
                {b.paid ? `of ${b.opening + b.credited + b.adjustment} left` : "no balance, costs pay"}
                {b.pending > 0 && ` · ${b.pending} pending`}
              </div>
            </Card>
          ))}
          {balances.length === 0 && (
            <Card className="px-4 py-3 text-sm text-subtle">
              No leave types set up yet — HR needs to add them before anyone can apply.
            </Card>
          )}
        </div>
        {leaveTypes.length > 0 && <ApplyDialog leaveTypes={leaveTypes} balances={balances} />}
      </div>

      {queue.pending.length > 0 && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">
            Waiting on you ({queue.pending.length})
          </CardHeader>
          <CardContent className="space-y-3">
            {queue.pending.map((r) => (
              <ApprovalRow key={r.id} request={r} />
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="text-sm font-medium text-text">Your requests</CardHeader>
          <CardContent className="space-y-3">
            {mine.length === 0 && <p className="text-sm text-subtle">You haven&apos;t applied for any leave.</p>}
            {mine.map((r) => (
              <MyRequestRow key={r.id} request={r} />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="text-sm font-medium text-text">Who&apos;s off soon</CardHeader>
          <CardContent className="space-y-2 text-sm">
            {upcoming.length === 0 && <p className="text-subtle">Nobody is booked off in the next month.</p>}
            {upcoming.map((r) => (
              <div key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-text">{r.user.name}</span>
                <span className="text-xs text-muted">
                  {formatCalendarDay(r.fromDate)}
                  {String(r.fromDate) !== String(r.toDate) && ` – ${formatCalendarDay(r.toDate)}`} · {r.type.code}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {queue.recent.length > 0 && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Recently decided</CardHeader>
          <CardContent className="space-y-2 text-sm">
            {queue.recent.map((r) => (
              <div key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-text">
                  {r.user.name} · {Number(r.days)} day(s) {r.type.code}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {formatCalendarDay(r.fromDate)}
                  <Badge tone={leaveStatusTone[r.status]}>{r.status}</Badge>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * Applying.
 *
 * The day count is worked out on the server as the dates change, rather than in the browser,
 * because only the server knows the holiday calendar — and a form that says "3 days" while the
 * approval deducts 2 is the kind of discrepancy nobody forgets.
 */
function ApplyDialog({
  leaveTypes,
  balances,
}: {
  leaveTypes: { id: string; name: string; code: string; paid: boolean }[];
  balances: BalanceRow[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [typeId, setTypeId] = useState(leaveTypes[0]?.id ?? "");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [fromHalfDay, setFromHalfDay] = useState(false);
  const [toHalfDay, setToHalfDay] = useState(false);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{ days: number; skipped: { date: string; why: string }[] } | null>(null);

  // The fetch is the only thing the effect does. Clearing the count when a date is emptied is
  // derived during render instead — setting state synchronously in an effect body is what the
  // React compiler rejects, and there is no reason to store what can simply be computed.
  useEffect(() => {
    if (!fromDate || !toDate) return;
    let cancelled = false;
    void previewLeaveDays({ fromDate, toDate, fromHalfDay, toHalfDay }).then((result) => {
      if (!cancelled) setPreview(result);
    });
    return () => {
      cancelled = true;
    };
  }, [fromDate, toDate, fromHalfDay, toHalfDay]);

  const shownPreview = fromDate && toDate ? preview : null;

  const balance = balances.find((b) => b.typeId === typeId);
  const type = leaveTypes.find((t) => t.id === typeId);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await applyForLeave({ typeId, fromDate, toDate, fromHalfDay, toHalfDay, reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setFromDate("");
      setToDate("");
      setReason("");
      setFromHalfDay(false);
      setToHalfDay(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <CalendarPlus className="mr-1.5 h-3.5 w-3.5" />
        Apply for leave
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Apply for leave">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="leaveType">Type</Label>
            <Select id="leaveType" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              {leaveTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.code})
                </option>
              ))}
            </Select>
            {balance && type?.paid && (
              <p className="text-xs text-subtle">
                {balance.available} day(s) available{balance.pending > 0 && `, ${balance.pending} already awaiting approval`}.
              </p>
            )}
            {type && !type.paid && <p className="text-xs text-warning">Unpaid — these days come off your salary.</p>}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="fromDate">From</Label>
              <Input id="fromDate" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
              <label className="flex items-center gap-2 text-xs text-muted">
                <Checkbox checked={fromHalfDay} onChange={() => setFromHalfDay((v) => !v)} aria-label="Half day on the first day" />
                Second half only
              </label>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="toDate">To</Label>
              <Input id="toDate" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} min={fromDate} />
              <label className="flex items-center gap-2 text-xs text-muted">
                <Checkbox checked={toHalfDay} onChange={() => setToHalfDay((v) => !v)} aria-label="Half day on the last day" />
                First half only
              </label>
            </div>
          </div>

          {shownPreview && (
            <div className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm">
              <span className="font-medium text-text">{shownPreview.days} day(s)</span>
              <span className="text-muted"> will come off your balance.</span>
              {shownPreview.skipped.length > 0 && (
                <p className="mt-1 text-xs text-subtle">
                  {shownPreview.skipped.length} day(s) in that range are weekends or holidays and cost nothing.
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="leaveReason">Reason</Label>
            <Textarea
              id="leaveReason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Enough for your manager to decide on."
            />
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button disabled={pending || !fromDate || !toDate || !shownPreview?.days} onClick={submit}>
              {pending ? "Applying…" : "Submit"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function ApprovalRow({ request }: { request: Queue["pending"][number] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function decide(approve: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await decideLeave({ id: request.id, approve, note });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text">{request.user.name}</span>
            <Badge tone="default">{request.type.code}</Badge>
            <span className="text-sm text-muted">
              {Number(request.days)} day(s) · {formatCalendarDay(request.fromDate)}
              {String(request.fromDate) !== String(request.toDate) && ` – ${formatCalendarDay(request.toDate)}`}
            </span>
            {!request.type.paid && <Badge tone="amber">Unpaid</Badge>}
          </div>
          <p className="mt-1 text-sm text-text">{request.reason}</p>
          {error && <p className="mt-1 text-sm text-danger">{error}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            // One of these per request, so the name says which request it belongs to.
            aria-label={`Note on ${request.user.name}'s leave request`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="h-8 w-40 text-xs"
          />
          <Button size="sm" disabled={pending} onClick={() => decide(true)}>
            <Check className="mr-1 h-3 w-3" />
            Approve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger hover:bg-danger-bg hover:text-danger"
            disabled={pending}
            onClick={() => decide(false)}
          >
            <X className="mr-1 h-3 w-3" />
            Reject
          </Button>
        </div>
      </div>
    </div>
  );
}

function MyRequestRow({ request }: { request: MyRequest }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Its first day against the workspace's today, as cancelLeave decides it. Against the moment now it
  // started at midnight UTC: 05:30 on the day in India, the evening before west of UTC.
  const started = toKey(request.fromDate) <= clock.today();
  const cancellable = (request.status === "PENDING" || request.status === "APPROVED") && !started;

  function cancel() {
    setError(null);
    startTransition(async () => {
      const result = await cancelLeave(request.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={leaveStatusTone[request.status]}>{request.status}</Badge>
          <span className="text-sm text-text">
            {Number(request.days)} day(s) {request.type.name}
          </span>
          <span className="text-xs text-muted">
            {formatCalendarDay(request.fromDate)}
            {String(request.fromDate) !== String(request.toDate) && ` – ${formatCalendarDay(request.toDate)}`}
          </span>
        </div>
        <p className="mt-0.5 text-sm text-muted">{request.reason}</p>
        {request.decisionNote && (
          <p className="mt-0.5 text-xs text-subtle">
            {request.approver?.name}: {request.decisionNote}
          </p>
        )}
        {error && <p className="mt-1 text-sm text-danger">{error}</p>}
      </div>
      {cancellable && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={cancel}>
          Withdraw
        </Button>
      )}
    </div>
  );
}
