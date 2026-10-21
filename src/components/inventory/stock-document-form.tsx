"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { StockDocumentType } from "@prisma/client";
import { Plus, Trash2 } from "lucide-react";
import {
  batchesOnHand,
  countSheet,
  openPurchaseOrders,
  receiptLinesFromPurchaseOrder,
  saveStockDocument,
  searchStockItems,
  searchVendors,
  type SaveStockDocumentInput,
} from "@/actions/inventory";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { qty, rupees, stockTypeHint, stockTypeLabel, stockTypeNew } from "@/components/inventory/labels";

/**
 * Writing a stock voucher (owner, 22 Oct 2026): one form for the five kinds, showing each the columns it
 * needs. Saving makes a draft — nothing moves until it is posted from its own page — and the server checks a
 * draft as posting would (src/actions/inventory.ts saveStockDocument), so what it refuses is said here.
 */

export type FormItem = { id: string; name: string; sku: string | null; unit: string | null; costPrice?: number | null; trackBatches: boolean; trackExpiry: boolean; trackSerials: boolean };
type Batch = { id: string; batchNo: string; expiryDate: Date | string | null; quantity: number };

export type FormLine = {
  key: string;
  item: FormItem | null;
  quantity: string;
  rejectedQty: string;
  countedQty: string;
  systemQty: number | null;
  orderedQty: number | null;
  receivedBefore: number | null;
  unitCost: string;
  poLineId: string | null;
  batchId: string;
  batchNo: string;
  mfgDate: string;
  expiryDate: string;
  serials: string;
  note: string;
};

export type StockFormInitial = {
  id?: string;
  number?: string;
  date: string;
  warehouseId: string;
  toWarehouseId: string;
  vendor: { id: string; name: string } | null;
  purchaseOrder: { id: string; docNumber: string } | null;
  billId: string | null;
  reference: string;
  reason: string;
  notes: string;
  lines: FormLine[];
};

let seq = 0;
const newKey = () => `l${Date.now().toString(36)}${(seq += 1)}`;

export function emptyLine(item: FormItem | null = null): FormLine {
  return {
    key: newKey(),
    item,
    quantity: "",
    rejectedQty: "",
    countedQty: "",
    systemQty: null,
    orderedQty: null,
    receivedBefore: null,
    unitCost: item?.costPrice != null ? String(item.costPrice) : "",
    poLineId: null,
    batchId: "",
    batchNo: "",
    mfgDate: "",
    expiryDate: "",
    serials: "",
    note: "",
  };
}

const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "");

