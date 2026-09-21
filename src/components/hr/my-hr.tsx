"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, LogIn, LogOut, X } from "lucide-react";
import type { BalanceRow, myLeaveRequests } from "@/actions/leave";
import type { myRegularisations, regularisationQueue } from "@/actions/regularisation";
import type { myPayslips } from "@/actions/payroll";
import type { listHolidays } from "@/actions/hr";
import { clockIn, clockOut } from "@/actions/attendance";
import { cancelRegularisation, decideRegularisation, requestRegularisation } from "@/actions/regularisation";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/utils";
import { monthLabel, dateOnly } from "@/lib/hr/calendar";
import { attendanceStatusLabels, attendanceStatusValues, leaveStatusTone } from "@/lib/validation/hr";

type Leave = Awaited<ReturnType<typeof myLeaveRequests>>[number];
type Reg = Awaited<ReturnType<typeof myRegularisations>>[number];
type Queue = Awaited<ReturnType<typeof regularisationQueue>>;
type Slip = Awaited<ReturnType<typeof myPayslips>>[number];
type Holiday = Awaited<ReturnType<typeof listHolidays>>[number];
type TodayRow = { status: string; checkInAt: Date | string | null; checkOutAt: Date | string | null } | null;

const num = (v: unknown) => Number(v ?? 0);

/**
 * Everything one employee needs from HR, on one page.
 *
 * It exists because the pieces were already built but scattered across four screens organised by
 * *feature* — leave here, attendance there, payroll somewhere else. That is the right shape for HR,
 * who work a feature at a time, and the wrong one for everybody else, who have about four questions
 * and want them answered without a tour.
 */
