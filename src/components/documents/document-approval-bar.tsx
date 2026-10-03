"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Send, Undo2 } from "lucide-react";
import type { DocumentApprovalStatus } from "@prisma/client";
import { submitForApproval, decideApproval } from "@/actions/document-approval";
import { approvalStatusLabels } from "@/lib/documents/approval";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import type { Clock } from "@/lib/time/zone";

/**
 * The sign-off banner: where the document has got to, and the one or two things this person can do.
 *
 * Styled as the "What's next?" banner rather than as a row of extra buttons, and it *replaces* that
 * banner while approval is outstanding — see `nextStepFor`. Two banners stacked above a document,
 * one saying "this is still a draft" and another saying "this is waiting for Priya", is two things
 * to read where the second is the only one that matters.
 *
 * The rejection reason is the most important text on this screen when it exists: it is the whole
 * content of the decision, and without it somebody has to go and ask what was wrong.
 */
export function DocumentApprovalBar({
  id,
  status,
  submittedBy,
  submittedAt,
  approvedBy,
  approvedAt,
  note,
  mayApprove,
  maySubmit,
}: {
  id: string;
  status: DocumentApprovalStatus;
  submittedBy: string | null;
  submittedAt: Date | string | null;
  approvedBy: string | null;
  approvedAt: Date | string | null;
  note: string | null;
  mayApprove: boolean;
  maySubmit: boolean;
}) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const [reason, setReason] = useState("");

  const run = (fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, after?: () => void) => {
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
  };

  const { tone, headline, detail } = describe({ status, submittedBy, submittedAt, approvedBy, approvedAt, mayApprove }, clock);

  return (
    <div
      className={`mt-5 rounded-xl border px-4 py-3 ${
        tone === "warning"
          ? "border-warning/40 bg-warning-bg"
          : tone === "danger"
            ? "border-danger/40 bg-danger-bg"
            : tone === "success"
              ? "border-success/40 bg-success-bg"
              : "border-line bg-surface-sunken"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-subtle">
            {status === "APPROVED" ? "Approved" : "Approval"}
          </div>
          <p className="mt-1 text-sm text-text">
            <span className="font-medium">{headline}</span> <span className="text-muted">{detail}</span>
          </p>

          {/* Why it came back. The one thing on this banner somebody has to act on. */}
          {note && status === "REJECTED" && (
            <p className="mt-2 rounded-base bg-surface px-3 py-2 text-sm text-danger">
              <span className="font-medium">Reason:</span> {note}
            </p>
          )}
          {note && status === "APPROVED" && <p className="mt-1.5 text-xs text-muted">“{note}”</p>}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {maySubmit && (
            <Button size="sm" disabled={pending} onClick={() => run(() => submitForApproval({ id }))}>
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {status === "REJECTED" ? "Submit again" : "Submit for approval"}
            </Button>
          )}
          {mayApprove && (
            <>
              <Button size="sm" disabled={pending} onClick={() => run(() => decideApproval({ id, approved: true }))}>
                <Check className="mr-1.5 h-3.5 w-3.5" />
                Approve
              </Button>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => setSendBackOpen(true)}>
                <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                Reject
              </Button>
            </>
          )}
        </div>
      </div>

      {error && <p className="mt-2 text-sm text-danger">{error}</p>}

      <Dialog open={sendBackOpen} onClose={() => setSendBackOpen(false)} title="Reject this document">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            It stays a draft and stays editable — that is the point of sending it back rather than cancelling it.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="send-back-reason">Why</Label>
            <Input
              id="send-back-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="The discount needs sign-off from Finance first"
              autoComplete="off"
            />
            {/* Required by the action too. A document that comes back with no reason is one the
                sender has to go and ask about, which is the delay this was meant to remove. */}
            <p className="text-xs text-subtle">This is what the sender sees, so it is worth a sentence.</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSendBackOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={pending || reason.trim().length === 0}
              onClick={() =>
                run(
                  () => decideApproval({ id, approved: false, note: reason }),
                  () => {
                    setSendBackOpen(false);
                    setReason("");
                  },
                )
              }
            >
              Reject
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/** The sentence for each state, written for whoever is looking rather than about the record. */
function describe(
  {
    status,
    submittedBy,
    submittedAt,
    approvedBy,
    approvedAt,
    mayApprove,
  }: {
    status: DocumentApprovalStatus;
    submittedBy: string | null;
    submittedAt: Date | string | null;
    approvedBy: string | null;
    approvedAt: Date | string | null;
    mayApprove: boolean;
  },
  clock: Clock,
): { tone: "info" | "warning" | "danger" | "success"; headline: string; detail: string } {
  const by = (name: string | null, at: Date | string | null) =>
    name ? `${name}${at ? ` on ${clock.date(at)}` : ""}` : "somebody";

  switch (status) {
    case "PENDING":
      return {
        tone: "warning",
        headline: mayApprove
          ? "This has been submitted for approval."
          : `Waiting for approval — submitted by ${by(submittedBy, submittedAt)}.`,
        detail: mayApprove
          ? "Check the details and approve it, or reject it with a reason."
          : "It can't be issued until somebody approves it.",
      };
    case "REJECTED":
      return {
        tone: "danger",
        headline: `Rejected by ${by(approvedBy, approvedAt)}.`,
        detail: "Make the changes and submit it again.",
      };
    case "APPROVED":
      return {
        tone: "success",
        headline: `Approved by ${by(approvedBy, approvedAt)}.`,
        detail: "It can be issued now. Editing it will send it back for approval.",
      };
    default:
      return {
        tone: "info",
        headline: "This needs approving before it can be issued.",
        detail: `${approvalStatusLabels.NOT_SUBMITTED} yet — submit it when the details are right.`,
      };
  }
}
