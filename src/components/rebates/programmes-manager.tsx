"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteRebateProgramme, saveRebateProgramme } from "@/actions/rebate";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { CompanyCombobox } from "@/components/ui/company-combobox";
import { rebatePayerValues, rebateSettlementValues } from "@/lib/validation/order";
import { REBATE_BASIS_LABELS, REBATE_PAYER_LABELS, REBATE_SETTLEMENT_LABELS, type RebatePayerKey, type RebateSettlementKey } from "@/lib/rebates/rules";

type Option = { id: string; name: string };
type Programme = {
  id: string;
  name: string;
  basis: "PURCHASE_VALUE" | "SALE_VALUE" | "AMOUNT";
  rate: number | string;
  needsDealRegistration: boolean;
  payer: RebatePayerKey;
  settlement: RebateSettlementKey;
  validFrom: string | Date | null;
  validTo: string | Date | null;
  active: boolean;
  notes: string | null;
  brand: Option | null;
  vendor: Option | null;
  _count: { rebates: number };
};

const dayKey = (d: string | Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

type Draft = {
  id: string;
  name: string;
  brandId: string;
  vendorId: string;
  basis: "PURCHASE_VALUE" | "SALE_VALUE";
  rate: string;
  needsDealRegistration: boolean;
  payer: RebatePayerKey;
  settlement: RebateSettlementKey;
  validFrom: string;
  validTo: string;
  active: boolean;
  notes: string;
};

const blank: Draft = {
  id: "",
  name: "",
  brandId: "",
  vendorId: "",
  basis: "PURCHASE_VALUE",
  rate: "",
  needsDealRegistration: false,
  payer: "DISTRIBUTOR",
  settlement: "CREDIT_NOTE",
  validFrom: "",
  validTo: "",
  active: true,
  notes: "",
};

/** The rebate programmes, and — for whoever holds `rebates.manage` — adding, changing and removing them. */
export function RebateProgrammesManager({
  programmes,
  canManage,
  brands,
  vendors,
}: {
  programmes: Programme[];
  canManage: boolean;
  brands: Option[];
  vendors: Option[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));

  function edit(p: Programme) {
    setError(null);
    setDraft({
      id: p.id,
      name: p.name,
      brandId: p.brand?.id ?? "",
      vendorId: p.vendor?.id ?? "",
      basis: p.basis === "SALE_VALUE" ? "SALE_VALUE" : "PURCHASE_VALUE",
      rate: String(p.rate),
      needsDealRegistration: p.needsDealRegistration,
      payer: p.payer,
      settlement: p.settlement,
      validFrom: dayKey(p.validFrom),
      validTo: dayKey(p.validTo),
      active: p.active,
      notes: p.notes ?? "",
    });
  }

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

  return (
    <div className="space-y-4">
      {error && !draft && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      {canManage && (
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={() => { setError(null); setDraft({ ...blank }); }}>
            Add a programme
          </Button>
        </div>
      )}
      {programmes.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted">
            No rebate programmes yet{canManage ? " — add one for each rebate an OEM or distributor pays as a rule" : ""}.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {programmes.map((p) => (
            <Card key={p.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium text-text">
                    {p.name} {!p.active && <Badge tone="default">Off</Badge>}
                  </p>
                  <p className="text-muted">
                    {String(p.rate)}% {REBATE_BASIS_LABELS[p.basis].replace(/^% /, "")} · {p.brand ? p.brand.name : "any brand"}
                    {p.vendor ? ` through ${p.vendor.name}` : ""} · paid by {REBATE_PAYER_LABELS[p.payer].toLowerCase()} as{" "}
                    {REBATE_SETTLEMENT_LABELS[p.settlement].toLowerCase()}
                    {p.needsDealRegistration ? " · with an approved deal registration" : ""}
                  </p>
                  {(p.validFrom || p.validTo) && (
                    <p className="text-xs text-subtle">
                      {p.validFrom ? `From ${dayKey(p.validFrom)}` : "Until"} {p.validTo ? `${p.validFrom ? "to " : ""}${dayKey(p.validTo)}` : ""}
                    </p>
                  )}
                  {p.notes && <p className="text-xs text-subtle">{p.notes}</p>}
                  <p className="text-xs text-subtle">
                    On {p._count.rebates} order{p._count.rebates === 1 ? "" : "s"}
                  </p>
                </div>
                {canManage && (
                  <div className="flex gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => edit(p)}>
                      Change
                    </Button>
                    <Button type="button" variant="ghost" size="sm" className="text-danger" disabled={isPending} onClick={() => run(() => deleteRebateProgramme(p.id))}>
                      Remove
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {draft && (
        <Dialog open onClose={() => setDraft(null)} title={draft.id ? "Change the programme" : "Add a rebate programme"}>
          <div className="space-y-3">
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="space-y-1">
              <Label htmlFor="rp-name" className="text-xs">Name</Label>
              <Input id="rp-name" placeholder="Adobe VIP deal registration" value={draft.name} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="rp-brand" className="text-xs">OEM (brand)</Label>
                <Select id="rp-brand" value={draft.brandId} onChange={(e) => set("brandId", e.target.value)}>
                  <option value="">Any brand</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="rp-vendor" className="text-xs">Through distributor</Label>
                <CompanyCombobox id="rp-vendor" companies={vendors} value={draft.vendorId} onSelect={(c) => set("vendorId", c?.id ?? "")} placeholder="Any distributor" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rp-basis" className="text-xs">Worked out as</Label>
                <Select id="rp-basis" value={draft.basis} onChange={(e) => set("basis", e.target.value as Draft["basis"])}>
                  <option value="PURCHASE_VALUE">{REBATE_BASIS_LABELS.PURCHASE_VALUE}</option>
                  <option value="SALE_VALUE">{REBATE_BASIS_LABELS.SALE_VALUE}</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="rp-rate" className="text-xs">Percent</Label>
                <Input id="rp-rate" type="number" step="0.001" min={0} max={100} value={draft.rate} onChange={(e) => set("rate", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rp-payer" className="text-xs">Paid by</Label>
                <Select id="rp-payer" value={draft.payer} onChange={(e) => set("payer", e.target.value as RebatePayerKey)}>
                  {rebatePayerValues.map((v) => (
                    <option key={v} value={v}>
                      {REBATE_PAYER_LABELS[v]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="rp-settle" className="text-xs">Comes as</Label>
                <Select id="rp-settle" value={draft.settlement} onChange={(e) => set("settlement", e.target.value as RebateSettlementKey)}>
                  {rebateSettlementValues.map((v) => (
                    <option key={v} value={v}>
                      {REBATE_SETTLEMENT_LABELS[v]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="rp-from" className="text-xs">From</Label>
                <Input id="rp-from" type="date" value={draft.validFrom} onChange={(e) => set("validFrom", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rp-to" className="text-xs">To</Label>
                <Input id="rp-to" type="date" value={draft.validTo} onChange={(e) => set("validTo", e.target.value)} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={draft.needsDealRegistration} onChange={(e) => set("needsDealRegistration", e.target.checked)} />
              Only on an order whose deal registration is approved
            </label>
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={draft.active} onChange={(e) => set("active", e.target.checked)} />
              On — suggested on new orders
            </label>
            <div className="space-y-1">
              <Label htmlFor="rp-notes" className="text-xs">Notes</Label>
              <Textarea id="rp-notes" placeholder="Paid quarterly, claim by the 15th…" value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={isPending || !draft.name.trim() || !draft.rate} onClick={() => run(() => saveRebateProgramme(draft), () => setDraft(null))}>
              {isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
