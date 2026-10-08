"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelMeetingAction } from "@/actions/calendar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Textarea } from "@/components/ui/input";
import { MeetingDialog } from "@/components/calendar/meeting-dialog";

/**
 * Moving or cancelling a meeting the viewer organises. Either way the calendar tells everybody invited;
 * a cancellation can carry a line saying why.
 */
export function MeetingActions({
  eventId,
  title,
  size = "sm",
  canReschedule = true,
}: {
  eventId: string;
  title: string;
  size?: "sm" | "md";
  /** Holds "Schedule meetings" — without it a meeting they booked can still be cancelled, not moved. */
  canReschedule?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function cancel() {
    setError(null);
    startTransition(async () => {
      const done = await cancelMeetingAction({ eventId, note });
      if (!done.ok) {
        setError(done.error);
        return;
      }
      setCancelling(false);
      router.refresh();
    });
  }

  return (
    <>
      <div className="flex gap-1.5">
        {canReschedule && (
          <Button size={size} variant="secondary" onClick={() => setEditing(true)}>
            Reschedule
          </Button>
        )}
        <Button size={size} variant="ghost" onClick={() => setCancelling(true)}>
          Cancel meeting
        </Button>
      </div>
      {editing && <MeetingDialog mode={{ kind: "edit", eventId }} onClose={() => setEditing(false)} />}
      {cancelling && (
        <Dialog open onClose={() => setCancelling(false)} title={`Cancel “${title}”?`}>
          <div className="space-y-3">
            <p className="text-sm text-muted">Everybody invited is told it&apos;s off, from your calendar.</p>
            <div>
              <Label htmlFor={`cancel-note-${eventId}`}>A line for them (optional)</Label>
              <Textarea id={`cancel-note-${eventId}`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} />
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCancelling(false)}>
                Keep it
              </Button>
              <Button variant="danger" onClick={cancel} disabled={pending}>
                {pending ? "Cancelling…" : "Cancel meeting"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
