"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Settings2, Timer, X } from "lucide-react";
import type { shortLeaveOverview } from "@/actions/short-leave";
import { applyForShortLeave, cancelShortLeave, decideShortLeave, saveShortLeavePolicy } from "@/actions/short-leave";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";
import { toKey } from "@/lib/hr/calendar";
import { leaveStatusTone } from "@/lib/validation/hr";
import { minuteOfTime, timeOfMinute } from "@/lib/hr/office-hours-rules";
import { durationWords, spanWords } from "@/lib/hr/short-leave-rules";

type Overview = NonNullable<Awaited<ReturnType<typeof shortLeaveOverview>>>;
type Request = Overview["mine"][number];

/**
 * Short leave by the hour on the leave page (owner, 18 Oct 2026): this month's count, asking for one,
 * your own with Withdraw, the ones waiting on you, and — for whoever manages HR — the company's rules.
 */
export function ShortLeavePanel({ overview }: { overview: Overview }) {
  const { policy, usedThisMonth, mine, pending, recent, canManage } = overview;
  const offered = policy.perMonth > 0;
  return (
    <Card id="short-leave">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-medium text-text">
            <Timer className="h-4 w-4 text-brand" aria-hidden />
            Short leave
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {offered
              ? `${usedThisMonth} of ${policy.perMonth} used this month · up to ${durationWords(policy.maxMinutes)} each · uses no leave balance`
              : "Your company doesn't offer short leave."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canManage && <RulesDialog policy={policy} />}
          {offered && <AskDialog overview={overview} />}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-subtle">Waiting on you ({pending.length})</h3>
            {pending.map((r) => (
              <ApprovalRow key={r.id} request={r} />
            ))}
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-subtle">Yours, this month on</h3>
          {mine.length === 0 && <p className="text-sm text-subtle">None asked for.</p>}
          {mine.map((r) => (
            <MyRow key={r.id} request={r} />
          ))}
        </div>

        {recent.length > 0 && (
          <div className="space-y-1.5 text-sm">
            <h3 className="text-xs font-medium uppercase tracking-wide text-subtle">Recently decided</h3>
            {recent.map((r) => (
              <div key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-text">{r.user.name}</span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {formatCalendarDay(r.date)}, {spanWords(r)}
                  <Badge tone={leaveStatusTone[r.status]}>{r.status}</Badge>
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Asking: the day, the hours and why. The rules are checked again on the server; this only helps. */
function AskDialog({ overview }: { overview: Overview }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const start = overview.hours?.startMinute ?? 9 * 60;
  const [date, setDate] = useState(overview.today);
  const [from, setFrom] = useState(timeOfMinute(start));
  const [to, setTo] = useState(timeOfMinute(Math.min(start + 60, 24 * 60 - 1)));
  const [reason, setReason] = useState("");

  const fromMinute = minuteOfTime(from);
  const toMinute = minuteOfTime(to);
  const length = fromMinute !== null && toMinute !== null ? toMinute - fromMinute : null;
  const tooLong = length !== null && length > overview.policy.maxMinutes;

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await applyForShortLeave({ date, from, to, reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setReason("");
      router.refresh();
    });
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Timer className="mr-1.5 h-3.5 w-3.5" />
        Ask for a short leave
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Ask for a short leave">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Before the day or after it, for any day this month or later. Once approved, it clears that day&apos;s Late or Left early mark.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="short-date">Day</Label>
            <Input id="short-date" type="date" value={date} min={`${overview.today.slice(0, 7)}-01`} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="short-from">From</Label>
              <Input id="short-from" type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="short-to">To</Label>
              <Input id="short-to" type="time" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          {length !== null && length > 0 && (
            <p className={`text-xs ${tooLong ? "text-danger" : "text-subtle"}`}>
              {durationWords(length)}
              {tooLong && ` — more than ${durationWords(overview.policy.maxMinutes)}; for longer, apply for a half day.`}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="short-reason">Reason</Label>
            <Textarea id="short-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Enough for your manager to decide on." />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button disabled={pending || !date || !length || length <= 0 || tooLong} onClick={submit}>
              {pending ? "Sending…" : "Send for approval"}
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

/** The company's rules, for whoever manages HR. */
function RulesDialog({ policy }: { policy: Overview["policy"] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [maxMinutes, setMaxMinutes] = useState(String(policy.maxMinutes));
  const [perMonth, setPerMonth] = useState(String(policy.perMonth));

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveShortLeavePolicy({ maxMinutes: Number(maxMinutes), perMonth: Number(perMonth) });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Settings2 className="mr-1.5 h-3.5 w-3.5" />
        Rules
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Short leave rules">
        <div className="space-y-4">
          <p className="text-sm text-muted">For the whole company. Past the month&apos;s count, people are told to apply for a half day instead.</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="short-max">Longest, in minutes</Label>
              <Input id="short-max" type="number" min={15} max={480} step={15} value={maxMinutes} onChange={(e) => setMaxMinutes(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="short-count">How many a month</Label>
              <Input id="short-count" type="number" min={0} max={31} value={perMonth} onChange={(e) => setPerMonth(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-subtle">0 a month switches short leave off.</p>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button disabled={pending} onClick={save}>
              {pending ? "Saving…" : "Save"}
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

function ApprovalRow({ request }: { request: Request }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function decide(approve: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await decideShortLeave({ id: request.id, approve, note });
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
            <span className="text-sm text-muted">
              {formatCalendarDay(request.date)}, {spanWords(request)}
            </span>
          </div>
          <p className="mt-1 text-sm text-text">{request.reason}</p>
          {error && <p className="mt-1 text-sm text-danger">{error}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            aria-label={`Note on ${request.user.name}'s short leave`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="h-8 w-40 text-xs"
          />
          <Button size="sm" disabled={pending} onClick={() => decide(true)}>
            <Check className="mr-1 h-3 w-3" />
            Approve
          </Button>
          <Button size="sm" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger" disabled={pending} onClick={() => decide(false)}>
            <X className="mr-1 h-3 w-3" />
            Reject
          </Button>
        </div>
      </div>
    </div>
  );
}

function MyRow({ request }: { request: Request }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // As cancelShortLeave decides it: a pending one any time, an approved one before its day.
  const withdrawable = request.status === "PENDING" || (request.status === "APPROVED" && toKey(request.date) > clock.today());

  function withdraw() {
    setError(null);
    startTransition(async () => {
      const result = await cancelShortLeave(request.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-2 last:border-0 last:pb-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={leaveStatusTone[request.status]}>{request.status}</Badge>
          <span className="text-sm text-text">
            {formatCalendarDay(request.date)}, {spanWords(request)}
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
      {withdrawable && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={withdraw}>
          Withdraw
        </Button>
      )}
    </div>
  );
}
