"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { VisitStatus } from "@prisma/client";
import { checkInVisit, completeVisit, setVisitStatus, deleteVisit } from "@/actions/visit";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";

export function VisitActions({
  id,
  status,
  distanceKm,
  canEdit,
}: {
  id: string;
  status: VisitStatus;
  distanceKm: string;
  /** False when you're only allowed to look — a manager viewing someone outside their own line. */
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [writeUpOpen, setWriteUpOpen] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [distance, setDistance] = useState(distanceKm);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelNote, setCancelNote] = useState("");
  const [cancelStatus, setCancelStatus] = useState<VisitStatus>("CANCELLED");

  if (!canEdit) return null;

  function run(fn: () => Promise<{ ok: true; data?: unknown } | { ok: false; error: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      after?.();
      router.refresh();
    });
  }

  const open = status === "PLANNED" || status === "CHECKED_IN";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {status === "PLANNED" && (
          <Button onClick={() => run(() => checkInVisit(id))} disabled={pending}>
            Check in
          </Button>
        )}
        {open && (
          <Button variant={status === "CHECKED_IN" ? "primary" : "secondary"} onClick={() => setWriteUpOpen(true)} disabled={pending}>
            Complete visit
          </Button>
        )}
        {open && (
          <Button variant="secondary" onClick={() => router.push(`/visits/${id}/edit`)} disabled={pending}>
            Edit
          </Button>
        )}
        <Button variant="secondary" onClick={() => router.push(`/expenses/new?visitId=${id}`)} disabled={pending}>
          Add expense
        </Button>
        {open && (
          <Button variant="ghost" onClick={() => setCancelOpen(true)} disabled={pending}>
            Cancel / no show
          </Button>
        )}
        {status === "PLANNED" && (
          <Button
            variant="ghost"
            className="text-danger hover:bg-danger-bg hover:text-danger"
            disabled={pending}
            onClick={() => {
              if (confirm("Delete this planned visit?")) run(() => deleteVisit(id), () => router.push("/visits"));
            }}
          >
            Delete
          </Button>
        )}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <Dialog open={writeUpOpen} onClose={() => setWriteUpOpen(false)} title="Complete visit">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            The write-up is what makes the visit worth logging — what was discussed, what was agreed, what happens
            next.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="outcome">Outcome</Label>
            <Textarea id="outcome" rows={5} value={outcome} onChange={(e) => setOutcome(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="distance">Distance travelled (km)</Label>
            <Input
              id="distance"
              type="number"
              min="0"
              step="0.1"
              value={distance}
              onChange={(e) => setDistance(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              disabled={pending || !outcome.trim()}
              onClick={() =>
                run(
                  () => completeVisit({ id, outcome, distanceKm: distance }),
                  () => setWriteUpOpen(false),
                )
              }
            >
              {pending ? "Saving…" : "Complete"}
            </Button>
            <Button variant="secondary" onClick={() => setWriteUpOpen(false)}>
              Not yet
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel this visit">
        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={cancelStatus === "CANCELLED" ? "primary" : "secondary"}
              onClick={() => setCancelStatus("CANCELLED")}
            >
              Cancelled
            </Button>
            <Button
              size="sm"
              variant={cancelStatus === "NO_SHOW" ? "primary" : "secondary"}
              onClick={() => setCancelStatus("NO_SHOW")}
            >
              They didn&apos;t show
            </Button>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cancelNote">Why</Label>
            <Textarea id="cancelNote" rows={3} value={cancelNote} onChange={(e) => setCancelNote(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button
              variant="danger"
              disabled={pending || !cancelNote.trim()}
              onClick={() =>
                run(
                  () => setVisitStatus({ id, status: cancelStatus, note: cancelNote }),
                  () => setCancelOpen(false),
                )
              }
            >
              Save
            </Button>
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              Keep it
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
