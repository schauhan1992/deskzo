"use client";

import { useId, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { StockDocumentStatus, StockDocumentType } from "@prisma/client";
import {
  approveStockDocument,
  cancelStockDocument,
  postStockDocument,
  receiveStockTransfer,
  returnStockDocument,
  submitStockDocument,
} from "@/actions/inventory";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Textarea } from "@/components/ui/input";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";

/**
 * What can be done with a stock voucher from its page, by its status and what the viewer holds. Every button
 * asks the server again (src/actions/inventory.ts) — a button shown here is a convenience, not the permission.
 */
export function StockDocumentActions({
  id,
  type,
  status,
  needsApproval,
  can,
}: {
  id: string;
  type: StockDocumentType;
  status: StockDocumentStatus;
  needsApproval: boolean;
  can: { edit: boolean; post: boolean; approve: boolean; cancel: boolean; receive: boolean };
}) {
  const router = useRouter();
  const formId = useId();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [sendingBack, setSendingBack] = useState(false);
  const [why, setWhy] = useState("");

  function run(work: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, done: string) {
    setNotice(null);
    start(async () => {
      const result = await work();
      if (!result.ok) {
        setNotice({ tone: "error", message: result.error });
        return;
      }
      setNotice({ tone: "success", message: done });
      setCancelling(false);
      setSendingBack(false);
      setWhy("");
      router.refresh();
    });
  }

  const moved = status === "POSTED" || status === "IN_TRANSIT";
  const isDraft = status === "DRAFT";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-2">
        {isDraft && can.edit && (
          <Link href={`/items/stock/${id}/edit`}>
            <Button variant="secondary" size="sm">
              Edit
            </Button>
          </Link>
        )}
        {isDraft && can.post && needsApproval && (
          <Button size="sm" disabled={pending} onClick={() => run(() => submitStockDocument(id), "Sent for approval.")}>
            Send for approval
          </Button>
        )}
        {isDraft && can.post && !needsApproval && (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              if (window.confirm(type === "TRANSFER" ? "Send it? The stock leaves this warehouse now and is in transit until received." : "Post it? Stock moves now; undoing it later means cancelling it, which reverses it."))
                run(() => postStockDocument(id), type === "TRANSFER" ? "Sent — in transit." : "Posted.");
            }}
          >
            {type === "TRANSFER" ? "Send" : "Post"}
          </Button>
        )}
        {status === "PENDING_APPROVAL" && can.approve && (
          <>
            <Button variant="secondary" size="sm" disabled={pending} onClick={() => setSendingBack(true)}>
              Send back
            </Button>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                if (window.confirm("Approve and post it? Stock moves now.")) run(() => approveStockDocument(id), "Approved and posted.");
              }}
            >
              Approve &amp; post
            </Button>
          </>
        )}
        {status === "IN_TRANSIT" && can.receive && (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              if (window.confirm("Receive it? The stock arrives in the destination warehouse at what it cost when it left.")) run(() => receiveStockTransfer(id), "Received.");
            }}
          >
            Receive
          </Button>
        )}
        {status !== "CANCELLED" && can.cancel && (
          <Button variant={moved ? "danger" : "ghost"} size="sm" disabled={pending} onClick={() => setCancelling(true)}>
            {moved ? "Cancel & reverse" : "Cancel"}
          </Button>
        )}
      </div>
      <ActionNoticeRegion notice={notice} className="flex justify-end" />

      <Dialog open={cancelling} onClose={() => setCancelling(false)} title={moved ? "Cancel and reverse this voucher" : "Cancel this voucher"}>
        <div className="space-y-3">
          <p className="text-sm text-muted">
            {moved
              ? "Every movement it made is reversed at its own value, and its ledger entry with it. The voucher and its movements are kept, marked cancelled — nothing is deleted."
              : "It hasn't moved any stock; it is simply marked cancelled."}
          </p>
          <div className="space-y-1">
            <Label htmlFor={`${formId}-why`}>Why?</Label>
            <Textarea id={`${formId}-why`} rows={2} value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCancelling(false)}>
              Keep it
            </Button>
            <Button variant="danger" disabled={pending || !why.trim()} onClick={() => run(() => cancelStockDocument(id, why), moved ? "Cancelled and reversed." : "Cancelled.")}>
              {pending ? "Working…" : moved ? "Cancel & reverse" : "Cancel it"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={sendingBack} onClose={() => setSendingBack(false)} title="Send back to draft">
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`${formId}-note`}>What needs changing (optional)</Label>
            <Textarea id={`${formId}-note`} rows={2} value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSendingBack(false)}>
              Keep waiting
            </Button>
            <Button disabled={pending} onClick={() => run(() => returnStockDocument(id, why), "Sent back to draft.")}>
              Send back
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
