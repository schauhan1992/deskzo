"use client";

import { useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  AlarmClock,
  Check,
  ChevronLeft,
  ChevronRight,
  ClockArrowDown,
  ClockArrowUp,
  Coffee,
  Flag,
  Hourglass,
  House,
  LogIn,
  LogOut,
  Timer,
  Umbrella,
  X,
  type LucideIcon,
} from "lucide-react";
import type { attendanceMonth } from "@/actions/attendance";
import { clockIn, clockOut, markAttendance, saveOfficeHours } from "@/actions/attendance";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { useClock } from "@/components/time/clock-provider";
import { attendanceStatusLabels, attendanceStatusValues } from "@/lib/validation/hr";
import { personPath } from "@/lib/record-links";
import { MONTH_NAMES, monthLabel } from "@/lib/hr/calendar";
import { clockWordsOfMinute, timeOfMinute, type OfficeHours } from "@/lib/hr/office-hours-rules";

type Month = Awaited<ReturnType<typeof attendanceMonth>>;
type Cell = Month["rows"][number]["cells"][number];
/** Whatever `myToday` hands back — dates arrive as Date or string depending on serialisation. */
type TodayRow = { status: string; checkInAt: Date | string | null; checkOutAt: Date | string | null } | null;

/** What a day shows (owner, 16 Oct 2026): one mark for its status, small ones for its timing. */
type Mark = { icon: LucideIcon | null; text?: string; className: string; label: string };
const MARKS = {
  PRESENT: { icon: Check, className: "text-success", label: "Present" },
  WORK_FROM_HOME: { icon: House, className: "text-info", label: "Work from home" },
  HALF_DAY: { icon: null, text: "½", className: "text-warning", label: "Half day" },
  ON_LEAVE: { icon: Flag, className: "text-danger", label: "On leave" },
  ABSENT: { icon: X, className: "text-danger", label: "Absent" },
  HOLIDAY: { icon: Umbrella, className: "text-warning", label: "Holiday" },
  WEEK_OFF: { icon: Coffee, className: "text-subtle", label: "Week off" },
} satisfies Record<string, Mark>;
const TIMING = {
  pending: { icon: Hourglass, className: "text-subtle", label: "Correction pending" },
  late: { icon: AlarmClock, className: "text-danger", label: "Late" },
  early: { icon: ClockArrowDown, className: "text-warning", label: "Left early" },
  overtime: { icon: ClockArrowUp, className: "text-info", label: "Overtime" },
} as const;
/** A short leave on the day (owner, 18 Oct 2026): solid once approved, faint while it waits. */
const SHORT_LEAVE = { icon: Timer, approved: "text-brand", waiting: "text-subtle", label: "Short leave" } as const;
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** The day's main mark: its status, else its day off, else nothing (the future, or not recorded). */
function markOf(cell: Cell): Mark | null {
  if (cell.status) return MARKS[cell.status as keyof typeof MARKS] ?? null;
  if (cell.offDay === "holiday") return MARKS.HOLIDAY;
  if (cell.offDay === "week off") return MARKS.WEEK_OFF;
  return null;
}

function MarkIcon({ mark, size = "h-4 w-4" }: { mark: Mark; size?: string }) {
  if (mark.icon) {
    const Icon = mark.icon;
    return <Icon className={`${size} ${mark.className}`} strokeWidth={2.25} aria-hidden />;
  }
  return <span className={`text-sm font-semibold leading-none ${mark.className}`}>{mark.text}</span>;
}

