"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ExpenseStatus } from "@prisma/client";
import { submitExpense, decideExpense, reimburseExpenses, deleteExpense } from "@/actions/expense";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { isExpenseEditable } from "@/lib/expenses";

export function ExpenseActions({
  id,
  status,
  reimbursable,
  isMine,
  canDecide,
  canReimburse,
  approverName,
}: {
  id: string;
  status: ExpenseStatus;
  reimbursable: boolean;
  isMine: boolean;
  /** True when this claim is in your queue — never true for your own claim. */
  canDecide: boolean;
  canReimburse: boolean;
  /** Null when nothing could be routed to — no manager, and nobody else can approve. */
  approverName: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState("");
  const [payOpen, setPayOpen] = useState(false);
  const [reference, setReference] = useState("");

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      after?.();
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {isMine && isExpenseEditable(status) && (
          <>
            <Button onClick={() => run(() => submitExpense(id))} disabled={pending}>
              {status === "REJECTED" ? "Resubmit" : "Submit for approval"}
            </Button>
            <Button variant="secondary" onClick={() => router.push(`/expenses/${id}/edit`)} disabled={pending}>
              Edit
            </Button>
            <Button
              variant="ghost"
              className="text-danger hover:bg-danger-bg hover:text-danger"
              disabled={pending}
              onClick={() => {
                if (confirm("Delete this claim?")) run(() => deleteExpense(id), () => router.push("/expenses"));
              }}
            >
              Delete
            </Button>
          </>
        )}

        {canDecide && status === "SUBMITTED" && (
          <>
            <Button onClick={() => run(() => decideExpense({ id, approved: true }))} disabled={pending}>
              Approve
            </Button>
            <Button variant="danger" onClick={() => setRejectOpen(true)} disabled={pending}>
              Reject
            </Button>
          </>
        )}

        {canReimburse && status === "APPROVED" && reimbursable && (
          <Button variant="secondary" onClick={() => setPayOpen(true)} disabled={pending}>
            Mark reimbursed
          </Button>
        )}

        {status === "SUBMITTED" && isMine && (
          <span className="text-sm text-subtle">
            {approverName
              ? `Waiting on ${approverName} — it can't be edited until they decide.`
              : "Submitted, but there's nobody to route it to: you have no reporting manager set, and nobody else can approve claims. Set a manager under Settings → Users & Access."}
          </span>
        )}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <Dialog open={rejectOpen} onClose={() => setRejectOpen(false)} title="Reject this claim">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            The claimant sees this note and can fix and resubmit, so say what&apos;s wrong with it.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="note">Reason</Label>
            <Textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button
              variant="danger"
              disabled={pending || !note.trim()}
              onClick={() =>
                run(
                  () => decideExpense({ id, approved: false, note }),
                  () => setRejectOpen(false),
                )
              }
            >
              Reject
            </Button>
            <Button variant="secondary" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={payOpen} onClose={() => setPayOpen(false)} title="Mark reimbursed">
        <div className="space-y-4">
          <p className="text-sm text-muted">Records that this has actually been paid out to the claimant.</p>
          <div className="space-y-1.5">
            <Label htmlFor="reference">Payment reference</Label>
            <Input
              id="reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="UTR / cheque no."
            />
          </div>
          <div className="flex gap-2">
            <Button
              disabled={pending}
              onClick={() =>
                run(
                  () => reimburseExpenses({ expenseIds: [id], reimbursementRef: reference }),
                  () => setPayOpen(false),
                )
              }
            >
              Mark paid
            </Button>
            <Button variant="secondary" onClick={() => setPayOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
