"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { VoucherStatus } from "@prisma/client";
import { approveVoucher, cancelVoucher, postVoucher, returnVoucher, reverseVoucher, submitVoucher } from "@/actions/vouchers";
import { useClock } from "@/components/time/clock-provider";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

type Step = "post" | "cancel" | "reverse" | "return" | null;

/**
 * What can be done to a voucher from where it stands, for this person (owner, 22 Oct 2026). The server asks
 * every question again — a button left showing for somebody who may not press it is refused, not obeyed.
 * Posting, cancelling, reversing and sending back each ask first: the first two can't be undone, and the
 * last two keep a reason.
 */
export function VoucherActions({
  id,
  number,
  status,
  can,
  approvalRequired,
  isCreator,
}: {
  id: string;
  number: string;
  status: VoucherStatus;
  can: { create: boolean; approve: boolean; post: boolean };
  approvalRequired: boolean;
  isCreator: boolean;
}) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [step, setStep] = useState<Step>(null);
  const [reason, setReason] = useState("");
  const [reverseOn, setReverseOn] = useState(() => clock.today());

  function run(work: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, success: (data: unknown) => string) {
    setResult(null);
    startTransition(async () => {
      const out = await work();
      if (!out.ok) {
        setResult({ tone: "error", text: out.error });
        return;
      }
      setStep(null);
      setReason("");
      setResult({ tone: "success", text: success(out.data) });
      router.refresh();
    });
  }

  const draft = status === "DRAFT";
  const waiting = status === "PENDING_APPROVAL";
  const approved = status === "APPROVED";
  const mayPost = can.post && ((draft && !approvalRequired) || approved);
  const mayCancel = (can.create || can.approve) && (draft || waiting || approved);
  const buttons = [
    draft && can.create && (
      <Link key="edit" href={`/accounting/vouchers/${id}/edit`} className="inline-flex h-9 items-center rounded-base border border-line-strong bg-surface px-3.5 text-sm font-medium text-text shadow-sm hover:bg-surface-sunken">
        Edit
      </Link>
    ),
    draft && can.create && approvalRequired && (
      <Button key="submit" variant="secondary" disabled={pending} onClick={() => run(() => submitVoucher(id), () => "Submitted for approval.")}>
        Submit for approval
      </Button>
    ),
    waiting && can.approve && !isCreator && (
      <Button key="approve" disabled={pending} onClick={() => run(() => approveVoucher(id), () => "Approved. It posts when somebody posts it.")}>
        Approve
      </Button>
    ),
    waiting && can.approve && (
      <Button key="return" variant="secondary" disabled={pending} onClick={() => setStep("return")}>
        Send back
      </Button>
    ),
    mayPost && (
      <Button key="post" disabled={pending} onClick={() => setStep("post")}>
        Post
      </Button>
    ),
    status === "POSTED" && can.post && (
      <Button key="reverse" variant="secondary" disabled={pending} onClick={() => setStep("reverse")}>
        Reverse
      </Button>
    ),
    mayCancel && (
      <Button key="cancel" variant="ghost" disabled={pending} onClick={() => setStep("cancel")}>
        Cancel voucher
      </Button>
    ),
  ].filter(Boolean);

  const close = () => {
    setStep(null);
    setReason("");
  };

  return (
    <div className="space-y-2">
      {buttons.length > 0 && <div className="flex flex-wrap items-center gap-2">{buttons}</div>}
      {waiting && can.approve && isCreator && <p className="text-xs text-muted">You wrote this voucher, so somebody else approves it.</p>}
      {draft && approvalRequired && can.post && !can.create && <p className="text-xs text-muted">It posts once it&apos;s been submitted for approval and approved.</p>}
      {result && <ActionNotice tone={result.tone}>{result.text}</ActionNotice>}

      <Dialog open={step === "post"} onClose={close} title={`Post ${number}?`}>
        <div className="space-y-4">
          <p className="text-sm text-muted">
            It becomes one journal entry in the books, on the voucher&apos;s date. A posted voucher is never edited — a mistake is put right
            by reversing it.
          </p>
          {result?.tone === "error" && <ActionNotice tone="error">{result.text}</ActionNotice>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Not yet
            </Button>
            <Button disabled={pending} onClick={() => run(() => postVoucher(id), (d) => `Posted as ${(d as { entryNumber: string }).entryNumber}.`)}>
              {pending ? "Posting…" : "Post"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={step === "cancel"} onClose={close} title={`Cancel ${number}?`}>
        <div className="space-y-4">
          <p className="text-sm text-muted">It never reaches the books. Its number stays used, marked cancelled.</p>
          <div className="space-y-1.5">
            <Label htmlFor="vCancelReason">Why</Label>
            <Textarea id="vCancelReason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {result?.tone === "error" && <ActionNotice tone="error">{result.text}</ActionNotice>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Keep it
            </Button>
            <Button variant="danger" disabled={pending || !reason.trim()} onClick={() => run(() => cancelVoucher(id, reason), () => "Cancelled.")}>
              Cancel voucher
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={step === "return"} onClose={close} title={`Send ${number} back?`}>
        <div className="space-y-4">
          <p className="text-sm text-muted">It goes back to draft for its writer to change and send again.</p>
          <div className="space-y-1.5">
            <Label htmlFor="vReturnNote">What needs changing (optional)</Label>
            <Textarea id="vReturnNote" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {result?.tone === "error" && <ActionNotice tone="error">{result.text}</ActionNotice>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Not yet
            </Button>
            <Button disabled={pending} onClick={() => run(() => returnVoucher(id, reason), () => "Sent back to draft.")}>
              Send back
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={step === "reverse"} onClose={close} title={`Reverse ${number}?`}>
        <div className="space-y-4">
          <p className="text-sm text-muted">
            An opposite entry is posted on the day you choose, so the voucher nets to nothing. Both entries stay in the books.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="vReverseOn">Reverse on</Label>
            <Input id="vReverseOn" type="date" value={reverseOn} max={clock.today()} onChange={(e) => setReverseOn(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vReverseReason">Why</Label>
            <Textarea id="vReverseReason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {result?.tone === "error" && <ActionNotice tone="error">{result.text}</ActionNotice>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Not yet
            </Button>
            <Button
              variant="danger"
              disabled={pending || !reason.trim() || !reverseOn}
              onClick={() => run(() => reverseVoucher(id, reason, reverseOn), (d) => `Reversed by ${(d as { entryNumber: string }).entryNumber}.`)}
            >
              Reverse
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
