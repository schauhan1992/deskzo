"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteTicket } from "@/actions/ticket";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { formatTicketId } from "@/lib/tickets";

export function DeleteTicketButton({
  ticketId,
  ticketSeq,
  redirectTo,
}: {
  ticketId: string;
  ticketSeq: number;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function confirmDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteTicket(ticketId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      if (redirectTo) {
        router.push(redirectTo);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-danger hover:bg-danger-bg hover:text-danger"
        onClick={() => setOpen(true)}
      >
        Delete
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Delete ticket">
        <p className="text-sm text-muted">
          Delete <span className="font-medium text-text">{formatTicketId(ticketSeq)}</span> and its entire
          comment thread? This can&apos;t be undone.
        </p>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={confirmDelete} disabled={isPending}>
            {isPending ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
