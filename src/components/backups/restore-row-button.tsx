"use client";

import { useState } from "react";
import { AlertTriangle, History, Loader2 } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { CONFIRM_PHRASE } from "@/lib/backup/archive-format";
import { formatBytes } from "@/lib/backup/policy";
import { useClock } from "@/components/time/clock-provider";

/**
 * Puts one of this server's own backups back, from the row it is listed on.
 *
 * The common restore is not a disaster — it is "undo this afternoon", and the file is already here.
 * Sending somebody through download-then-upload for that would add a passphrase, a round trip and
 * two copies of the database to an operation whose whole point is that nothing has gone anywhere.
 *
 * What it does not skip is the deciding. The dialog says what will be lost before it will accept
 * anything, and the confirmation is typed rather than ticked, exactly as the upload path is.
 */

type Staged = {
  id: string;
  archive: { takenAt: string; schemaVersion: string | null; dumpBytes: number; sameInstance: boolean | null };
  database: { schemaVersion: string | null; sameSchema: boolean | null };
  source: string;
};

export function RestoreRowButton({
  backup,
}: {
  backup: { id: string; filename: string; sizeBytes: number | null; startedAt: Date | string };
}) {
  const clock = useClock();
  const [open, setOpen] = useState(false);
  const [staging, setStaging] = useState(false);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  async function begin() {
    setOpen(true);
    setError(null);
    setStaged(null);
    setConfirm("");
    setStaging(true);
    try {
      const res = await fetch(`/api/backups/${backup.id}/stage`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "That backup could not be prepared.");
      setStaged(data as Staged);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStaging(false);
    }
  }

  async function start() {
    if (!staged) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/backups/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // No passphrase: the file never left the server, so it was never sealed.
        body: JSON.stringify({ id: staged.id, confirm }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "The restore could not be started.");
      // From here the proxy holds everything at a maintenance page, which polls its own status and
      // reloads when the database is back. Nothing left for this dialog to do.
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  }

  return (
    <>
      {/* `tone="danger"` is the only colour in the icon set, and this is what it is for: the one
          action on this screen that cannot be undone. */}
      <IconButton
        icon={History}
        label={`Restore from ${backup.filename} — replaces the entire database`}
        tone="danger"
        onClick={begin}
      />

      <Dialog open={open} onClose={() => !starting && setOpen(false)} title="Restore from this backup">
        <div className="space-y-4">
          <div className="rounded-base border border-line bg-surface-sunken px-3 py-2">
            <p className="font-mono text-xs break-all text-text">{backup.filename}</p>
            <p className="mt-0.5 text-xs text-muted">
              {clock.dateTimeShort(backup.startedAt)} · {formatBytes(backup.sizeBytes)}
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-xs text-danger">
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">This replaces the entire database.</p>
              <p className="mt-0.5">
                Everything recorded since this backup was taken is discarded — orders, invoices, payments, tickets, and
                the log of who discarded them. The application goes offline while it runs. There is no undo.
              </p>
            </div>
          </div>

          {staging && (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              Preparing the file…
            </p>
          )}

          {error && <p className="text-sm text-danger">{error}</p>}

          {staged && (
            <>
              {staged.database.sameSchema === false && (
                <p className="flex items-start gap-1.5 rounded-base border border-warning/40 bg-warning-bg px-2.5 py-1.5 text-xs text-warning">
                  <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    This backup is from migration {staged.archive.schemaVersion ?? "unknown"} and the database is on{" "}
                    {staged.database.schemaVersion ?? "unknown"}. Restoring replaces the schema with the older one — run
                    the migrations again afterwards.
                  </span>
                </p>
              )}

              <div>
                <label htmlFor={`rr-${backup.id}`} className="text-xs font-medium text-text">
                  Type {CONFIRM_PHRASE}
                </label>
                <Input
                  id={`rr-${backup.id}`}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="mt-1 font-mono"
                  autoComplete="off"
                />
              </div>
            </>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={starting}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={start}
              disabled={!staged || starting || confirm.trim() !== CONFIRM_PHRASE}
            >
              {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <History className="h-3.5 w-3.5" />}
              {starting ? "Starting…" : "Replace the database"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
