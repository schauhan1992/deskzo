"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LogIn, LogOut } from "lucide-react";
import type { attendanceMonth } from "@/actions/attendance";
import { clockIn, clockOut, markAttendance } from "@/actions/attendance";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { attendanceStatusLabels, attendanceStatusValues } from "@/lib/validation/hr";

type Month = Awaited<ReturnType<typeof attendanceMonth>>;
type Cell = Month["rows"][number]["cells"][number];
/** Whatever `myToday` hands back — dates arrive as Date or string depending on serialisation. */
type TodayRow = { status: string; checkInAt: Date | string | null; checkOutAt: Date | string | null } | null;

/** One letter per status, because a month grid has about eleven pixels per day to work with. */
const MARK: Record<string, { letter: string; className: string; title: string }> = {
  PRESENT: { letter: "P", className: "bg-success-bg text-success", title: "Present" },
  WORK_FROM_HOME: { letter: "W", className: "bg-info-bg text-info", title: "Work from home" },
  HALF_DAY: { letter: "H", className: "bg-warning-bg text-warning", title: "Half day" },
  ON_LEAVE: { letter: "L", className: "bg-brand-subtle text-brand", title: "On leave" },
  ABSENT: { letter: "A", className: "bg-danger-bg text-danger", title: "Absent" },
  WEEK_OFF: { letter: "·", className: "text-subtle", title: "Week off" },
  HOLIDAY: { letter: "·", className: "text-subtle", title: "Holiday" },
};

export function AttendanceGrid({
  month,
  today,
  canMark,
}: {
  month: Month;
  today: TodayRow;
  canMark: boolean;
}) {
  const [editing, setEditing] = useState<{ userId: string; name: string; date: string; cell: Cell } | null>(null);

  return (
    <div className="space-y-4">
      <ClockCard today={today} />

      <Card className="overflow-hidden p-0">
        <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
          <span>The month, day by day</span>
          <span className="flex flex-wrap items-center gap-2 text-xs font-normal">
            {["PRESENT", "WORK_FROM_HOME", "HALF_DAY", "ON_LEAVE", "ABSENT"].map((s) => (
              <span key={s} className="flex items-center gap-1 text-subtle">
                <span className={`grid h-4 w-4 place-items-center rounded text-[10px] font-semibold ${MARK[s].className}`}>
                  {MARK[s].letter}
                </span>
                {MARK[s].title}
              </span>
            ))}
          </span>
        </CardHeader>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-y border-line bg-surface-sunken text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="sticky left-0 z-10 bg-surface-sunken px-3 py-2 text-left">Person</th>
                {month.days.map((d) => (
                  <th key={d} className="px-0.5 py-2 text-center font-normal">
                    {Number(d.slice(8))}
                  </th>
                ))}
                <th className="px-3 py-2 text-right">P</th>
                <th className="px-3 py-2 text-right">L</th>
                <th className="px-3 py-2 text-right">A</th>
                <th className="px-3 py-2 text-right" title="Working days with nothing recorded">
                  ?
                </th>
              </tr>
            </thead>
            <tbody>
              {month.rows.map((row) => (
                <tr key={row.userId} className="border-b border-line last:border-0">
                  <td className="sticky left-0 z-10 bg-surface px-3 py-1.5 whitespace-nowrap">
                    <Link href={`/people/${row.userId}`} className="text-text hover:underline">
                      {row.name}
                    </Link>
                    {row.designation && <div className="text-[11px] text-subtle">{row.designation}</div>}
                  </td>
                  {row.cells.map((cell) => {
                    const mark = cell.status ? MARK[cell.status] : null;
                    const label = cell.status
                      ? attendanceStatusLabels[cell.status]
                      : cell.offDay
                        ? cell.offDay
                        : "Not recorded";
                    return (
                      <td key={cell.date} className="px-0.5 py-1.5 text-center">
                        <button
                          type="button"
                          disabled={!canMark}
                          onClick={() =>
                            canMark && setEditing({ userId: row.userId, name: row.name, date: cell.date, cell })
                          }
                          title={`${cell.date} — ${label}${cell.note ? `: ${cell.note}` : ""}${cell.regularised ? " (corrected)" : ""}`}
                          className={`grid h-6 w-6 place-items-center rounded text-[10px] font-semibold transition-colors ${
                            mark ? mark.className : cell.offDay ? "text-subtle" : "border border-dashed border-line text-subtle"
                          } ${canMark ? "hover:ring-1 hover:ring-brand" : "cursor-default"}`}
                        >
                          {mark ? mark.letter : cell.offDay ? "·" : ""}
                        </button>
                      </td>
                    );
                  })}
                  <td className="px-3 py-1.5 text-right tabular-nums text-text">{row.present}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted">{row.leave || "—"}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-danger">{row.absent || "—"}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-subtle">{row.unrecorded || "—"}</td>
                </tr>
              ))}
              {month.rows.length === 0 && (
                <tr>
                  <td colSpan={month.days.length + 5} className="px-4 py-8 text-center text-subtle">
                    Nobody to show for this month.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {editing && (
        <MarkDialog
          key={`${editing.userId}:${editing.date}`}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
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
