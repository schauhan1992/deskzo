"use client";

import { useId, useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { consoleSaveInvoicing } from "@/actions/platform/console-offline";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { GST_STATE_OPTIONS } from "@/lib/gst-engine";

/**
 * The seller's details on Deskzo's own GST tax invoices (src/lib/billing/tax-invoice.ts): the
 * registered name, address and state, the GSTIN and PAN, the SAC and the series' prefix. An owner
 * sets them; saving issues every paid invoice that was waiting for them, oldest first. The server
 * checks them as a whole — the GSTIN must be the chosen state's.
 */
export type SellerValues = { name: string; address: string; state: string; gstin: string; pan: string; sac: string; prefix: string };

export function InvoicingSettingsForm({ initial, waiting }: { initial: SellerValues; waiting: number }) {
  const id = useId();
  const action = useConsoleAction<{ issued: number }>();
  const [v, setV] = useState<SellerValues>(initial);
  const set = (key: keyof SellerValues) => (e: { target: { value: string } }) => {
    action.reset();
    setV((d) => ({ ...d, [key]: e.target.value }));
  };
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dirty || action.pending) return;
    action.run(() => consoleSaveInvoicing(v), {
      success: (d) => (d.issued ? `Invoicing details saved — ${d.issued} tax invoice${d.issued === 1 ? "" : "s"} issued and mailed.` : "Invoicing details saved."),
    });
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {waiting > 0 && <p className="rounded-base bg-warning-bg px-3 py-2 text-sm text-warning">{`${waiting} paid invoice${waiting === 1 ? " is" : "s are"} waiting for these details before ${waiting === 1 ? "its" : "their"} tax invoice can be issued.`}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${id}-name`}>Registered name</Label>
          <Input id={`${id}-name`} value={v.name} onChange={set("name")} maxLength={200} autoComplete="organization" />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${id}-address`}>Registered address</Label>
          <Textarea id={`${id}-address`} rows={3} value={v.address} onChange={set("address")} maxLength={500} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-state`}>State</Label>
          <Select id={`${id}-state`} value={v.state} onChange={set("state")}>
            <option value="">Choose…</option>
            {GST_STATE_OPTIONS.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-gstin`}>GSTIN</Label>
          <Input id={`${id}-gstin`} value={v.gstin} onChange={(e) => set("gstin")({ target: { value: e.target.value.toUpperCase() } })} maxLength={15} autoComplete="off" className="font-mono" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-pan`}>PAN (optional)</Label>
          <Input id={`${id}-pan`} value={v.pan} onChange={(e) => set("pan")({ target: { value: e.target.value.toUpperCase() } })} maxLength={10} autoComplete="off" className="font-mono" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-sac`}>SAC</Label>
          <Input id={`${id}-sac`} value={v.sac} onChange={set("sac")} maxLength={8} inputMode="numeric" className="font-mono" />
          <p className="text-[11px] text-muted">9983 for software as a service — your CA confirms it.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-prefix`}>Number prefix</Label>
          <Input id={`${id}-prefix`} value={v.prefix} onChange={(e) => set("prefix")({ target: { value: e.target.value.toUpperCase() } })} maxLength={6} className="font-mono" />
          <p className="text-[11px] text-muted">{`Invoices are ${v.prefix || "DZ"}/2026-27/0001 onwards, credit notes ${v.prefix || "DZ"}/CN/2026-27/0001 — a new series each financial year.`}</p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
        {dirty && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setV(initial)} disabled={action.pending}>
            Discard
          </Button>
        )}
        <Button type="submit" size="sm" disabled={!dirty} aria-busy={action.pending || undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Save
        </Button>
      </div>
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
    </form>
  );
}
