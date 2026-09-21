"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { destroyArchivedCredential, restoreCredential, type ArchivedRow } from "@/actions/vault";
import { ARCHIVE_RETENTION_DAYS } from "@/lib/vault/policy";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { formatDate } from "@/lib/utils";

/**
 * Deleted logins, and the clock they are on.
 *
 * Every row says how long is left, because the number is the whole point: the archive is not
 * storage, it is a grace period. Showing "deleted on 3 March" and leaving the reader to count is
 * how something falls off the end while somebody was still deciding.
 *
 * Nothing here can be opened. A record has to be restored before its password can be read again,
 * through the ordinary reveal path with the ordinary audit trail — the archive must not become a
 * quiet second way to read a secret nobody is watching.
 */
export function VaultArchive({ rows }: { rows: ArchivedRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [destroying, setDestroying] = useState<ArchivedRow | null>(null);

  async function restore(row: ArchivedRow) {
    setBusy(row.id);
    const result = await restoreCredential(row.id);
    setBusy(null);
    if (!result.ok) alert(result.error);
    router.refresh();
  }

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted">
          Nothing has been deleted. Anything that is stays here for {ARCHIVE_RETENTION_DAYS} days and is then destroyed.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <Card key={r.id}>
          <CardContent className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-text">{r.loginName}</span>
                {r.category && <Badge tone="default">{r.category}</Badge>}
                {/*
                  The last week is called out. A record with fifty days left is a decision somebody
                  can take next month; one with three is a decision somebody has to take today.
                */}
                {r.daysLeft <= 7 && (
                  <Badge tone="red">
                    <TriangleAlert className="mr-1 h-3 w-3" />
                    {r.daysLeft <= 0 ? "Due to be destroyed" : `${r.daysLeft} days left`}
                  </Badge>
                )}
              </div>

              <div className="mt-1 space-y-0.5 text-xs text-muted">
                <div>
                  Was {r.ownerName}&apos;s · deleted {formatDate(new Date(r.archivedAt))}
                  {r.archivedByName ? ` by ${r.archivedByName}` : ""}
                </div>
                {r.archiveReason ? (
                  <div className="text-text">{r.archiveReason}</div>
                ) : (
                  <div className="text-subtle">No reason was given.</div>
                )}
                {r.daysLeft > 7 && <div className="text-subtle">Destroyed in {r.daysLeft} days.</div>}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Button size="sm" variant="secondary" disabled={busy === r.id} onClick={() => restore(r)}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                {busy === r.id ? "Restoring…" : "Restore"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDestroying(r)}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Destroy now
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      {destroying && (
        <DestroyDialog row={destroying} onClose={() => setDestroying(null)} onDone={() => {
          setDestroying(null);
          router.refresh();
        }} />
      )}
    </div>
  );
}

/**
 * Its own dialog, worded to be unmistakable.
 *
 * Deliberately not the same control as deleting: one is reversible for two months and the other is
 * not reversible at all, and collapsing them into a single confirmation with different wording is
 * how somebody does the second while believing they did the first. Typing the name is the friction
 * that makes the difference land — it cannot be done by muscle memory.
 */
function DestroyDialog({
  row,
  onClose,
  onDone,
}: {
  row: ArchivedRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const matches = typed.trim() === row.loginName;

  return (
    <Dialog open onClose={onClose} title="Destroy this record?">
      <div className="space-y-4">
        <div className="flex gap-3 rounded-base border border-danger/40 bg-danger-bg px-3 py-2.5 text-sm text-danger">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            The stored password is destroyed immediately and cannot be recovered by anyone, including an
            administrator. It would otherwise be destroyed on its own in {Math.max(0, row.daysLeft)} days.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="destroy-confirm" className="text-sm text-text">
            Type <span className="font-mono text-muted">{row.loginName}</span> to confirm
          </label>
          <input
            id="destroy-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            className="h-9 w-full rounded-md border border-line-strong px-3 text-sm"
          />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={pending || !matches}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await destroyArchivedCredential(row.id);
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                onDone();
              })
            }
          >
            {pending ? "Destroying…" : "Destroy for good"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
