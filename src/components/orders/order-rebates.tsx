"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveOrderLoss, setOrderDeal } from "@/actions/order";
import { removeOrderRebate, reopenOrderRebate, saveOrderRebate, writeOffOrderRebate } from "@/actions/rebate";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { CompanyCombobox } from "@/components/ui/company-combobox";
import { dealRegStatusValues, rebateBasisValues, rebatePayerValues, rebateSettlementValues } from "@/lib/validation/order";
import {
  DEAL_REG_LABELS,
  REBATE_BASIS_LABELS,
  REBATE_PAYER_LABELS,
  REBATE_SETTLEMENT_LABELS,
  type DealRegStatusKey,
  type RebateBasisKey,
  type RebatePayerKey,
  type RebateSettlementKey,
} from "@/lib/rebates/rules";
import type { RebateSummary } from "@/lib/rebates/server";
import { formatCurrency } from "@/lib/utils";

/**
 * The order page's backend-rebate islands (src/components/orders/order-detail.tsx decides who sees
 * which; the actions decide again):
 *
 *   · `OrderDealEditor` — the deal registration and deal price, by sales, an approver or purchase;
 *   · `OrderLossApproval` — a manager approves selling below cost (`orders.approveLoss`);
 *   · `OrderRebatesPanel` — the backend rebates, for whoever holds `rebates.view`.
 */

function useAction() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) {
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
  return { isPending, error, run };
}

const money = (n: number) => formatCurrency(String(n));
const dayKey = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

// ─── Deal registration ───────────────────────────────────────────────────────────────────────────