export function MyHr({
  today,
  balances,
  leave,
  regularisations,
  queue,
  payslips,
  nextHoliday,
}: {
  today: TodayRow;
  balances: BalanceRow[];
  leave: Leave[];
  regularisations: Reg[];
  queue: Queue;
  payslips: Slip[];
  nextHoliday: Holiday | null;
}) {
  const pendingLeave = leave.filter((l) => l.status === "PENDING");
  const pendingRegs = regularisations.filter((r) => r.status === "PENDING");

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <ClockCard today={today} />

        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wide text-subtle">Next holiday</div>
            {nextHoliday ? (
              <>
                <div className="mt-1 font-medium text-text">{nextHoliday.name}</div>
                <div className="text-xs text-muted">{formatDate(nextHoliday.date)}</div>
              </>
            ) : (
              <div className="mt-1 text-sm text-subtle">Nothing on the calendar.</div>
            )}
            <Link href="/people/holidays" className="mt-2 inline-block text-xs text-brand hover:underline">
              Full calendar →
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wide text-subtle">Waiting on a decision</div>
            <div className="mt-1 text-lg font-semibold text-text">{pendingLeave.length + pendingRegs.length}</div>
            <div className="text-xs text-muted">
              {pendingLeave.length} leave, {pendingRegs.length} attendance correction
            </div>
          </CardContent>
        </Card>
      </div>

      {queue.length > 0 && (
        <Card className="border-warning/40">
          <CardHeader className="text-sm font-medium text-text">
            Attendance corrections waiting on you ({queue.length})
          </CardHeader>
          <CardContent className="space-y-2">
            {queue.map((r) => (
              <QueueRow key={r.id} request={r} />
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
            <span>Attendance corrections</span>
            <RegulariseDialog />
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-subtle">
              Forgot to punch, or the terminal missed you? Ask for the day to be corrected — your manager decides,
              exactly as they do for leave.
            </p>
            {regularisations.length === 0 && <p className="text-sm text-subtle">You haven&apos;t asked for any.</p>}
            {regularisations.map((r) => (
              <MyRegRow key={r.id} request={r} />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
            <span>Leave balance</span>
            <Link href="/people/leave" className="text-xs font-normal text-brand hover:underline">
              Apply
            </Link>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {balances.length === 0 && <p className="text-subtle">No leave types set up yet.</p>}
            {balances.map((b) => (
              <div key={b.typeId} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">{b.name}</span>
                <span className="text-text">
                  {b.paid ? (
                    <>
                      <span className="font-medium">{b.available}</span>
                      <span className="text-xs text-subtle"> left</span>
                    </>
                  ) : (
                    <span className="text-xs text-subtle">unpaid</span>
                  )}
                  {b.pending > 0 && <span className="ml-1 text-xs text-warning">· {b.pending} pending</span>}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden p-0">
        <CardHeader className="text-sm font-medium text-text">Your payslips</CardHeader>
        <table className="w-full text-sm">
          <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Month</th>
              <th className="px-3 py-2.5 text-right">Paid days</th>
              <th className="px-3 py-2.5 text-right">Gross</th>
              <th className="px-3 py-2.5 text-right">Deductions</th>
              <th className="px-3 py-2.5 text-right">Net</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {payslips.map((s) => (
              <tr key={s.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5 text-text">{monthLabel(s.run.month, s.run.year)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted">
                  {num(s.paidDays)}/{num(s.monthDays)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted">{formatCurrency(num(s.grossEarnings))}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted">
                  {formatCurrency(num(s.totalDeductions))}
                </td>
                <td className="px-3 py-2.5 text-right font-medium tabular-nums text-text">
                  {formatCurrency(num(s.netPay))}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Link
                    href={`/payslips/${s.id}/print`}
                    target="_blank"
                    className="text-xs text-brand hover:underline"
                  >
                    Download
                  </Link>
                </td>
              </tr>
            ))}
            {payslips.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-subtle">
                  Nothing yet. A payslip appears here once payroll locks the month.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ClockCard({ today }: { today: TodayRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const time = (v: Date | string | null) =>
    v ? new Date(v).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : null;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card>
      <CardContent className="py-3">
        <div className="text-xs uppercase tracking-wide text-subtle">Today</div>
        <div className="mt-1 text-sm text-text">
          {today?.checkInAt ? (
            <>
              In at <span className="font-medium">{time(today.checkInAt)}</span>
              {today.checkOutAt && (
                <>
                  , out at <span className="font-medium">{time(today.checkOutAt)}</span>
                </>
              )}
            </>
          ) : today?.status === "ON_LEAVE" || today?.status === "HALF_DAY" ? (
            <span className="text-muted">You&apos;re on approved leave.</span>
          ) : (
            <span className="text-muted">Not clocked in.</span>
          )}
        </div>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        <div className="mt-2">
          {!today?.checkInAt ? (
            <Button size="sm" disabled={pending} onClick={() => run(() => clockIn())}>
              <LogIn className="mr-1.5 h-3.5 w-3.5" />
              Clock in
            </Button>
          ) : !today.checkOutAt ? (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => clockOut())}>
              <LogOut className="mr-1.5 h-3.5 w-3.5" />
              Clock out
            </Button>
          ) : (
            <Badge tone="green">Done for the day</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RegulariseDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    date: "",
    requestedStatus: "PRESENT" as string,
    checkIn: "",
    checkOut: "",
    reason: "",
  });

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await requestRegularisation(form);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setForm({ date: "", requestedStatus: "PRESENT", checkIn: "", checkOut: "", reason: "" });
      router.refresh();
    });
  }

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <CalendarClock className="mr-1.5 h-3.5 w-3.5" />
        Ask for a correction
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Ask for an attendance correction">
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="regDate">Which day</Label>
              <Input
                id="regDate"
                type="date"
                value={form.date}
                onChange={set("date")}
                max={dateOnly(new Date()).toISOString().slice(0, 10)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="regStatus">Should have been</Label>
              <Select id="regStatus" value={form.requestedStatus} onChange={set("requestedStatus")}>
                {attendanceStatusValues
                  .filter((s) => s !== "ON_LEAVE")
                  .map((s) => (
                    <option key={s} value={s}>
                      {attendanceStatusLabels[s]}
                    </option>
                  ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="regIn">In at (optional)</Label>
              <Input id="regIn" type="time" value={form.checkIn} onChange={set("checkIn")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="regOut">Out at (optional)</Label>
              <Input id="regOut" type="time" value={form.checkOut} onChange={set("checkOut")} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="regReason">What happened</Label>
            <Textarea
              id="regReason"
              rows={3}
              value={form.reason}
              onChange={set("reason")}
              placeholder="Forgot to punch out, terminal was down, was at a customer site…"
            />
          </div>

          <p className="text-xs text-subtle">
            Nothing changes until your manager approves it. Leave is corrected by withdrawing the leave, not here.
          </p>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button disabled={pending || !form.date || form.reason.trim().length < 3} onClick={submit}>
              {pending ? "Sending…" : "Send request"}
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

function MyRegRow({ request }: { request: Reg }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line pb-2 last:border-0 last:pb-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={leaveStatusTone[request.status]}>{request.status}</Badge>
          <span className="text-text">{formatDate(request.date)}</span>
          <span className="text-xs text-muted">
            → {attendanceStatusLabels[request.requestedStatus]}
          </span>
        </div>
        <p className="mt-0.5 text-sm text-muted">{request.reason}</p>
        {request.decisionNote && (
          <p className="mt-0.5 text-xs text-subtle">
            {request.approver?.name}: {request.decisionNote}
          </p>
        )}
      </div>
      {request.status === "PENDING" && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await cancelRegularisation(request.id);
              router.refresh();
            })
          }
        >
          Withdraw
        </Button>
      )}
    </div>
  );
}

function QueueRow({ request }: { request: Queue[number] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function decide(approve: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await decideRegularisation({ id: request.id, approve, note });
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
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-text">{request.user.name}</span>
            <span className="text-muted">{formatDate(request.date)}</span>
            <Badge tone="default">{attendanceStatusLabels[request.requestedStatus]}</Badge>
          </div>
          <p className="mt-1 text-sm text-text">{request.reason}</p>
          {error && <p className="mt-1 text-sm text-danger">{error}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            // One per request on the page, so the name has to say which one.
            aria-label={`Note on the ${attendanceStatusLabels[request.requestedStatus].toLowerCase()} request`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note"
            className="h-8 w-32 text-xs"
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