export function AttendanceGrid({
  month,
  today,
  canMark,
  year,
  monthNumber,
  canSetHours = false,
}: {
  month: Month;
  today: TodayRow;
  canMark: boolean;
  year: number;
  monthNumber: number;
  canSetHours?: boolean;
}) {
  const clock = useClock();
  const [editing, setEditing] = useState<{ userId: string; name: string; date: string; cell: Cell } | null>(null);
  const hours = month.officeHours;
  const legend: { key: string; node: ReactNode; label: string }[] = [
    ...(["PRESENT", "ABSENT", "HALF_DAY", "ON_LEAVE", "HOLIDAY", "WEEK_OFF", "WORK_FROM_HOME"] as const).map((k) => ({
      key: k,
      node: <MarkIcon mark={MARKS[k]} size="h-3.5 w-3.5" />,
      label: MARKS[k].label,
    })),
    { key: "future", node: <span className="h-2.5 w-2.5 rounded-full border border-line-strong" />, label: "Future" },
    { key: "unrecorded", node: <span className="h-3.5 w-3.5 rounded border border-dashed border-line-strong" />, label: "Not recorded" },
    ...(["pending", ...(hours ? (["late", "early", "overtime"] as const) : [])] as const).map((k) => {
      const t = TIMING[k];
      const Icon = t.icon;
      return { key: k, node: <Icon className={`h-3.5 w-3.5 ${t.className}`} aria-hidden />, label: t.label };
    }),
    { key: "short", node: <SHORT_LEAVE.icon className={`h-3.5 w-3.5 ${SHORT_LEAVE.approved}`} aria-hidden />, label: SHORT_LEAVE.label },
  ];

  return (
    <div className="space-y-4">
      <ClockCard today={today} />

      <Card className="overflow-hidden p-0">
        <div className="space-y-3 border-b border-line px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-success">Attendance report: {monthLabel(monthNumber, year).toUpperCase()}</h2>
            <MonthControls year={year} month={monthNumber} />
          </div>
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
            {legend.map((l) => (
              <li key={l.key} className="flex items-center gap-1.5">
                {l.node}
                {l.label}
              </li>
            ))}
          </ul>
          <OfficeHoursLine hours={hours} canSet={canSetHours} />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-surface-sunken">
              <tr>
                <th className="sticky left-0 z-10 min-w-56 border-b border-r border-line bg-surface-sunken px-3 py-2 text-left text-xs font-medium text-muted">
                  Employee
                </th>
                {month.days.map((d) => (
                  <th key={d} className="min-w-11 border-b border-r border-line px-0.5 py-1.5 text-center font-normal">
                    <div className="text-sm font-semibold text-text">{Number(d.slice(8))}</div>
                    <div className="text-[10px] tracking-wide text-subtle">{WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]}</div>
                  </th>
                ))}
                <th className="min-w-28 border-b border-line px-3 py-2 text-right text-xs font-medium text-muted">Total</th>
              </tr>
            </thead>
            <tbody>
              {month.rows.map((row) => (
                <tr key={row.userId} className="group">
                  <td className="sticky left-0 z-10 border-b border-r border-line bg-surface px-3 py-2 group-hover:bg-surface-sunken">
                    <Link href={personPath(row.userSeq)} className="flex items-center gap-2.5">
                      <Avatar user={{ id: row.userId, name: row.name, photoUpdatedAt: row.photoUpdatedAt }} size="md" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-text hover:underline">{row.name}</span>
                        {row.designation && <span className="block truncate text-[11px] text-subtle">{row.designation}</span>}
                      </span>
                    </Link>
                  </td>
                  {row.cells.map((cell) => (
                    <td key={cell.date} className="border-b border-r border-line p-0 text-center group-hover:bg-surface-sunken/60">
                      <DayCell
                        cell={cell}
                        canMark={canMark}
                        time={(at) => clock.time(at)}
                        onOpen={() => canMark && setEditing({ userId: row.userId, name: row.name, date: cell.date, cell })}
                      />
                    </td>
                  ))}
                  <td className="whitespace-nowrap border-b border-line px-3 py-2 text-right" title={`${row.present} present · ${row.leave} on leave · ${row.absent} absent · ${row.unrecorded} not recorded`}>
                    {row.workedHours !== null && row.expectedHours !== null ? (
                      <>
                        <div className="font-semibold tabular-nums text-success">{row.workedHours.toFixed(1)}</div>
                        <div className="text-[11px] tabular-nums text-subtle">/{row.expectedHours.toFixed(1)} h</div>
                      </>
                    ) : (
                      <>
                        <div className="font-semibold tabular-nums text-success">{row.present}</div>
                        <div className="text-[11px] tabular-nums text-subtle">/{row.workingDays} days</div>
                      </>
                    )}
                    {row.unrecorded > 0 && <div className="text-[10px] text-warning">{row.unrecorded} not recorded</div>}
                  </td>
                </tr>
              ))}
              {month.rows.length === 0 && (
                <tr>
                  <td colSpan={month.days.length + 2} className="px-4 py-8 text-center text-subtle">
                    Nobody to show for this month.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {editing && <MarkDialog key={`${editing.userId}:${editing.date}`} editing={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** One person's day: its mark, the timing beside it, and a hover saying it in words. */
function DayCell({ cell, canMark, time, onOpen }: { cell: Cell; canMark: boolean; time: (at: string) => string; onOpen: () => void }) {
  const mark = markOf(cell);
  const timing = (["late", "early", "overtime"] as const).filter((k) => cell[k]);
  const words = [
    `${cell.date} — ${mark ? mark.label : cell.future ? "Still to come" : "Not recorded"}`,
    cell.checkInAt ? `in ${time(cell.checkInAt)}${cell.checkOutAt ? `, out ${time(cell.checkOutAt)}` : ""}` : null,
    ...timing.map((k) => TIMING[k].label.toLowerCase()),
    cell.pending ? "a correction is waiting" : null,
    cell.shortLeave
      ? `short leave ${cell.shortLeave.words}${cell.shortLeave.approved ? (cell.shortLeave.excused ? ", excused the mark" : "") : ", waiting for approval"}`
      : null,
    cell.note,
    cell.regularised ? "corrected" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      disabled={!canMark}
      onClick={onOpen}
      title={words}
      aria-label={words}
      className={`flex h-12 w-full flex-col items-center justify-center gap-0.5 ${canMark ? "hover:bg-brand-subtle/60" : "cursor-default"}`}
    >
      <span className="flex items-center gap-0.5">
        {mark ? (
          <MarkIcon mark={mark} />
        ) : cell.future ? (
          <span className="h-2.5 w-2.5 rounded-full border border-line-strong" />
        ) : (
          <span className="h-4 w-4 rounded border border-dashed border-line-strong" />
        )}
        {timing.map((k) => {
          const t = TIMING[k];
          const Icon = t.icon;
          return <Icon key={k} className={`h-3 w-3 ${t.className}`} aria-hidden />;
        })}
      </span>
      {(cell.pending || cell.shortLeave) && (
        <span className="flex items-center gap-0.5">
          {cell.pending && <Hourglass className="h-3 w-3 text-subtle" aria-hidden />}
          {cell.shortLeave && (
            <SHORT_LEAVE.icon className={`h-3 w-3 ${cell.shortLeave.approved ? SHORT_LEAVE.approved : SHORT_LEAVE.waiting}`} aria-hidden />
          )}
        </span>
      )}
    </button>
  );
}

/** The month and year to show, and a step either way — the page's other filters kept. */
function MonthControls({ year, month }: { year: number; month: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (m: number, y: number) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    next.set("month", String(m));
    next.set("year", String(y));
    router.push(`${pathname}?${next.toString()}`);
  };
  const step = (by: number) => {
    const index = year * 12 + (month - 1) + by;
    go((index % 12) + 1, Math.floor(index / 12));
  };
  const years = Array.from({ length: 6 }, (_, i) => year - 4 + i);

  return (
    <div className="flex items-center gap-2">
      <Select aria-label="Month" value={String(month)} onChange={(e) => go(Number(e.target.value), year)} className="w-36">
        {MONTH_NAMES.map((name, i) => (
          <option key={name} value={i + 1}>
            {name}
          </option>
        ))}
      </Select>
      <Select aria-label="Year" value={String(year)} onChange={(e) => go(month, Number(e.target.value))} className="w-28">
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </Select>
      <Button type="button" variant="secondary" size="sm" aria-label="Previous month" onClick={() => step(-1)}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Button type="button" variant="secondary" size="sm" aria-label="Next month" onClick={() => step(1)}>
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

/** The office hours the grid measures against, and — for whoever manages HR — the way to set them. */
function OfficeHoursLine({ hours, canSet }: { hours: OfficeHours | null; canSet: boolean }) {
  const [open, setOpen] = useState(false);
  if (!hours && !canSet) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      {hours ? (
        <span>
          Office hours {clockWordsOfMinute(hours.startMinute)} – {clockWordsOfMinute(hours.endMinute)}, {hours.graceMinutes} minutes&apos; grace.
          Late, left early and overtime are measured against them; the total is hours worked of hours expected.
        </span>
      ) : (
        <span>Set the office hours to mark late, left early and overtime, and to total hours worked.</span>
      )}
      {canSet && (
        <button type="button" onClick={() => setOpen(true)} className="font-medium text-brand hover:underline">
          {hours ? "Change" : "Set office hours"}
        </button>
      )}
      {open && <OfficeHoursDialog hours={hours} onClose={() => setOpen(false)} />}
    </div>
  );
}

function OfficeHoursDialog({ hours, onClose }: { hours: OfficeHours | null; onClose: () => void }) {
  const router = useRouter();
  const [start, setStart] = useState(hours ? timeOfMinute(hours.startMinute) : "09:30");
  const [end, setEnd] = useState(hours ? timeOfMinute(hours.endMinute) : "18:30");
  const [grace, setGrace] = useState(String(hours?.graceMinutes ?? 15));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = (clear: boolean) =>
    startTransition(async () => {
      setError(null);
      const result = await saveOfficeHours(clear ? null : { start, end, grace: Number(grace) });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });

  return (
    <Dialog open onClose={onClose} title="Office hours">
      <div className="space-y-4">
        <p className="text-sm text-muted">On the workspace&apos;s own clock. The grace is how late someone can be in, or early out, before it&apos;s marked.</p>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="office-start">Starts</Label>
            <Input id="office-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} disabled={pending} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="office-end">Ends</Label>
            <Input id="office-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} disabled={pending} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="office-grace">Grace (minutes)</Label>
            <Input id="office-grace" type="number" min={0} max={120} value={grace} onChange={(e) => setGrace(e.target.value)} disabled={pending} />
          </div>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={pending} onClick={() => save(false)}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          {hours && (
            <Button variant="ghost" className="ml-auto text-danger" onClick={() => save(true)} disabled={pending}>
              Clear office hours
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Today's clock, for the signed-in user. */
function ClockCard({ today }: { today: TodayRow }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

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

  // The workspace's time of day, not the browser's.
  const time = (value: Date | string | null) => (value ? clock.time(value) : null);

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="text-sm">
          {today?.checkInAt ? (
            <span className="text-text">
              In at <span className="font-medium">{time(today.checkInAt)}</span>
              {today.checkOutAt && (
                <>
                  , out at <span className="font-medium">{time(today.checkOutAt)}</span>
                </>
              )}
            </span>
          ) : today?.status === "ON_LEAVE" || today?.status === "HALF_DAY" ? (
            <span className="text-muted">You&apos;re on approved leave today.</span>
          ) : (
            <span className="text-muted">You haven&apos;t clocked in today.</span>
          )}
          {error && <span className="ml-2 text-danger">{error}</span>}
        </div>

        <div className="flex gap-2">
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

function MarkDialog({
  editing,
  onClose,
}: {
  editing: { userId: string; name: string; date: string; cell: Cell };
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState<string>(
    editing.cell.status ?? (editing.cell.offDay === "week off" ? "WEEK_OFF" : editing.cell.offDay ? "HOLIDAY" : "PRESENT"),
  );
  const [note, setNote] = useState(editing.cell.note ?? "");

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await markAttendance({ userId: editing.userId, date: editing.date, status, note });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onClose={onClose} title={`${editing.name} — ${editing.date}`}>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="attStatus">Status</Label>
          <Select id="attStatus" value={status} onChange={(e) => setStatus(e.target.value)}>
            {attendanceStatusValues.map((s) => (
              <option key={s} value={s}>
                {attendanceStatusLabels[s]}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="attNote">Note</Label>
          <Input id="attNote" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it was corrected" />
        </div>

        <p className="text-xs text-subtle">
          Corrections are stamped with your name, so anyone asking later can see who changed it.
        </p>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button disabled={pending} onClick={submit}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
