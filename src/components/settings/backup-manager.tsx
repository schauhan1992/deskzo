"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, DatabaseBackup, HardDrive, Info, Layers, XCircle } from "lucide-react";
import type { BackupKind } from "@prisma/client";
import { takeBackupNow, type BackupOverview } from "@/actions/backup";
import { formatBytes } from "@/lib/backup/policy";
import { RUNNING_PRESUMED_DEAD_MINUTES } from "@/lib/backup/schedule";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BackupScheduleForm } from "@/components/settings/backup-schedule-form";
import { DownloadDialog } from "@/components/backups/download-dialog";
import { RestoreRowButton } from "@/components/backups/restore-row-button";
import { RowActions } from "@/components/ui/icon-button";
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

/**
 * What a run that has just finished gets to say about itself.
 *
 * Two numbers whenever they differ, because that difference *is* the incremental. Either figure
 * alone misleads: the snapshot size on its own claims the run cost forty times what it did, and the
 * bytes written on their own read as a backup that captured almost nothing.
 */
function outcome(run: { filename: string; sizeBytes: number; storedBytes: number }): string {
  if (run.storedBytes === run.sizeBytes) return `${run.filename} — ${formatBytes(run.sizeBytes)}.`;
  return `${run.filename} — ${formatBytes(run.storedBytes)} written, of a ${formatBytes(run.sizeBytes)} snapshot.`;
}

/**
 * What this run actually cost, which is the only figure comparable across both kinds.
 *
 * The snapshot size is not. A FULL dump is compressed and a chunked one cannot be — compression
 * leaves consecutive dumps with no chunks in common, so an "incremental" would store the whole
 * database every time. Measured here: the same data on the same afternoon reports 1.62 MB as a FULL
 * and 6.57 MB as a chunked snapshot. A column showing those two beside each other says the run that
 * wrote 299 KB is four times bigger than the run that wrote 1.62 MB.
 *
 * So the column is "On disk", and it is the number somebody is actually deciding with.
 */
function onDisk(row: { sizeBytes: number | null; storedBytes: number | null }): number | null {
  return row.storedBytes ?? row.sizeBytes;
}

/**
 * The snapshot size, as a second line, and only where it says something the first does not.
 *
 * For a FULL backup the two are the same number and repeating it is noise. For a chunked one the
 * gap between them is the entire point of the feature, so it is worth a line: 299 KB written, of a
 * 6.57 MB database.
 */
function snapshotNote(row: { sizeBytes: number | null; storedBytes: number | null }): string {
  if (row.sizeBytes === null || row.storedBytes === null) return "";
  if (row.storedBytes === row.sizeBytes) return "";
  return `of a ${formatBytes(row.sizeBytes)} snapshot`;
}

