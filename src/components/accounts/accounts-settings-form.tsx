"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveAccountsSettings, type AccountsSettingsView, type SaveAccountsSettingsInput } from "@/actions/accounts-settings";
import { Switch } from "@/components/settings/access/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { formatQuantity, formatRupees } from "@/lib/accounts/money";

type Toggle = Exclude<keyof SaveAccountsSettingsInput, "inventoryAccounting" | "costingMethod" | "quantityDecimals" | "defaultWarehouseId" | "seriesPrefixes">;

const TOGGLES: { key: Toggle; title: string; hint: string }[] = [
  { key: "invoiceIssuesStock", title: "Tax invoices issue stock", hint: "Issuing an invoice takes its goods out of the warehouse — at their cost, batch by soonest expiry." },
  { key: "billReceivesStock", title: "Vendor bills receive stock", hint: "A bill with no goods receipt against it brings its goods in at the bill's price. A bill matched to a GRN doesn't receive twice." },
  { key: "creditNoteReturnsStock", title: "Credit notes return stock", hint: "Goods a customer sends back come in at what they cost when sold." },
  { key: "reserveOnOrderApproval", title: "Reserve stock when an order is approved", hint: "Approved orders hold what is on hand for themselves, so two orders can't promise the last unit." },
  { key: "allowNegativeStock", title: "Allow negative stock", hint: "Lets a sale go out before its stock is entered. Never for items kept in batches. Off is safer." },
  { key: "adjustmentApprovalRequired", title: "Adjustments and counts need approval", hint: "A second person with “Approve stock adjustments” approves before stock is written up or down." },
  { key: "voucherApprovalRequired", title: "Vouchers need approval", hint: "Payment, receipt, contra and journal vouchers are approved by somebody else before they are posted." },
];

