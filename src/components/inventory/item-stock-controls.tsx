"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteItemUnit, saveItemUnit, setItemTracking } from "@/actions/inventory";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";

type Tracking = { trackBatches: boolean; trackExpiry: boolean; trackSerials: boolean; barcode: string; reorderQuantity: string };

/**
 * Whether an item keeps batches, expiry dates and serial numbers (owner, 22 Oct 2026). Switched only while none
 * is on hand — so every unit in stock has them, or none does; the server refuses otherwise.
 */
export function ItemTrackingForm({ itemId, initial, hasStock }: { itemId: string; initial: Tracking; hasStock: boolean }) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(initial);
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);
  const [pending, start] = useTransition();
  const locked = hasStock;

  function save() {
    setNotice(null);
    start(async () => {
      const result = await setItemTracking(itemId, {
        trackBatches: value.trackBatches,
        trackExpiry: value.trackBatches && value.trackExpiry,
        trackSerials: value.trackSerials,
        barcode: value.barcode,
        reorderQuantity: value.reorderQuantity === "" ? null : Number(value.reorderQuantity),
      });
      if (!result.ok) {
        setNotice({ tone: "error", message: result.error });
        return;
      }
      setNotice({ tone: "success", message: "Saved." });
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <fieldset className="space-y-1.5" disabled={locked}>
        <legend className="sr-only">Tracking</legend>
        <label className="flex items-center gap-2 text-text">
          <input type="checkbox" checked={value.trackBatches} onChange={(e) => setValue({ ...value, trackBatches: e.target.checked, trackExpiry: e.target.checked && value.trackExpiry })} />
          Keeps batches
        </label>
        <label className={`flex items-center gap-2 ${value.trackBatches ? "text-text" : "text-subtle"}`}>
          <input type="checkbox" disabled={!value.trackBatches} checked={value.trackExpiry} onChange={(e) => setValue({ ...value, trackExpiry: e.target.checked })} />
          …with expiry dates (sold first-to-expire first)
        </label>
        <label className="flex items-center gap-2 text-text">
          <input type="checkbox" checked={value.trackSerials} onChange={(e) => setValue({ ...value, trackSerials: e.target.checked })} />
          Keeps serial numbers, one per unit
        </label>
      </fieldset>
      {locked && <p className="text-xs text-subtle">There&apos;s stock on hand, so batches and serial numbers can&apos;t be switched now — every unit has them, or none does.</p>}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-barcode`}>Barcode</Label>
          <Input id={`${id}-barcode`} value={value.barcode} maxLength={64} onChange={(e) => setValue({ ...value, barcode: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-reorder`}>Reorder quantity</Label>
          <Input id={`${id}-reorder`} type="number" step="0.001" min={0} value={value.reorderQuantity} onChange={(e) => setValue({ ...value, reorderQuantity: e.target.value })} />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <ActionNoticeRegion notice={notice} />
        <Button size="sm" disabled={pending} onClick={save}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

/** Other units the item is bought or sold in — "1 BOX = 12 NOS" — which a document's line can name. */
export function ItemUnitsEditor({ itemId, baseUnit, units, canManage }: { itemId: string; baseUnit: string | null; units: { id: string; unit: string; factor: number }[]; canManage: boolean }) {
  const router = useRouter();
  const id = useId();
  const [unit, setUnit] = useState("");
  const [factor, setFactor] = useState("");
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);
  const [pending, start] = useTransition();
  const base = baseUnit ?? "units";

  function run(work: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, after?: () => void) {
    setNotice(null);
    start(async () => {
      const result = await work();
      if (!result.ok) {
        setNotice({ tone: "error", message: result.error });
        return;
      }
      after?.();
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      {units.length === 0 ? (
        <p className="text-xs text-subtle">Only {base}.</p>
      ) : (
        <ul className="space-y-1">
          {units.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-text">
                1 {u.unit} = {u.factor.toLocaleString("en-IN", { maximumFractionDigits: 6 })} {base}
              </span>
              {canManage && (
                <Button size="icon" variant="ghost" aria-label={`Remove ${u.unit}`} disabled={pending} onClick={() => run(() => deleteItemUnit(u.id))}>
                  <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${id}-unit`} className="text-xs">Unit</Label>
            <Input id={`${id}-unit`} className="h-8 w-24" value={unit} maxLength={8} placeholder="BOX" onChange={(e) => setUnit(e.target.value.toUpperCase())} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-factor`} className="text-xs">holds ({base})</Label>
            <Input id={`${id}-factor`} className="h-8 w-24" type="number" min={0} step="any" value={factor} onChange={(e) => setFactor(e.target.value)} />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending || !unit || !factor}
            onClick={() =>
              run(
                () => saveItemUnit(itemId, unit, Number(factor)),
                () => {
                  setUnit("");
                  setFactor("");
                },
              )
            }
          >
            Add
          </Button>
        </div>
      )}
      <ActionNoticeRegion notice={notice} />
    </div>
  );
}
