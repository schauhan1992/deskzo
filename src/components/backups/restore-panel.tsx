"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, Upload, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ARCHIVE_EXTENSION, CONFIRM_PHRASE } from "@/lib/backup/archive-format";
import { formatBytes } from "@/lib/backup/policy";
import { formatDateTime } from "@/lib/utils";

/**
 * Upload a backup, look at what it is, then replace everything with it.
 *
 * Four steps, and the order is the safety. The file is uploaded and *described* before a passphrase
 * is asked for, because the first question is "is this the right file" and answering it should not
 * require the answer to the second. The passphrase is then proved against the archive before the
 * confirmation is accepted, so the last thing anybody types is the one that cannot be taken back.
 *
 * Once the restore starts, this screen stops being the source of truth: the proxy holds the whole
 * application at a maintenance page, and progress comes from a status file rather than the
 * database, which by then is being dropped and rebuilt.
 */

type Preflight = {
  id: string;
  uploadedBytes: number;
  archive: {
    takenAt: string;
    schemaVersion: string | null;
    dumpBytes: number;
    via: string | null;
    app: string;
    carriesSecret: boolean;
    sameInstance: boolean | null;
  };
  database: { schemaVersion: string | null; sameSchema: boolean | null };
};

type Status = {
  running: boolean;
  status: {
    phase: string;
    message: string;
    error: string | null;
    finishedAt: string | null;
    secretHandoffPath: string | null;
  } | null;
};