export function AccountsSettingsForm({ initial }: { initial: AccountsSettingsView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [form, setForm] = useState<SaveAccountsSettingsInput>({
    inventoryAccounting: initial.inventoryAccounting,
    costingMethod: initial.costingMethod,
    allowNegativeStock: initial.allowNegativeStock,
    invoiceIssuesStock: initial.invoiceIssuesStock,
    billReceivesStock: initial.billReceivesStock,
    creditNoteReturnsStock: initial.creditNoteReturnsStock,
    reserveOnOrderApproval: initial.reserveOnOrderApproval,
    voucherApprovalRequired: initial.voucherApprovalRequired,
    adjustmentApprovalRequired: initial.adjustmentApprovalRequired,
    quantityDecimals: initial.quantityDecimals,
    defaultWarehouseId: initial.defaultWarehouseId,
    seriesPrefixes: Object.fromEntries(initial.series.map((s) => [s.key, s.prefix])),
  });
  const set = <K extends keyof SaveAccountsSettingsInput>(key: K, value: SaveAccountsSettingsInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const stockOnHand = initial.onHand.quantity !== 0;
  const switchingToPerpetual = initial.inventoryAccounting === "PERIODIC" && form.inventoryAccounting === "PERPETUAL";

  function save() {
    if (switchingToPerpetual && !window.confirm(`Switch to perpetual inventory? Stock on hand (${formatRupees(initial.onHand.value)}) is posted to Stock in Hand against Opening Balance Equity today, and every stock movement posts to the ledger from now on. This can't be switched back.`)) return;
    setNotice(null);
    start(async () => {
      const res = await saveAccountsSettings(form);
      if (!res.ok) {
        setNotice({ tone: "error", text: res.error });
        return;
      }
      setNotice({ tone: "success", text: res.data.openingEntry ? `Saved. Opening stock posted as ${res.data.openingEntry}.` : "Saved." });
      router.refresh();
    });
  }

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardContent className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-text">Inventory accounting</h2>
            <p className="mt-0.5 text-xs text-muted">
              On hand now: {formatQuantity(initial.onHand.quantity)} unit(s) worth {formatRupees(initial.onHand.value)}.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className={`rounded-base border p-3 text-sm ${form.inventoryAccounting === "PERIODIC" ? "border-brand bg-brand-subtle/40" : "border-line"}`}>
              <input
                type="radio"
                name="inventoryAccounting"
                className="mr-2"
                checked={form.inventoryAccounting === "PERIODIC"}
                disabled={initial.inventoryAccounting === "PERPETUAL"}
                onChange={() => set("inventoryAccounting", "PERIODIC")}
              />
              <span className="font-medium text-text">Periodic</span>
              <span className="mt-1 block text-xs text-muted">Purchases are expensed as billed; stock is kept in quantities and valued in the stock reports. How the books have always worked.</span>
            </label>
            <label className={`rounded-base border p-3 text-sm ${form.inventoryAccounting === "PERPETUAL" ? "border-brand bg-brand-subtle/40" : "border-line"} ${initial.ledger ? "" : "opacity-60"}`}>
              <input
                type="radio"
                name="inventoryAccounting"
                className="mr-2"
                checked={form.inventoryAccounting === "PERPETUAL"}
                disabled={!initial.ledger && initial.inventoryAccounting !== "PERPETUAL"}
                onChange={() => set("inventoryAccounting", "PERPETUAL")}
              />
              <span className="font-medium text-text">Perpetual</span>
              <span className="mt-1 block text-xs text-muted">
                Every receipt, sale, return and adjustment posts to Stock in Hand and Cost of Goods Sold as it happens.
                {initial.ledger ? " Once on, it stays on." : " Needs Accounting to be on."}
              </span>
            </label>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <Label htmlFor="costing">Costing method</Label>
              <Select id="costing" value={form.costingMethod} disabled={stockOnHand} onChange={(e) => set("costingMethod", e.target.value as SaveAccountsSettingsInput["costingMethod"])}>
                <option value="WEIGHTED_AVERAGE">Weighted average</option>
                <option value="FIFO">FIFO (first in, first out)</option>
              </Select>
              {stockOnHand && <p className="mt-1 text-xs text-subtle">Changes only while nothing is on hand.</p>}
            </div>
            <div>
              <Label htmlFor="decimals">Quantity decimals</Label>
              <Select id="decimals" value={String(form.quantityDecimals)} onChange={(e) => set("quantityDecimals", Number(e.target.value))}>
                {[0, 1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="wh">Default warehouse</Label>
              <Select id="wh" value={form.defaultWarehouseId ?? ""} onChange={(e) => set("defaultWarehouseId", e.target.value || null)}>
                <option value="">The one marked default</option>
                {initial.warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} — {w.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="text-sm font-semibold text-text">What moves stock, and who approves</h2>
          <p className="mt-0.5 text-xs text-muted">All off until you turn them on, so nothing changes for documents already issued.</p>
          <ul className="mt-3 divide-y divide-line">
            {TOGGLES.map((t) => (
              <li key={t.key} className="flex items-start justify-between gap-4 py-3">
                <div>
                  <p className="text-sm font-medium text-text">{t.title}</p>
                  <p className="mt-0.5 text-xs text-muted">{t.hint}</p>
                </div>
                <Switch checked={form[t.key]} onChange={(next) => set(t.key, next)} label={t.title} />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="text-sm font-semibold text-text">Voucher numbering</h2>
          <p className="mt-0.5 text-xs text-muted">Each series counts from 0001 every financial year. A new prefix applies to numbers taken from now on.</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-2 pr-4">Series</th>
                  <th className="py-2 pr-4">Prefix</th>
                  <th className="py-2">Next number</th>
                </tr>
              </thead>
              <tbody>
                {initial.series.map((s) => (
                  <tr key={s.key} className="border-t border-line">
                    <td className="py-2 pr-4 text-text">{s.label}</td>
                    <td className="py-2 pr-4">
                      <Input
                        aria-label={`${s.label} prefix`}
                        value={form.seriesPrefixes[s.key] ?? ""}
                        placeholder={s.defaultPrefix}
                        maxLength={8}
                        className="h-8 w-28 font-mono uppercase"
                        onChange={(e) => set("seriesPrefixes", { ...form.seriesPrefixes, [s.key]: e.target.value })}
                      />
                    </td>
                    <td className="py-2 font-mono text-xs text-muted">{s.next}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
        <ActionNoticeRegion notice={notice ? { tone: notice.tone, message: notice.text } : null} />
      </div>
    </div>
  );
}