export function StockDocumentForm({
  type,
  initial,
  warehouses,
}: {
  type: StockDocumentType;
  initial: StockFormInitial;
  warehouses: { id: string; name: string; code: string; isDefault: boolean }[];
}) {
  const router = useRouter();
  const id = useId();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(initial.date);
  const [warehouseId, setWarehouseId] = useState(initial.warehouseId);
  const [toWarehouseId, setToWarehouseId] = useState(initial.toWarehouseId);
  const [vendor, setVendor] = useState(initial.vendor);
  const [purchaseOrder, setPurchaseOrder] = useState(initial.purchaseOrder);
  const [reference, setReference] = useState(initial.reference);
  const [reason, setReason] = useState(initial.reason);
  const [notes, setNotes] = useState(initial.notes);
  const [lines, setLines] = useState<FormLine[]>(initial.lines.length ? initial.lines : [emptyLine()]);
  const [loading, setLoading] = useState<string | null>(null);

  const isGrn = type === "GRN";
  const isCount = type === "PHYSICAL_COUNT";
  const isAdjustment = type === "ADJUSTMENT";
  const needsVendor = type === "GRN" || type === "PURCHASE_RETURN";
  const reasonRequired = type === "ADJUSTMENT" || type === "PURCHASE_RETURN";

  const patch = (key: string, change: Partial<FormLine>) => setLines((all) => all.map((l) => (l.key === key ? { ...l, ...change } : l)));
  const remove = (key: string) => setLines((all) => (all.length > 1 ? all.filter((l) => l.key !== key) : [emptyLine()]));
  /** Whether a line brings stock in — its batch is typed, rather than picked from what's on hand. */
  const incoming = (l: FormLine) => isGrn || (isAdjustment && Number(l.quantity) > 0);

  async function choosePurchaseOrder(po: { id: string; docNumber: string } | null) {
    setPurchaseOrder(po);
    if (!po) return;
    setLoading("Reading the purchase order…");
    try {
      const got = await receiptLinesFromPurchaseOrder(po.id);
      if (!got) {
        setError("That purchase order can't be read.");
        return;
      }
      setVendor({ id: got.companyId, name: got.companyName });
      const fromPo = got.lines
        .filter((l) => l.pending > 0)
        .map((l) => ({
          ...emptyLine({ id: l.itemId, name: l.name, sku: null, unit: l.unit, trackBatches: l.trackBatches, trackExpiry: l.trackExpiry, trackSerials: l.trackSerials }),
          quantity: String(l.pending),
          orderedQty: l.ordered,
          receivedBefore: l.received,
          unitCost: String(l.unitCost),
          poLineId: l.poLineId,
        }));
      setLines(fromPo.length ? fromPo : [emptyLine()]);
      if (!fromPo.length) setError(`Everything on ${got.docNumber} that keeps stock has been received.`);
      else setError(null);
    } finally {
      setLoading(null);
    }
  }

  async function loadCountSheet() {
    if (!warehouseId) return;
    setLoading("Reading what the books say…");
    try {
      const rows = await countSheet(warehouseId);
      setLines(
        rows.length
          ? rows.map((r) => ({
              ...emptyLine({ id: r.itemId, name: r.name, sku: r.sku, unit: r.unit, trackBatches: r.trackBatches, trackExpiry: r.trackExpiry, trackSerials: r.trackSerials }),
              unitCost: "",
              systemQty: r.systemQty,
              batchId: r.batchId ?? "",
              batchNo: r.batchNo ?? "",
            }))
          : [emptyLine()],
      );
      if (!rows.length) setError("The books show nothing in this warehouse to count.");
      else setError(null);
    } finally {
      setLoading(null);
    }
  }

  function submit() {
    setError(null);
    const input: SaveStockDocumentInput = {
      id: initial.id,
      type,
      date,
      warehouseId,
      toWarehouseId: type === "TRANSFER" ? toWarehouseId : null,
      companyId: needsVendor ? (vendor?.id ?? null) : null,
      purchaseOrderId: isGrn ? (purchaseOrder?.id ?? null) : null,
      billId: initial.billId,
      reference,
      reason,
      notes,
      lines: lines
        .filter((l) => l.item)
        .map((l) => ({
          itemId: l.item!.id,
          quantity: isCount ? null : l.quantity,
          rejectedQty: isGrn ? l.rejectedQty : null,
          countedQty: isCount ? l.countedQty : null,
          orderedQty: l.orderedQty,
          unitCost: isGrn || isAdjustment ? l.unitCost : null,
          poLineId: l.poLineId,
          batchId: l.item!.trackBatches && !incoming(l) ? l.batchId || null : null,
          batchNo: l.item!.trackBatches && incoming(l) ? l.batchNo : null,
          mfgDate: l.item!.trackBatches && incoming(l) ? l.mfgDate || null : null,
          expiryDate: l.item!.trackBatches && incoming(l) ? l.expiryDate || null : null,
          serialNumbers: l.item!.trackSerials && !isCount ? l.serials : null,
          note: l.note,
        })),
    };
    start(async () => {
      const result = await saveStockDocument(input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/items/stock/${result.data.id}`);
      router.refresh();
    });
  }

  const others = warehouses.filter((w) => w.id !== warehouseId);
  const hasBatchOrSerial = lines.some((l) => l.item?.trackBatches || l.item?.trackSerials);

  return (
    <div className="space-y-4">
      <div>
        <Link href={isGrn ? "/items/receipts" : "/items/stock"} className="text-sm text-muted hover:text-text">
          ← {isGrn ? "Goods receipts" : "Stock vouchers"}
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">
          {initial.id ? `Edit ${stockTypeLabel[type].toLowerCase()} ${initial.number ?? ""}` : stockTypeNew[type]}
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">{stockTypeHint[type]} Saving keeps it as a draft; it moves stock when posted.</p>
      </div>

      <Card>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor={`${id}-date`}>Date</Label>
            <Input id={`${id}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-wh`}>{type === "TRANSFER" ? "From warehouse" : "Warehouse"}</Label>
            <Select id={`${id}-wh`} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.code})
                </option>
              ))}
            </Select>
          </div>
          {type === "TRANSFER" && (
            <div className="space-y-1">
              <Label htmlFor={`${id}-to`}>To warehouse</Label>
              <Select id={`${id}-to`} value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)}>
                <option value="">Choose…</option>
                {others.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.code})
                  </option>
                ))}
              </Select>
            </div>
          )}
          {isGrn && (
            <div className="space-y-1">
              <Label htmlFor={`${id}-po`}>Against purchase order</Label>
              <PurchaseOrderPicker inputId={`${id}-po`} value={purchaseOrder} onChange={choosePurchaseOrder} />
            </div>
          )}
          {needsVendor && (
            <div className="space-y-1">
              <Label htmlFor={`${id}-vendor`}>Vendor</Label>
              {purchaseOrder ? (
                <p className="flex h-9 items-center text-sm text-text">{vendor?.name ?? "—"}</p>
              ) : (
                <VendorPicker inputId={`${id}-vendor`} value={vendor} onChange={setVendor} />
              )}
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor={`${id}-ref`}>{isGrn ? "Vendor's challan / invoice no." : type === "TRANSFER" ? "Carrier / reference" : "Reference"}</Label>
            <Input id={`${id}-ref`} value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor={`${id}-reason`}>
              Reason{reasonRequired ? "" : " (optional)"}
            </Label>
            <Input
              id={`${id}-reason`}
              value={reason}
              maxLength={300}
              placeholder={isAdjustment ? "Damaged in the store, found in the back room, expired…" : type === "PURCHASE_RETURN" ? "Wrong model, damaged on arrival…" : ""}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="space-y-1 sm:col-span-2 lg:col-span-4">
            <Label htmlFor={`${id}-notes`}>Notes (optional)</Label>
            <Textarea id={`${id}-notes`} rows={2} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-text">Items</span>
          <div className="flex flex-wrap items-center gap-2">
            {isCount && (
              <Button type="button" size="sm" variant="secondary" onClick={loadCountSheet} disabled={!!loading}>
                Load count sheet
              </Button>
            )}
            {isCount && lines.some((l) => l.systemQty != null && l.countedQty === "") && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setLines((all) => all.map((l) => (l.countedQty === "" && l.systemQty != null ? { ...l, countedQty: String(l.systemQty) } : l)))}
              >
                Fill blanks with the books&apos; quantity
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && <p className="text-xs text-muted">{loading}</p>}
          {isAdjustment && <p className="text-xs text-muted">A positive quantity is stock found; a negative one is stock missing, damaged or written off.</p>}
          {isCount && <p className="text-xs text-muted">Enter what was counted. Posting compares it with what the books say at that moment, and adjusts by the difference.</p>}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-1.5 pr-2">Item</th>
                  {isGrn && purchaseOrder && <th className="px-2 py-1.5 text-right">Ordered / received</th>}
                  {isCount && <th className="px-2 py-1.5 text-right">Books</th>}
                  <th className="px-2 py-1.5">{isGrn ? "Accepted" : isCount ? "Counted" : isAdjustment ? "Change (±)" : "Quantity"}</th>
                  {isGrn && <th className="px-2 py-1.5">Rejected</th>}
                  {(isGrn || isAdjustment) && <th className="px-2 py-1.5">Unit cost (₹)</th>}
                  <th className="py-1.5 pl-2" aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <LineRow
                    key={l.key}
                    n={i + 1}
                    line={l}
                    type={type}
                    warehouseId={warehouseId}
                    showPo={isGrn && !!purchaseOrder}
                    incoming={incoming(l)}
                    onChange={(c) => patch(l.key, c)}
                    onRemove={() => remove(l.key)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={() => setLines((all) => [...all, emptyLine()])}>
            <Plus aria-hidden="true" className="h-3.5 w-3.5" /> Add a line
          </Button>
          {hasBatchOrSerial && (
            <p className="text-xs text-subtle">
              Items that keep batches need a batch number{isGrn ? " (and an expiry date where they keep one)" : ""}; items that keep serial numbers need one per unit.
              {!isGrn && !isAdjustment && " Leave the batch empty and it is taken first-to-expire first."}
            </p>
          )}
        </CardContent>
      </Card>

      {error && <ActionNotice tone="error">{error}</ActionNotice>}
      <div className="flex flex-wrap justify-end gap-2">
        <Link href={initial.id ? `/items/stock/${initial.id}` : isGrn ? "/items/receipts" : "/items/stock"}>
          <Button type="button" variant="secondary">
            Cancel
          </Button>
        </Link>
        <Button type="button" onClick={submit} disabled={pending || !!loading}>
          {pending ? "Saving…" : "Save draft"}
        </Button>
      </div>
    </div>
  );
}

function LineRow({
  n,
  line,
  type,
  warehouseId,
  showPo,
  incoming,
  onChange,
  onRemove,
}: {
  n: number;
  line: FormLine;
  type: StockDocumentType;
  warehouseId: string;
  showPo: boolean;
  incoming: boolean;
  onChange: (c: Partial<FormLine>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const isGrn = type === "GRN";
  const isCount = type === "PHYSICAL_COUNT";
  const isAdjustment = type === "ADJUSTMENT";
  const item = line.item;
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const wantsBatches = !!item?.trackBatches && !incoming;

  useEffect(() => {
    if (!wantsBatches || !item || !warehouseId) return;
    let live = true;
    batchesOnHand(item.id, warehouseId).then((rows) => {
      if (live) setBatches(rows);
    });
    return () => {
      live = false;
    };
  }, [wantsBatches, item, warehouseId]);

  const serialCount = line.serials.split(/[\s,;]+/).filter(Boolean).length;

  return (
    <>
      <tr className="border-t border-line align-top">
        <td className="py-2 pr-2">
          <ItemPicker inputId={`${id}-item`} label={`Line ${n} item`} value={item} onChange={(it) => onChange({ ...emptyLine(it), key: line.key })} />
          {item && (
            <div className="mt-1 text-xs text-subtle">
              {item.sku && <span className="mr-2 font-mono">{item.sku}</span>}
              {item.unit && <span className="mr-2">per {item.unit}</span>}
              {item.trackBatches && <span className="mr-2">batches{item.trackExpiry ? " & expiry" : ""}</span>}
              {item.trackSerials && <span>serial numbers</span>}
            </div>
          )}
        </td>
        {showPo && (
          <td className="px-2 py-2 text-right text-xs text-muted">
            {line.orderedQty != null ? (
              <>
                {qty(line.orderedQty)} ordered
                <br />
                {qty(line.receivedBefore ?? 0)} received
              </>
            ) : (
              "—"
            )}
          </td>
        )}
        {isCount && <td className="px-2 py-2 text-right tabular-nums text-muted">{line.systemQty == null ? "—" : qty(line.systemQty)}</td>}
        <td className="px-2 py-2">
          <Input
            aria-label={`Line ${n} ${isCount ? "counted" : "quantity"}`}
            type="number"
            step="0.001"
            min={isAdjustment ? undefined : 0}
            className="w-28"
            value={isCount ? line.countedQty : line.quantity}
            onChange={(e) => onChange(isCount ? { countedQty: e.target.value } : { quantity: e.target.value })}
          />
          {isCount && line.systemQty != null && line.countedQty !== "" && Number(line.countedQty) !== line.systemQty && (
            <div className={`mt-1 text-xs ${Number(line.countedQty) > line.systemQty ? "text-success" : "text-danger"}`}>
              {Number(line.countedQty) > line.systemQty ? "+" : ""}
              {qty(Math.round((Number(line.countedQty) - line.systemQty) * 1000) / 1000)}
            </div>
          )}
        </td>
        {isGrn && (
          <td className="px-2 py-2">
            <Input aria-label={`Line ${n} rejected`} type="number" step="0.001" min={0} className="w-24" value={line.rejectedQty} onChange={(e) => onChange({ rejectedQty: e.target.value })} />
          </td>
        )}
        {(isGrn || isAdjustment) && (
          <td className="px-2 py-2">
            <Input
              aria-label={`Line ${n} unit cost`}
              type="number"
              step="0.01"
              min={0}
              className="w-28"
              value={line.unitCost}
              disabled={isAdjustment && !incoming}
              placeholder={isAdjustment ? "average" : ""}
              onChange={(e) => onChange({ unitCost: e.target.value })}
            />
            {isGrn && line.unitCost !== "" && line.quantity !== "" && <div className="mt-1 text-xs text-subtle">{rupees(Number(line.unitCost) * Number(line.quantity))}</div>}
          </td>
        )}
        <td className="py-2 pl-2 text-right">
          <Button type="button" size="icon" variant="ghost" aria-label={`Remove line ${n}`} onClick={onRemove}>
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </Button>
        </td>
      </tr>
      {item && (item.trackBatches || (item.trackSerials && !isCount)) && (
        <tr className="align-top">
          <td colSpan={7} className="pb-3">
            <div className="flex flex-wrap items-end gap-3 rounded-base bg-surface-sunken px-3 py-2">
              {item.trackBatches && incoming && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-bn`} className="text-xs">Batch no.</Label>
                    <Input id={`${id}-bn`} className="h-8 w-36" value={line.batchNo} onChange={(e) => onChange({ batchNo: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-mfg`} className="text-xs">Made on</Label>
                    <Input id={`${id}-mfg`} type="date" className="h-8 w-40" value={line.mfgDate} onChange={(e) => onChange({ mfgDate: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-exp`} className="text-xs">Expires on{item.trackExpiry ? "" : " (optional)"}</Label>
                    <Input id={`${id}-exp`} type="date" className="h-8 w-40" value={line.expiryDate} onChange={(e) => onChange({ expiryDate: e.target.value })} />
                  </div>
                </>
              )}
              {item.trackBatches && !incoming && (
                <div className="space-y-1">
                  <Label htmlFor={`${id}-batch`} className="text-xs">Batch</Label>
                  <Select id={`${id}-batch`} className="h-8 w-64" value={line.batchId} onChange={(e) => onChange({ batchId: e.target.value })}>
                    <option value="">{isCount ? "Choose the batch counted…" : "First to expire, automatically"}</option>
                    {(batches ?? []).map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.batchNo} · {qty(b.quantity)} on hand{b.expiryDate ? ` · expires ${day(b.expiryDate)}` : ""}
                      </option>
                    ))}
                    {line.batchId && batches && !batches.some((b) => b.id === line.batchId) && <option value={line.batchId}>{line.batchNo || "The batch chosen"}</option>}
                  </Select>
                </div>
              )}
              {item.trackSerials && !isCount && (
                <div className="min-w-[260px] flex-1 space-y-1">
                  <Label htmlFor={`${id}-sn`} className="text-xs">
                    Serial numbers — one per unit ({serialCount} given)
                  </Label>
                  <Textarea id={`${id}-sn`} rows={2} value={line.serials} placeholder="SN1001, SN1002…" onChange={(e) => onChange({ serials: e.target.value })} />
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** A search box over the server's list, with its matches beneath it. */
function SearchPicker<T extends { id: string }>({
  inputId,
  label,
  placeholder,
  value,
  display,
  search,
  render,
  onChange,
  minLength = 0,
}: {
  inputId: string;
  label: string;
  placeholder: string;
  value: T | null;
  display: (v: T) => string;
  search: (term: string) => Promise<T[]>;
  render: (v: T) => React.ReactNode;
  onChange: (v: T | null) => void;
  minLength?: number;
}) {
  const [term, setTerm] = useState(value ? display(value) : "");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<T[]>([]);
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listId = `${inputId}-list`;
  const shownValue = value ? display(value) : "";
  // A value chosen elsewhere (a purchase order filling the vendor) shows in the box.
  const [seen, setSeen] = useState(shownValue);
  if (seen !== shownValue) {
    setSeen(shownValue);
    setTerm(shownValue);
  }

  function find(next: string) {
    setTerm(next);
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    if (next.trim().length < minLength) {
      setRows([]);
      return;
    }
    timer.current = setTimeout(async () => {
      const found = await search(next);
      setRows(found);
      setActive(0);
    }, 200);
  }

  function choose(row: T | null) {
    onChange(row);
    setOpen(false);
    setTerm(row ? display(row) : "");
  }

  return (
    <div className="relative">
      <Input
        id={inputId}
        role="combobox"
        aria-label={label}
        aria-expanded={open && rows.length > 0}
        aria-controls={listId}
        autoComplete="off"
        placeholder={placeholder}
        value={term}
        onFocus={() => find(term === shownValue ? "" : term)}
        onBlur={() =>
          setTimeout(() => {
            setOpen(false);
            setTerm(shownValue);
          }, 150)
        }
        onChange={(e) => find(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(rows.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter" && open && rows[active]) {
            e.preventDefault();
            choose(rows[active]!);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && rows.length > 0 && (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-64 w-full min-w-[260px] overflow-y-auto rounded-base border border-line bg-surface py-1 shadow-lg">
          {rows.map((r, i) => (
            <li
              key={r.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(r);
              }}
              className={`cursor-pointer px-3 py-1.5 text-sm ${i === active ? "bg-brand-subtle text-text" : "text-text hover:bg-surface-sunken"}`}
            >
              {render(r)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ItemPicker({ inputId, label, value, onChange }: { inputId: string; label: string; value: FormItem | null; onChange: (v: FormItem | null) => void }) {
  return (
    <SearchPicker<FormItem>
      inputId={inputId}
      label={label}
      placeholder="Search goods by name, SKU or barcode…"
      value={value}
      display={(v) => v.name}
      search={async (term) => (await searchStockItems(term)).map((r) => ({ ...r, costPrice: r.costPrice == null ? null : Number(r.costPrice) }))}
      render={(v) => (
        <span>
          {v.name}
          {v.sku && <span className="ml-2 font-mono text-xs text-subtle">{v.sku}</span>}
        </span>
      )}
      onChange={onChange}
    />
  );
}

function VendorPicker({ inputId, value, onChange }: { inputId: string; value: { id: string; name: string } | null; onChange: (v: { id: string; name: string } | null) => void }) {
  return (
    <SearchPicker
      inputId={inputId}
      label="Vendor"
      placeholder="Type two letters of the vendor…"
      value={value}
      display={(v) => v.name}
      search={searchVendors}
      render={(v) => v.name}
      onChange={onChange}
      minLength={2}
    />
  );
}

function PurchaseOrderPicker({ inputId, value, onChange }: { inputId: string; value: { id: string; docNumber: string } | null; onChange: (v: { id: string; docNumber: string } | null) => void }) {
  return (
    <div className="flex items-center gap-1">
      <div className="flex-1">
        <SearchPicker<{ id: string; docNumber: string; company?: { name: string } }>
          inputId={inputId}
          label="Purchase order"
          placeholder="None — or search open POs…"
          value={value}
          display={(v) => v.docNumber}
          search={openPurchaseOrders}
          render={(v) => (
            <span>
              <span className="font-mono text-xs">{v.docNumber}</span>
              {v.company && <span className="ml-2 text-muted">{v.company.name}</span>}
            </span>
          )}
          onChange={(v) => onChange(v ? { id: v.id, docNumber: v.docNumber } : null)}
        />
      </div>
      {value && (
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
          Clear
        </Button>
      )}
    </div>
  );
}

export function formInitialFromDocument(doc: {
  id: string;
  number: string;
  date: Date | string;
  warehouseId: string;
  toWarehouseId: string | null;
  company: { id: string; name: string } | null;
  purchaseOrder: { id: string; docNumber: string } | null;
  billId: string | null;
  reference: string | null;
  reason: string | null;
  notes: string | null;
  lines: {
    item: FormItem;
    quantity: number;
    orderedQty: number | null;
    rejectedQty: number | null;
    countedQty: number | null;
    systemQty: number | null;
    unitCost: number | null;
    poLineId: string | null;
    batchId: string | null;
    batch: { batchNo: string } | null;
    batchNo: string | null;
    mfgDate: Date | string | null;
    expiryDate: Date | string | null;
    serialNumbers: string[];
    note: string | null;
  }[];
}): StockFormInitial {
  return {
    id: doc.id,
    number: doc.number,
    date: day(doc.date),
    warehouseId: doc.warehouseId,
    toWarehouseId: doc.toWarehouseId ?? "",
    vendor: doc.company,
    purchaseOrder: doc.purchaseOrder,
    billId: doc.billId,
    reference: doc.reference ?? "",
    reason: doc.reason ?? "",
    notes: doc.notes ?? "",
    lines: doc.lines.map((l) => ({
      ...emptyLine(l.item),
      quantity: l.quantity === 0 && l.countedQty != null ? "" : String(l.quantity),
      rejectedQty: l.rejectedQty == null ? "" : String(l.rejectedQty),
      countedQty: l.countedQty == null ? "" : String(l.countedQty),
      systemQty: l.systemQty,
      orderedQty: l.orderedQty,
      unitCost: l.unitCost == null ? "" : String(l.unitCost),
      poLineId: l.poLineId,
      batchId: l.batchId ?? "",
      batchNo: l.batchNo ?? l.batch?.batchNo ?? "",
      mfgDate: day(l.mfgDate),
      expiryDate: day(l.expiryDate),
      serials: l.serialNumbers.join(", "),
      note: l.note ?? "",
    })),
  };
}