export function BackupManager({
  overview,
  canDownload,
  canRestore,
}: {
  overview: BackupOverview;
  /**
   * Whether to offer the file, rather than whether to show the row.
   *
   * The log is visible to anybody who may take a backup; carrying one off the server is a separate
   * permission and a much larger act. The column simply is not there without it — an offer that
   * fails on click teaches somebody there is something here worth asking for.
   */
  canDownload: boolean;
  /** Whether to offer putting one back. A separate, larger permission again — see the registry. */
  canRestore: boolean;
}) {
  const [, startTransition] = useTransition();
  /**
   * Which kind is running, not merely that one is.
   *
   * Both buttons have to go dead while a dump runs — two pg_dumps at once is one machine doing
   * twice the work for one backup — but two dead buttons that both say "Backing up…" leave somebody
   * waiting on the one they did not press.
   */
  const [busy, setBusy] = useState<BackupKind | null>(null);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);

  const run = (kind: BackupKind) => {
    setBusy(kind);
    setNotice(null);
    startTransition(async () => {
      const result = await takeBackupNow(kind);
      setBusy(null);
      setNotice(result.ok ? { text: outcome(result.data) } : { text: result.error, bad: true });
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
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-text">Take one now</div>
            <div className="mt-0.5 text-xs text-muted">
              A complete copy of the database — every order, invoice, document and stored password.
            </div>
            {/*
              Both buttons take a whole snapshot and both restore on their own, so nothing in the
              labels separates them. What separates them is what a *copy* of one is worth, and that
              is not a thing to find out afterwards: the way this goes wrong is somebody carrying an
              incremental offsite and discovering at the worst moment that they carried a name.
              Two lines before the click, rather than a paragraph nobody reads after it.
            */}
            <dl className="mt-2 max-w-prose space-y-1 text-xs text-muted">
              <div className="flex gap-1.5">
                <dt className="shrink-0 font-medium text-text">Full —</dt>
                <dd>
                  one standalone file. It needs nothing else to restore, which is what makes it the one to copy off
                  the machine.
                </dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="shrink-0 font-medium text-text">Incremental —</dt>
                <dd>
                  the same complete snapshot, stored as pieces shared with the other incremental backups, so it
                  writes only what changed. It restores on its own, but out of this folder: a copy of the backup
                  alone restores nothing.
                </dd>
              </div>
            </dl>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button onClick={() => run("FULL")} disabled={busy !== null}>
              <DatabaseBackup className="h-4 w-4" />
              {busy === "FULL" ? "Backing up…" : "Full backup"}
            </Button>
            <Button variant="secondary" onClick={() => run("INCREMENTAL")} disabled={busy !== null}>
              <Layers className="h-4 w-4" />
              {busy === "INCREMENTAL" ? "Backing up…" : "Incremental"}
            </Button>
          </div>
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
            {/*
              Hidden until there is a store to talk about. A machine that has only ever taken full
              backups has no chunk directory at all, and "0 B in 0 pieces" sends somebody looking for
              a folder that was never created.

              One total, and not a share of it per row, because the pieces belong to no single
              backup: deleting one incremental frees only what no surviving manifest still names,
              which is usually very little and occasionally nothing.
            */}
            {overview.store.chunks > 0 && (
              <div className="flex gap-2">
                <dt className="shrink-0 text-muted">Shared store</dt>
                <dd className="text-text">
                  {formatBytes(overview.store.bytes)} in {overview.store.chunks} pieces, behind every incremental
                </dd>
              </div>
            )}
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
              <span className="font-medium text-text">Keep a copy somewhere this machine cannot reach.</span> A backup
              that exists only on the server it came from does not survive the thing most likely to destroy the server.
              Downloading seals the dump into one encrypted file under a passphrase you choose — lose the passphrase and
              the file is gone, so store it somewhere separate from the backup itself. An incremental has no file of
              its own to carry: its pieces sit in the shared store among every other incremental&apos;s, so copying one
              backup off this machine means a full one, or the whole folder.
            </p>
            <p>
              <span className="font-medium text-text">Restoring replaces everything.</span> The application goes offline
              while it runs, every record made since the backup was taken is discarded, and there is no undo. Restoring
              a backup taken under a different{" "}
              <code className="font-mono text-xs">AUTH_SECRET</code> leaves the vault, two-factor secrets and stored
              credentials intact but unreadable — the screen says so before it lets you start.{" "}
              <code className="font-mono text-xs">npm run db:restore -- &lt;file&gt;</code> does the same job from a
              terminal, with the app stopped.
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
                    <th className="px-5 py-2 font-medium">On disk</th>
                    <th className="px-5 py-2 font-medium">Took</th>
                    <th className="px-5 py-2 font-medium">By</th>
                    <th className="px-5 py-2 font-medium">Status</th>
                    {(canDownload || canRestore) && <th className="px-5 py-2 font-medium sr-only">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b border-line last:border-0 align-top">
                      <td className="whitespace-nowrap px-5 py-2.5 text-text">{formatDateTime(row.startedAt)}</td>
                      {/*
                        Which kind, and what it cost, both fold in here. Neither earns a column of
                        its own: this table already scrolls sideways on a laptop and somebody has
                        said so, and the cell was already a name stacked over a line of facts about
                        it — which is exactly what these two are.
                      */}
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs text-text">{row.filename}</span>
                          <Badge tone={row.kind === "INCREMENTAL" ? "blue" : "default"}>
                            {row.kind === "INCREMENTAL" ? "Incremental" : "Full"}
                          </Badge>
                        </div>
                        <div className="mt-0.5 text-xs text-muted">
                          {/* What this run cost used to be appended here too. It reads better in the
                              On disk column beside the figure it qualifies, and saying it twice on
                              a row made the widest table on the page wider still. */}
                          {row.schemaVersion ? `schema ${row.schemaVersion}` : "schema unknown"}
                          {row.via ? ` · ${row.via}` : ""}
                        </div>
                        {row.error && <div className="mt-1 max-w-lg text-xs text-danger">{row.error}</div>}
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5">
                        <div className="text-text">{formatBytes(onDisk(row))}</div>
                        {snapshotNote(row) && <div className="mt-0.5 text-xs text-muted">{snapshotNote(row)}</div>}
                      </td>
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

                              An incremental has no file to be missing, so it is told what it lost:
                              its index in the store. Saying "file not in the folder" about a backup
                              that never had one sends somebody hunting the folder for a name that
                              was never written there.
                            */}
                            {!row.present && (
                              <span className="inline-flex items-center gap-1 text-xs text-warning">
                                <HardDrive className="h-3 w-3" />
                                {row.kind === "INCREMENTAL" ? "no longer in the store" : "file not in the folder"}
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
                      {(canDownload || canRestore) && (
                        <td className="whitespace-nowrap px-3 py-2.5 text-right">
                          {/* Only a finished run whose file is still there. A failed or interrupted
                              row has nothing to hand over, and a row whose dump has been pruned or
                              moved would offer actions that 410. */}
                          {row.status === "SUCCEEDED" && row.present && (
                            <RowActions>
                              {canDownload && (
                                <DownloadDialog
                                  backup={{ id: row.id, filename: row.filename, sizeBytes: row.sizeBytes }}
                                />
                              )}
                              {canRestore && (
                                <RestoreRowButton
                                  backup={{
                                    id: row.id,
                                    filename: row.filename,
                                    sizeBytes: row.sizeBytes,
                                    startedAt: row.startedAt,
                                  }}
                                />
                              )}
                            </RowActions>
                          )}
                        </td>
                      )}
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