export function OrderDealEditor({
  orderId,
  deal,
}: {
  orderId: string;
  deal: { status: DealRegStatusKey | null; number: string | null; validTo: Date | string | null; price: number | null };
}) {
  const { isPending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string>(deal.status ?? "");
  const [number, setNumber] = useState(deal.number ?? "");
  const [validTo, setValidTo] = useState(dayKey(deal.validTo));
  const [price, setPrice] = useState(deal.price !== null ? String(deal.price) : "");
  const empty = !deal.status && deal.price === null;

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {empty ? "Add" : "Change"}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Deal registration">
        <div className="space-y-3">
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor={`deal-status-${orderId}`} className="text-xs">Deal registration</Label>
              <Select id={`deal-status-${orderId}`} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">None</option>
                {dealRegStatusValues.map((v) => (
                  <option key={v} value={v}>
                    {DEAL_REG_LABELS[v]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`deal-number-${orderId}`} className="text-xs">DR number</Label>
              <Input id={`deal-number-${orderId}`} value={number} onChange={(e) => setNumber(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`deal-valid-${orderId}`} className="text-xs">Valid until</Label>
              <Input id={`deal-valid-${orderId}`} type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`deal-price-${orderId}`} className="text-xs">Deal price per unit</Label>
              <Input id={`deal-price-${orderId}`} type="number" step="0.01" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-subtle">The distributor&apos;s bill is checked against the deal price. Blank fields clear them.</p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={isPending}
            onClick={() =>
              run(
                () => setOrderDeal({ orderId, dealRegStatus: status, dealRegNumber: number, dealRegValidTo: validTo, dealPrice: price }),
                () => setOpen(false),
              )
            }
          >
            {isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

// ─── Selling below cost ──────────────────────────────────────────────────────────────────────────

export function OrderLossApproval({ orderId }: { orderId: string }) {
  const { isPending, error, run } = useAction();
  const [note, setNote] = useState("");
  return (
    <div className="space-y-2">
      {error && <p className="text-sm text-danger">{error}</p>}
      <Label htmlFor={`loss-note-${orderId}`} className="text-xs">Why this negative call is worth taking</Label>
      <Textarea
        id={`loss-note-${orderId}`}
        placeholder="The rebate expected, the account, what it opens up…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button type="button" size="sm" disabled={isPending || note.trim().length < 5} onClick={() => run(() => approveOrderLoss({ orderId, note }), () => setNote(""))}>
        {isPending ? "Approving…" : "Approve selling below cost"}
      </Button>
    </div>
  );
}

// ─── Backend rebates ─────────────────────────────────────────────────────────────────────────────

type RebateRow = RebateSummary["rebates"][number];

type RebateDraft = { basis: RebateBasisKey; value: string; payer: RebatePayerKey; payerCompanyId: string; settlement: RebateSettlementKey; note: string };

function RebateDialog({
  orderId,
  rebate,
  vendors,
  defaultPayerId,
  onClose,
}: {
  orderId: string;
  rebate: RebateRow | null;
  vendors: { id: string; name: string }[];
  defaultPayerId: string | null;
  onClose: () => void;
}) {
  const { isPending, error, run } = useAction();
  const [draft, setDraft] = useState<RebateDraft>(
    rebate
      ? {
          basis: rebate.basis,
          value: String(rebate.basis === "AMOUNT" ? (rebate.amount ?? "") : (rebate.rate ?? "")),
          payer: rebate.payer as RebatePayerKey,
          payerCompanyId: rebate.payerCompany?.id ?? "",
          settlement: rebate.settlement as RebateSettlementKey,
          note: rebate.note ?? "",
        }
      : { basis: "PURCHASE_VALUE", value: "", payer: "DISTRIBUTOR", payerCompanyId: defaultPayerId ?? "", settlement: "CREDIT_NOTE", note: "" },
  );
  const set = <K extends keyof RebateDraft>(key: K, value: RebateDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  return (
    <Dialog open onClose={onClose} title={rebate ? "Change the backend rebate" : "Add a backend rebate"}>
      <div className="space-y-3">
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor={`rb-basis-${orderId}`} className="text-xs">Worked out as</Label>
            <Select id={`rb-basis-${orderId}`} value={draft.basis} onChange={(e) => set("basis", e.target.value as RebateBasisKey)}>
              {rebateBasisValues.map((v) => (
                <option key={v} value={v}>
                  {REBATE_BASIS_LABELS[v]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`rb-value-${orderId}`} className="text-xs">{draft.basis === "AMOUNT" ? "Amount (₹)" : "Percent"}</Label>
            <Input id={`rb-value-${orderId}`} type="number" step="0.001" min={0} value={draft.value} onChange={(e) => set("value", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`rb-payer-${orderId}`} className="text-xs">Paid by</Label>
            <Select id={`rb-payer-${orderId}`} value={draft.payer} onChange={(e) => set("payer", e.target.value as RebatePayerKey)}>
              {rebatePayerValues.map((v) => (
                <option key={v} value={v}>
                  {REBATE_PAYER_LABELS[v]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`rb-settle-${orderId}`} className="text-xs">Comes as</Label>
            <Select id={`rb-settle-${orderId}`} value={draft.settlement} onChange={(e) => set("settlement", e.target.value as RebateSettlementKey)}>
              {rebateSettlementValues.map((v) => (
                <option key={v} value={v}>
                  {REBATE_SETTLEMENT_LABELS[v]}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`rb-company-${orderId}`} className="text-xs">Which company pays it</Label>
          <CompanyCombobox
            id={`rb-company-${orderId}`}
            companies={vendors}
            value={draft.payerCompanyId}
            onSelect={(c) => set("payerCompanyId", c?.id ?? "")}
            placeholder="Distributor or OEM…"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`rb-note-${orderId}`} className="text-xs">Note</Label>
          <Input id={`rb-note-${orderId}`} placeholder="Quarter, scheme, condition…" value={draft.note} onChange={(e) => set("note", e.target.value)} />
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={isPending}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={isPending || draft.value === ""}
          onClick={() =>
            run(
              () =>
                saveOrderRebate({
                  orderId,
                  rebateId: rebate?.id ?? "",
                  rebate: { programmeId: rebate?.programme?.id ?? "", basis: draft.basis, value: draft.value, payer: draft.payer, payerCompanyId: draft.payerCompanyId, settlement: draft.settlement, note: draft.note },
                }),
              onClose,
            )
          }
        >
          {isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </Dialog>
  );
}

function WriteOffDialog({ rebateId, onClose }: { rebateId: string; onClose: () => void }) {
  const { isPending, error, run } = useAction();
  const [reason, setReason] = useState("");
  return (
    <Dialog open onClose={onClose} title="Write the rebate off">
      <div className="space-y-2">
        {error && <p className="text-sm text-danger">{error}</p>}
        <p className="text-sm text-muted">What is still to come stops being due. What has come in already stays received.</p>
        <Label htmlFor={`wo-${rebateId}`} className="text-xs">Why it won&apos;t come</Label>
        <Textarea id={`wo-${rebateId}`} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={isPending}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={isPending || reason.trim().length < 5} onClick={() => run(() => writeOffOrderRebate({ rebateId, reason }), onClose)}>
          {isPending ? "Writing off…" : "Write off"}
        </Button>
      </div>
    </Dialog>
  );
}

export function OrderRebatesPanel({
  orderId,
  summary,
  vendors,
  defaultPayerId,
  canEdit,
  canManage,
}: {
  orderId: string;
  summary: RebateSummary;
  vendors: { id: string; name: string }[];
  defaultPayerId: string | null;
  /** The order is still going ahead, so its rebates can change. */
  canEdit: boolean;
  /** Holds `rebates.manage`: may write a rebate off, or take that back. */
  canManage: boolean;
}) {
  const { isPending, error, run } = useAction();
  const [editing, setEditing] = useState<RebateRow | "new" | null>(null);
  const [writingOff, setWritingOff] = useState<string | null>(null);

  return (
    <div className="space-y-3 text-sm">
      {error && <p className="text-sm text-danger">{error}</p>}
      {summary.rebates.length === 0 && <p className="text-muted">No backend rebate expected on this order.</p>}
      {summary.rebates.map((r) => (
        <div key={r.id} className="space-y-1 rounded-md border border-line p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="font-medium text-text">
              {r.basis === "AMOUNT" ? money(r.amount ?? 0) : `${r.rate}% ${REBATE_BASIS_LABELS[r.basis].replace(/^% /, "")}`}
              {r.programme ? <span className="font-normal text-muted"> · {r.programme.name}</span> : null}
            </span>
            {r.writtenOff ? <Badge tone="default">Written off</Badge> : r.outstanding === 0 && r.received > 0 ? <Badge tone="green">Received</Badge> : null}
          </div>
          <p className="text-muted">
            From {r.payerCompany?.name ?? REBATE_PAYER_LABELS[r.payer as RebatePayerKey].toLowerCase()}, as {REBATE_SETTLEMENT_LABELS[r.settlement as RebateSettlementKey].toLowerCase()}
            {r.note ? ` · ${r.note}` : ""}
          </p>
          <div className="grid grid-cols-3 gap-2 pt-1">
            <div>
              <p className="text-xs text-subtle">Expected</p>
              <p className="text-text">{r.known ? money(r.expected) : "Once the price is known"}</p>
            </div>
            <div>
              <p className="text-xs text-subtle">Received</p>
              <p className="text-text">{money(r.received)}</p>
            </div>
            <div>
              <p className="text-xs text-subtle">Still to come</p>
              <p className={r.outstanding > 0 ? "font-medium text-warning" : "text-text"}>{money(r.outstanding)}</p>
            </div>
          </div>
          {r.allocations.length > 0 && (
            <p className="text-xs text-subtle">
              In from{" "}
              {r.allocations.map((a, i) => (
                <span key={`${a.credit.id}-${i}`}>
                  {i > 0 ? ", " : ""}
                  <a href={`/purchase/vendor-credits/${a.credit.id}`} className="underline">
                    {a.credit.reference}
                  </a>{" "}
                  ({money(a.amount)})
                </span>
              ))}
            </p>
          )}
          {r.writtenOff && r.writeOffReason && <p className="text-xs text-subtle">Written off: {r.writeOffReason}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            {canEdit && !r.writtenOff && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(r)}>
                Change
              </Button>
            )}
            {canEdit && r.received === 0 && (
              <Button type="button" variant="ghost" size="sm" className="text-danger" disabled={isPending} onClick={() => run(() => removeOrderRebate(r.id))}>
                Remove
              </Button>
            )}
            {canManage && !r.writtenOff && r.outstanding > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setWritingOff(r.id)}>
                Write off
              </Button>
            )}
            {canManage && r.writtenOff && (
              <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => reopenOrderRebate(r.id))}>
                Due again
              </Button>
            )}
          </div>
        </div>
      ))}
      {summary.rebates.length > 0 && (
        <div className="grid grid-cols-3 gap-2 border-t border-line pt-3">
          <div>
            <p className="text-xs text-subtle">Expected in all</p>
            <p className="font-medium text-text">{money(summary.totals.expected)}</p>
          </div>
          <div>
            <p className="text-xs text-subtle">Received</p>
            <p className="font-medium text-text">{money(summary.totals.received)}</p>
          </div>
          <div>
            <p className="text-xs text-subtle">Still to come</p>
            <p className="font-medium text-text">{money(summary.totals.outstanding)}</p>
          </div>
        </div>
      )}
      {canEdit && summary.rebates.length < 5 && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing("new")}>
          + Add a rebate
        </Button>
      )}
      {editing && (
        <RebateDialog
          orderId={orderId}
          rebate={editing === "new" ? null : editing}
          vendors={vendors}
          defaultPayerId={defaultPayerId}
          onClose={() => setEditing(null)}
        />
      )}
      {writingOff && <WriteOffDialog rebateId={writingOff} onClose={() => setWritingOff(null)} />}
    </div>
  );
}
