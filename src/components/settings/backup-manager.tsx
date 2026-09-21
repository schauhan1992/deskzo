"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, DatabaseBackup, HardDrive, Info, XCircle } from "lucide-react";
import { takeBackupNow, type BackupOverview } from "@/actions/backup";
import { formatBytes } from "@/lib/backup/policy";
import { RUNNING_PRESUMED_DEAD_MINUTES } from "@/lib/backup/schedule";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BackupScheduleForm } from "@/components/settings/backup-schedule-form";
import { formatDateTime } from "@/lib/utils";

/**
 * The backup screen.
 *
 * It shows failures as prominently as successes on purpose. The characteristic way backups fail is
 * not loudly — it is a scheduled job that has been exiting non-zero since March while a page that
 * only lists successes goes on showing a reassuring row from February.
 */

/**
 * A run still marked RUNNING long after any dump could still be going.
 *
 * Worth distinguishing, because "Running" on a row from last Tuesday is the page telling a small
 * lie. The commonest cause is not a crash: a dump contains its own row, written before it started,
 * so restoring one leaves that backup permanently mid-run. The next scheduled knock reconciles it
 * against the file on disk; until then this says what is actually known.
 */
function interrupted(startedAt: Date | string): boolean {
  return Date.now() - new Date(startedAt).getTime() > RUNNING_PRESUMED_DEAD_MINUTES * 60000;
}

function duration(startedAt: Date | string, finishedAt: Date | string | null): string {
  if (!finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return "under a second";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function BackupManager({ overview }: { overview: BackupOverview }) {
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);

  const run = () => {
    setBusy(true);
    setNotice(null);
    startTransition(async () => {
      const result = await takeBackupNow();
      setBusy(false);
      setNotice(
        result.ok
          ? { text: `${result.data.filename} — ${formatBytes(result.data.sizeBytes)}.` }
          : { text: result.error, bad: true },
      );
    });
  };

  const { rows, staleness } = overview;

  return (
    <div className="space-y-4">
      {staleness.stale && (
        <Card className="border-warning/40 bg-warning-bg">
          <CardContent className="flex items-start gap-2 py-3 text-sm text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="font-medium">{staleness.message}</span>{" "}
              {overview.schedule.enabled
                ? "Take one now, and check that the scheduled task on the server is still knocking."
                : "Nothing is scheduled, so this will not fix itself. Switch on the daily backup below."}
            </span>
          </CardContent>
        </Card>
      )}

      {!overview.tool && (
        <Card className="border-danger/40 bg-danger-bg">
          <CardContent className="flex items-start gap-2 py-3 text-sm text-danger">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="font-medium">pg_dump cannot be found on this machine.</span> Backups will fail until the
              Postgres client tools are installed, <code className="font-mono">PG_DUMP_PATH</code> is set, or the
              database container is reachable. Worth fixing before it is needed rather than after.
            </span>
          </CardContent>
        </Card>
      )}

      <BackupScheduleForm
        schedule={overview.schedule}
        nextRunAt={overview.nextRunAt}
        verdict={overview.scheduleVerdict}
      />

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-text">Take one now</div>
            <div className="mt-0.5 text-xs text-muted">
              A complete copy of the database — every order, invoice, document and stored password.
            </div>
          </div>
          <Button onClick={run} disabled={busy}>
            <DatabaseBackup className="h-4 w-4" />
            {busy ? "Backing up…" : "Back up now"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {notice && (
            <div
              className={
                notice.bad
                  ? "rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger"
                  : "rounded-base border border-success/40 bg-success-bg px-3 py-2 text-sm text-success"
              }
            >
              {notice.bad ? "Backup failed. " : "Backup taken: "}
              {notice.text}
            </div>
          )}

          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="shrink-0 text-muted">Folder</dt>
              <dd className="truncate font-mono text-xs text-text" title={overview.directory}>
                {overview.directory}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-muted">Runs via</dt>
              <dd className="text-text">{overview.tool ?? "not available"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-muted">Kept for</dt>
              <dd className="text-text">
                {overview.schedule.keepDays} days, and never fewer than {overview.schedule.keepMinimum}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-muted">Last good</dt>
              <dd className="text-text">
                {overview.lastSucceededAt ? formatDateTime(overview.lastSucceededAt) : "never"}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card className="bg-surface-sunken">
        <CardContent className="flex items-start gap-2 py-3 text-sm text-muted">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1.5">
            <p>
              <span className="font-medium text-text">These files stay on the server.</span> There is no download
              button, because one dump is the entire system — every password hash and every encrypted secret — and that
              is not something to put on the end of a link. Copy them off the machine yourself, and keep a copy
              somewhere the machine cannot reach. A backup that only exists on the server it came from does not survive
              the thing most likely to destroy the server.
            </p>
            <p>
              <span className="font-medium text-text">Restoring is a terminal job</span>, not a button:{" "}
              <code className="font-mono text-xs">npm run db:restore -- &lt;file&gt;</code>. It drops the schema the app
              is reading from, so it runs with the app stopped. It also refuses a dump taken under a different{" "}
              <code className="font-mono text-xs">AUTH_SECRET</code>, which would otherwise restore the vault
              successfully and unreadably.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Recent runs</CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted">No backup has been taken yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="px-5 py-2 font-medium">Taken</th>
                    <th className="px-5 py-2 font-medium">File</th>
                    <th className="px-5 py-2 font-medium">Size</th>
                    <th className="px-5 py-2 font-medium">Took</th>
                    <th className="px-5 py-2 font-medium">By</th>
                    <th className="px-5 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b border-line last:border-0 align-top">
                      <td className="whitespace-nowrap px-5 py-2.5 text-text">{formatDateTime(row.startedAt)}</td>
                      <td className="px-5 py-2.5">
                        <div className="font-mono text-xs text-text">{row.filename}</div>
                        <div className="mt-0.5 text-xs text-muted">
                          {row.schemaVersion ? `schema ${row.schemaVersion}` : "schema unknown"}
                          {row.via ? ` · ${row.via}` : ""}
                        </div>
                        {row.error && <div className="mt-1 max-w-lg text-xs text-danger">{row.error}</div>}
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-text">{formatBytes(row.sizeBytes)}</td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-muted">
                        {duration(row.startedAt, row.finishedAt)}
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-muted">
                        {row.triggeredByName ?? "scheduled"}
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5">
                        {row.status === "SUCCEEDED" && (
                          <div className="flex flex-col items-start gap-1">
                            <Badge tone="green">
                              <CheckCircle2 className="h-3 w-3" />
                              Succeeded
                            </Badge>
                            {/*
                              A row whose file is gone is worth saying out loud. It is the difference
                              between "we have eleven backups" and "we have a list of eleven backups".
                            */}
                            {!row.present && (
                              <span className="inline-flex items-center gap-1 text-xs text-warning">
                                <HardDrive className="h-3 w-3" />
                                file not in the folder
                              </span>
                            )}
                          </div>
                        )}
                        {row.status === "FAILED" && (
                          <Badge tone="red">
                            <XCircle className="h-3 w-3" />
                            Failed
                          </Badge>
                        )}
                        {row.status === "RUNNING" &&
                          (interrupted(row.startedAt) ? (
                            <div className="flex flex-col items-start gap-1">
                              <Badge tone="amber">
                                <AlertTriangle className="h-3 w-3" />
                                Interrupted
                              </Badge>
                              <span className="text-xs text-muted">never finished</span>
                            </div>
                          ) : (
                            <Badge tone="amber">
                              <CircleDashed className="h-3 w-3" />
                              Running
                            </Badge>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
