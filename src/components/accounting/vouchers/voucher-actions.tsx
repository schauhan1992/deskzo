"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { VoucherStatus, VoucherType } from "@prisma/client";
import { adjacentVoucher, approveVoucher, cancelVoucher, postVoucher, returnVoucher, reverseVoucher, submitVoucher } from "@/actions/vouchers";
import { useClock } from "@/components/time/clock-provider";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { shortcutNotice, useShortcuts } from "@/components/shortcuts/use-shortcuts";
import { copyVoucher, type VoucherCopy } from "@/lib/shortcuts/clipboard";
import { voucherStatusLabels } from "@/lib/accounts/vouchers";

type Step = "post" | "cancel" | "reverse" | "return" | null;

type Choice = { id: string; name: string };

/** What F12 copies of this voucher — what its form would have typed. */
export type VoucherCopySource = {
  type: VoucherType;
  narration: string;
  reference: string;
  company: Choice | null;
  lines: { accountId: string; debit: number; credit: number; company: Choice | null; departmentId: string | null; branchId: string | null; narration: string | null }[];
};

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
  copySource,
}: {
  id: string;
  number: string;
  status: VoucherStatus;
  can: { create: boolean; approve: boolean; post: boolean };
  approvalRequired: boolean;
  isCreator: boolean;
  copySource: VoucherCopySource;
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
  const mayReverse = status === "POSTED" && can.post;
  const stands = voucherStatusLabels[status].toLowerCase();

  /** Page Up / Page Down: the voucher listed above or below this one. */
  function go(direction: "previous" | "next") {
    void adjacentVoucher(id, direction).then((next) =>
      next ? router.push(`/accounting/vouchers/${next}`) : shortcutNotice(direction === "previous" ? "This is the first voucher in the list." : "This is the last voucher in the list."),
    );
  }

  // BUSY's keys on a voucher's page (src/lib/shortcuts/busy.ts, scope "record"). Nothing here deletes: F8 cancels
  // a voucher not yet in the books, and reverses one that is.
  useShortcuts("record", {
    "previous-record": () => go("previous"),
    "next-record": () => go("next"),
    modify: () => {
      if (!draft) return shortcutNotice(`Only a draft is modified — this one is ${stands}.${status === "POSTED" ? " A posted voucher is put right by reversing it." : ""}`);
      if (!can.create) return shortcutNotice("Modifying vouchers needs “Write vouchers”.");
      router.push(`/accounting/vouchers/${id}/edit`);
    },
    "delete-record": () => {
      if (mayCancel) return setStep("cancel");
      if (mayReverse) return setStep("reverse");
      shortcutNotice(
        status === "POSTED"
          ? "Reversing a posted voucher needs “Write and reverse journal entries”."
          : status === "CANCELLED" || status === "REVERSED"
            ? `It's already ${stands} — and stays on record.`
            : "Cancelling vouchers needs “Write vouchers” or “Approve vouchers”.",
      );
    },
    "cancel-record": () => {
      if (mayCancel) return setStep("cancel");
      shortcutNotice(
        status === "POSTED"
          ? "A posted voucher isn't cancelled — it's reversed (F8)."
          : status === "CANCELLED" || status === "REVERSED"
            ? `It's already ${stands}.`
            : "Cancelling vouchers needs “Write vouchers” or “Approve vouchers”.",
      );
    },
    "copy-record": () => {
      const parties = new Map<string, Choice>();
      for (const c of [copySource.company, ...copySource.lines.map((l) => l.company)]) if (c) parties.set(c.id, c);
      const copy: VoucherCopy = {
        kind: "voucher",
        type: copySource.type,
        narration: copySource.narration,
        reference: copySource.reference,
        companyId: copySource.company?.id ?? null,
        lines: copySource.lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit ? String(l.debit) : "",
          credit: l.credit ? String(l.credit) : "",
          companyId: l.company?.id ?? null,
          departmentId: l.departmentId,
          branchId: l.branchId,
          narration: l.narration ?? "",
        })),
        copiedFrom: number,
        copiedAt: new Date().toISOString(),
        parties: [...parties.values()],
      };
      shortcutNotice(copyVoucher(copy) ? `Copied ${number} — Alt + F12 on a new voucher fills it in.` : "This browser won't keep a copy — its storage is turned off.");
    },
  });
  const buttons = [
    draft && can.create && (
      <Link key="edit" href={`/accounting/vouchers/${id}/edit`} title="Modify (Alt+M)" aria-keyshortcuts="Alt+M" className="inline-flex h-9 items-center rounded-base border border-line-strong bg-surface px-3.5 text-sm font-medium text-text shadow-sm hover:bg-surface-sunken">
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
      <Button key="reverse" variant="secondary" disabled={pending} onClick={() => setStep("reverse")} title="Reverse (F8)" aria-keyshortcuts="F8">
        Reverse
      </Button>
    ),
    mayCancel && (
      <Button key="cancel" variant="ghost" disabled={pending} onClick={() => setStep("cancel")} title="Cancel voucher (Alt+X, F8)" aria-keyshortcuts="Alt+X F8">
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