export function RestorePanel() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Polled while a restore is live, and once on mount.
   *
   * On mount matters: a restore started in another tab, or before a reload, has to be visible here
   * rather than presenting a fresh upload form over the top of a database being replaced.
   */
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const res = await fetch("/api/backups/restore/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as Status;
        if (!alive) return;
        setStatus(data);
        if (data.running) timer = setTimeout(poll, 2000);
      } catch {
        // A failed poll during a restore is expected — the app is mid-replacement. Try again.
        if (alive) timer = setTimeout(poll, 3000);
      }
    };

    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [starting]);

  async function upload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    setPreflight(null);
    try {
      // The File is the body. The browser streams it, so a database-sized upload never sits in
      // memory on either side.
      const res = await fetch("/api/backups/upload", {
        method: "POST",
        body: file,
        headers: { "content-type": "application/octet-stream" },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "The upload failed.");
      setPreflight(data as Preflight);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function start() {
    if (!preflight) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/backups/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: preflight.id, passphrase, confirm }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "The restore could not be started.");
      setPassphrase("");
      setConfirm("");
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  }

  // ── A restore is running, or just finished ─────────────────────────────────────────────────
  const live = status?.running === true;
  const last = status?.status;

  if (live) {
    return (
      <Card className="border-warning/40 bg-warning-bg">
        <CardContent className="flex items-start gap-3 py-4">
          <Loader2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-warning" />
          <div>
            <p className="text-sm font-medium text-warning">Restoring — the application is unavailable</p>
            <p aria-live="polite" className="mt-0.5 text-sm text-warning">
              {last?.message ?? "Working…"}
            </p>
            <p className="mt-1 text-xs text-warning/80">
              This page will come back on its own when the database has been rebuilt. Closing the tab does not stop it.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {last && last.finishedAt && (
        <Card className={last.phase === "done" ? "border-success/40 bg-success-bg" : "border-danger/40 bg-danger-bg"}>
          <CardContent className="flex items-start gap-2 py-3">
            {last.phase === "done" ? (
              <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            ) : (
              <XCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            )}
            <div className={`text-sm ${last.phase === "done" ? "text-success" : "text-danger"}`}>
              <p className="font-medium">
                {last.phase === "done" ? "Last restore finished" : "Last restore failed"} —{" "}
                {formatDateTime(new Date(last.finishedAt))}
              </p>
              <p className="mt-0.5 whitespace-pre-line">{last.error ?? last.message}</p>
              {last.secretHandoffPath && (
                <p className="mt-1 flex items-start gap-1.5">
                  <KeyRound aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    That backup was taken under a different <code>AUTH_SECRET</code>. It has been written to{" "}
                    <code className="font-mono text-xs">{last.secretHandoffPath}</code> on the server. Set it in the
                    environment and restart, then delete the file — until then the vault, two-factor secrets and stored
                    credentials stay unreadable.
                  </span>
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-danger/40">
        <CardHeader className="flex items-center gap-2 text-sm font-medium text-danger">
          <AlertTriangle aria-hidden className="h-4 w-4" />
          Restore from a backup file
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted">
            Replaces the entire database with the contents of a <code>{ARCHIVE_EXTENSION}</code> file. Everything
            recorded since that backup was taken is discarded — including the log of who discarded it. There is no undo.
          </p>

          {/* ── 1. The file ─────────────────────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              ref={inputRef}
              type="file"
              accept={ARCHIVE_EXTENSION}
              aria-label="Backup archive to restore"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreflight(null);
                setError(null);
              }}
              className="max-w-sm text-xs"
            />
            <Button size="sm" variant="secondary" onClick={upload} disabled={!file || uploading}>
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {uploading ? "Uploading…" : "Upload and check"}
            </Button>
            {file && !preflight && <span className="text-xs text-subtle">{formatBytes(file.size)}</span>}
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          {/* ── 2. What it is ───────────────────────────────────────────────────────────────── */}
          {preflight && (
            <div className="space-y-3 rounded-base border border-line bg-surface-sunken p-3">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                <Row label="Taken" value={formatDateTime(new Date(preflight.archive.takenAt))} />
                <Row label="Contains" value={formatBytes(preflight.archive.dumpBytes)} />
                <Row label="Schema" value={preflight.archive.schemaVersion ?? "unknown"} />
                <Row label="This database is on" value={preflight.database.schemaVersion ?? "unknown"} />
              </dl>

              {preflight.archive.sameInstance === false && (
                <Warning>
                  This backup was taken by a different installation. Its encrypted columns were written under another{" "}
                  <code>AUTH_SECRET</code>
                  {preflight.archive.carriesSecret
                    ? " — the archive carries that secret, so they can be recovered, but you will have to set it and restart afterwards."
                    : ", and the archive does not carry it. The vault, two-factor secrets and stored credentials will restore unreadable."}
                </Warning>
              )}
              {preflight.archive.sameInstance === null && (
                <Warning>
                  Whether this backup came from this installation cannot be determined — one side has no fingerprint to
                  compare. Check what it is before restoring it.
                </Warning>
              )}
              {preflight.database.sameSchema === false && (
                <Warning>
                  This backup is from a different migration than the database is on. Restoring replaces the schema with
                  the one in the file, and the running code expects the current one — run the migrations again
                  afterwards.
                </Warning>
              )}

              {/* ── 3. The passphrase, and 4. the words ──────────────────────────────────────── */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="rs-pass" className="text-xs font-medium text-text">
                    Passphrase for this file
                  </label>
                  <Input
                    id="rs-pass"
                    type="password"
                    autoComplete="off"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label htmlFor="rs-confirm" className="text-xs font-medium text-text">
                    Type {CONFIRM_PHRASE}
                  </label>
                  <Input
                    id="rs-confirm"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="mt-1 font-mono"
                    aria-describedby="rs-confirm-hint"
                  />
                  <p id="rs-confirm-hint" className="mt-1 text-xs text-subtle">
                    Typed rather than ticked, because a tick is muscle memory.
                  </p>
                </div>
              </div>

              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={start}
                  disabled={starting || confirm.trim() !== CONFIRM_PHRASE || passphrase.length === 0}
                >
                  {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  {starting ? "Starting…" : "Replace the database"}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 sm:block">
      <dt className="text-subtle">{label}</dt>
      <dd className="font-mono text-text sm:mt-0.5">{value}</dd>
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 rounded-base border border-warning/40 bg-warning-bg px-2.5 py-1.5 text-xs text-warning">
      <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
