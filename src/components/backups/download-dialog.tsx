"use client";

import { useRef, useState } from "react";
import { Download, ShieldAlert } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { MIN_PASSPHRASE_LENGTH } from "@/lib/backup/archive-format";
import { formatBytes } from "@/lib/backup/policy";

/**
 * Asks for a passphrase, then lets the browser do the downloading.
 *
 * The form posts natively rather than going through `fetch`. A fetch would have to hold the whole
 * response in memory to turn it into a blob the page can save, and the response is the entire
 * database — so a large backup would take the tab down on the way out. A real form submit hands the
 * response to the browser's own downloader, which streams it to disk and draws the progress bar the
 * `Content-Length` makes possible.
 *
 * The cost of that choice is that a failure navigates: the server's JSON error would replace the
 * page. So everything answerable up front is answered up front — the passphrase length here, the
 * permission and the file's presence on the server — leaving the POST with nothing ordinary left to
 * fail on. `target` is a hidden iframe for the same reason: if something unexpected does come back,
 * it lands there instead of over the page somebody is standing on.
 */
export function DownloadDialog({
  backup,
}: {
  backup: { id: string; filename: string; sizeBytes: number | null };
}) {
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE_LENGTH;
  const mismatch = again.length > 0 && again !== passphrase;
  const ready = passphrase.length >= MIN_PASSPHRASE_LENGTH && again === passphrase;

  function close() {
    setOpen(false);
    // Cleared on the way out rather than left in React state for the rest of the session.
    setPassphrase("");
    setAgain("");
  }

  return (
    <>
      {/* The label is required by `IconButton` rather than optional, so it is both the tooltip
          and the accessible name. The filename is in it because a column of identical download
          icons otherwise gives a screen reader eleven buttons all called "Download". */}
      <IconButton
        icon={Download}
        label={`Download ${backup.filename}`}
        onClick={() => setOpen(true)}
      />

      <Dialog open={open} onClose={close} title="Download this backup">
        <div className="space-y-4">
          <div className="rounded-base border border-line bg-surface-sunken px-3 py-2">
            <p className="font-mono text-xs text-text">{backup.filename}</p>
            <p className="mt-0.5 text-xs text-muted">{formatBytes(backup.sizeBytes)}</p>
          </div>

          <div className="flex items-start gap-2 rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
            <ShieldAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">This file is the whole business.</p>
              <p className="mt-0.5">
                Every customer, order and payslip, every password hash, and the key to the credential vault. It is
                encrypted with the passphrase you choose here and with nothing else — so if you lose the passphrase the
                backup is gone, and if somebody else learns it they have everything.
              </p>
            </div>
          </div>

          <form
            ref={formRef}
            method="post"
            action={`/api/backups/${backup.id}/download`}
            target="backup-download-sink"
            onSubmit={() => {
              // The browser takes it from here. Closing also clears the passphrase out of state.
              setTimeout(close, 0);
            }}
            className="space-y-3"
          >
            <div>
              <label htmlFor="bk-pass" className="text-xs font-medium text-text">
                Passphrase
              </label>
              <Input
                id="bk-pass"
                name="passphrase"
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="mt-1"
                aria-describedby="bk-pass-hint"
              />
              <p id="bk-pass-hint" className={`mt-1 text-xs ${tooShort ? "text-danger" : "text-subtle"}`}>
                {tooShort
                  ? `At least ${MIN_PASSPHRASE_LENGTH} characters.`
                  : `At least ${MIN_PASSPHRASE_LENGTH} characters. A few ordinary words beat one clever one — you will type this again to restore.`}
              </p>
            </div>

            <div>
              <label htmlFor="bk-pass-2" className="text-xs font-medium text-text">
                Passphrase again
              </label>
              <Input
                id="bk-pass-2"
                type="password"
                autoComplete="new-password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                className="mt-1"
                aria-describedby="bk-pass-2-hint"
              />
              <p id="bk-pass-2-hint" className={`mt-1 text-xs ${mismatch ? "text-danger" : "text-subtle"}`}>
                {mismatch
                  ? "These do not match."
                  : "Typed twice because a typo here is not discovered until the day you need the file."}
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!ready}>
                <Download className="h-3.5 w-3.5" />
                Download
              </Button>
            </div>
          </form>
        </div>
      </Dialog>

      {/* Where the response lands. Named, empty, and never navigated by anything else. */}
      <iframe name="backup-download-sink" title="Download" className="hidden" aria-hidden />
    </>
  );
}
