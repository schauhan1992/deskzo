"use client";

import { useState, useTransition } from "react";
import { CalendarClock, ChevronDown, Info } from "lucide-react";
import { saveBackupSchedule } from "@/actions/backup";
import type { StoredSchedule } from "@/lib/backup/scheduled";
import { formatTimeOfDay } from "@/lib/backup/schedule";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { formatDateTime } from "@/lib/utils";

/**
 * The schedule, and the honest paragraph about what still has to be set up outside the app.
 *
 * That paragraph is not an apology. A time picker that silently does nothing because nobody ever
 * installed a scheduled task is worse than no time picker at all — it turns "we have no backups"
 * into "we thought we had backups", and the second one is only discovered on the day it matters.
 */

export function BackupScheduleForm({
  schedule,
  nextRunAt,
  verdict,
}: {
  schedule: StoredSchedule;
  nextRunAt: Date | null;
  verdict: string;
}) {
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [time, setTime] = useState(formatTimeOfDay(schedule.hour, schedule.minute));
  const [keepDays, setKeepDays] = useState(String(schedule.keepDays));
  const [keepMinimum, setKeepMinimum] = useState(String(schedule.keepMinimum));
  const [showSetup, setShowSetup] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  const dirty =
    enabled !== schedule.enabled ||
    time !== formatTimeOfDay(schedule.hour, schedule.minute) ||
    keepDays !== String(schedule.keepDays) ||
    keepMinimum !== String(schedule.keepMinimum);

  const save = () => {
    setSaving(true);
    setNotice(null);
    startTransition(async () => {
      const result = await saveBackupSchedule({
        enabled,
        time,
        keepDays: Number(keepDays),
        keepMinimum: Number(keepMinimum),
      });
      setSaving(false);
      setNotice(result.ok ? { text: "Schedule saved." } : { text: result.error, bad: true });
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-text">
            <CalendarClock className="h-4 w-4 text-muted" />
            Automatic daily backup
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {schedule.enabled
              ? nextRunAt
                ? `Next: ${formatDateTime(nextRunAt)}`
                : "On"
              : "Off — every backup is somebody remembering."}
          </div>
        </div>
        <Button onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save schedule"}
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {notice && (
          <div
            className={
              notice.bad
                ? "rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger"
                : "rounded-base border border-success/40 bg-success-bg px-3 py-2 text-sm text-success"
            }
          >
            {notice.text}
          </div>
        )}

        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            <span className="block text-sm font-medium text-text">Back up automatically, once a day</span>
            <span className="block text-sm text-muted">
              If the machine is off or the run fails at the chosen time, the next one after it comes back takes the
              backup rather than skipping the day.
            </span>
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="backup-time">Time of day</Label>
            <Input
              id="backup-time"
              type="time"
              value={time}
              disabled={!enabled}
              onChange={(e) => setTime(e.target.value)}
            />
            <p className="text-xs text-muted">
              The server&rsquo;s clock. Pick an hour when nobody is working — a dump holds a transaction open.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="backup-keep-days">Keep for</Label>
            <div className="flex items-center gap-2">
              <Input
                id="backup-keep-days"
                type="number"
                min={1}
                max={3650}
                value={keepDays}
                onChange={(e) => setKeepDays(e.target.value)}
              />
              <span className="text-sm text-muted">days</span>
            </div>
            <p className="text-xs text-muted">Older files are deleted after each successful run.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="backup-keep-min">Always keep</Label>
            <div className="flex items-center gap-2">
              <Input
                id="backup-keep-min"
                type="number"
                min={1}
                max={365}
                value={keepMinimum}
                onChange={(e) => setKeepMinimum(e.target.value)}
              />
              <span className="text-sm text-muted">files</span>
            </div>
            <p className="text-xs text-muted">
              However old they are. Stops a broken schedule from ending with an empty folder.
            </p>
          </div>
        </div>

        {/*
          The state worth catching is "switched on, and quietly not running". So the page asks the
          scheduler's own function what it would answer right now, and prints it.
        */}
        {schedule.enabled && (
          <p className="rounded-base bg-surface-sunken px-3 py-2 text-xs text-muted">
            <span className="font-medium text-text">Right now:</span> {verdict}
            {schedule.updatedAt && (
              <>
                {" · "}Schedule last changed {formatDateTime(schedule.updatedAt)}
                {schedule.updatedByName ? ` by ${schedule.updatedByName}` : ""}
              </>
            )}
          </p>
        )}

        <div className="rounded-base border border-line bg-surface-sunken">
          <button
            type="button"
            onClick={() => setShowSetup((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-text"
          >
            <Info className="h-4 w-4 shrink-0 text-muted" />
            One thing has to be set up on the server for this to fire
            <ChevronDown
              className={`ml-auto h-4 w-4 shrink-0 text-muted transition-transform ${showSetup ? "rotate-180" : ""}`}
            />
          </button>

          {showSetup && (
            <div className="space-y-3 border-t border-line px-3 py-3 text-sm text-muted">
              <p>
                Nothing inside a web app can wake itself at {formatTimeOfDay(schedule.hour, schedule.minute)}. Something
                outside has to knock. The knock is deliberately dumb — <em>every 10 minutes, forever</em> — and the
                time above decides which knock actually takes a backup. Set it up once and you never touch it again,
                including when you change the time here.
              </p>
              <div>
                <div className="mb-1 font-medium text-text">Windows — run once in an admin PowerShell</div>
                <pre className="overflow-x-auto rounded-base border border-line bg-surface p-2 font-mono text-[11px] leading-relaxed text-text">
{`$action  = New-ScheduledTaskAction -Execute "npm.cmd" \`
  -Argument "run db:backup -- --if-due" \`
  -WorkingDirectory "C:\\path\\to\\deskzo"
$trigger = New-ScheduledTaskTrigger -Once -At 00:00 \`
  -RepetitionInterval (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName "Deskzo One backup" \`
  -Action $action -Trigger $trigger -RunLevel Highest`}
                </pre>
              </div>
              <div>
                <div className="mb-1 font-medium text-text">Linux — crontab</div>
                <pre className="overflow-x-auto rounded-base border border-line bg-surface p-2 font-mono text-[11px] leading-relaxed text-text">
{`*/10 * * * * cd /srv/deskzo && npm run db:backup -- --if-due`}
                </pre>
              </div>
              <p>
                It needs only the database to be up, not the app — which matters, because the app being down is one of
                the times you would most like the backups to have carried on. If your host can only fetch a URL, there
                is <code className="font-mono text-xs">/api/backup/tick</code> instead, behind{" "}
                <code className="font-mono text-xs">BACKUP_TICK_SECRET</code>.
              </p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
