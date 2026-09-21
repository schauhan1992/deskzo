"use client";

import { useState, useTransition } from "react";
import { Archive, TriangleAlert } from "lucide-react";
import { deleteCredential, type VaultRow } from "@/actions/vault";
import { ARCHIVE_RETENTION_DAYS } from "@/lib/vault/policy";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/**
 * Deleting a stored login, with what that actually means said out loud.
 *
 * This replaced a browser `confirm()`, which was the wrong control for two reasons. It could not
 * say what the system really does — set the record aside for two months rather than destroy it —
 * and it could not ask why, which is the first question anybody has when they find something
 * missing. Neither fits in a one-line prompt, and both matter more here than almost anywhere: a
 * stored password is the one thing in this system that cannot be reconstructed by asking somebody
 * what it was.
 *
 * Deleting somebody else's is worded differently and says whose. The two clicks are identical; the
 * consequences are not.
 */
export function ArchiveDialog({
  row,
  onClose,
  onDone,
}: {
  row: VaultRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open onClose={onClose} title={`Delete ${row.loginName}?`}>
      <div className="space-y-4">
        <div className="flex gap-3 rounded-base border border-warning/40 bg-warning-bg px-3 py-2.5 text-sm text-warning">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="space-y-1">
            <p>
              This moves the record to the archive, where an administrator can put it back for{" "}
              <strong>{ARCHIVE_RETENTION_DAYS} days</strong>. After that it is destroyed and the stored password is
              gone for good.
            </p>
            {!row.mine && (
              <p>
                It belongs to <strong>{row.owner.name}</strong>, and they will be told it was deleted.
              </p>
            )}
            {row.ownership === "CLIENT" && (
              <p>
                It is {row.company ? `${row.company.name}'s` : "a client's"} account, not ours — check before removing
                the only record of it.
              </p>
            )}
          </div>
        </div>

        {row.shares.length > 0 && (
          <p className="text-sm text-muted">
            {row.shares.length} {row.shares.length === 1 ? "person or team" : "people and teams"} can currently open
            this. They will lose it.
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="archive-reason">Why (optional)</Label>
          <Input
            id="archive-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Account closed, replaced by the new portal…"
          />
          <p className="text-xs text-subtle">
            Shown in the archive. It is the first thing anybody wants to know when they find this missing.
          </p>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Keep it
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await deleteCredential(row.id, reason);
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                onDone();
              })
            }
          >
            <Archive className="mr-1.5 h-3.5 w-3.5" />
            {pending ? "Deleting…" : "Delete and archive"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
