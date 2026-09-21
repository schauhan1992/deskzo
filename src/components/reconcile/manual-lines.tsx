"use client";

import { useRef, useState } from "react";
import { ClipboardPaste, Plus, Trash2 } from "lucide-react";
import { PASTE_COLUMNS, emptyManualRow, parsePasted, type ManualRow } from "@/lib/reconcile/manual";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";

/**
 * Typing a statement in, for when there is no file.
 *
 * The grid is the obvious half. The paste box is the half that gets used: most of the time the
 * numbers are already on screen in a PDF or an email, and retyping twelve rows that could have been
 * dragged across is how somebody decides the module is not worth the trouble.
 */

export function ManualLines({
  rows,
  onChange,
  disabled,
}: {
  rows: ManualRow[];
  onChange: (rows: ManualRow[]) => void;
  disabled?: boolean;
}) {
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const pasteRef = useRef<HTMLTextAreaElement | null>(null);

  const setCell = (index: number, field: keyof ManualRow, value: string) => {
    const next = rows.map((r, i) => (i === index ? { ...r, [field]: value } : r));
    // A fresh blank row appears as soon as the last one is touched, so entering ten lines is ten
    // rows of typing rather than ten rows and ten clicks on Add.
    const last = next[next.length - 1];
    if (last && (last.sku || last.customerRef || last.quantity || last.unitCost || last.lineTotal)) {
      next.push(emptyManualRow());
    }
    onChange(next);
  };

  const remove = (index: number) => {
    const next = rows.filter((_, i) => i !== index);
    onChange(next.length > 0 ? next : [emptyManualRow()]);
  };

  const applyPaste = () => {
    const parsed = parsePasted(pasteText);
    if (parsed.length === 0) return;
    // Replaces whatever was typed, rather than appending — a paste is a fresh statement, and
    // silently merging two would be very hard to unpick afterwards.
    onChange([...parsed, emptyManualRow()]);
    setPasteText("");
    setPasting(false);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-text">The lines</span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => {
            setPasting((v) => !v);
            setTimeout(() => pasteRef.current?.focus(), 0);
          }}
        >
          <ClipboardPaste className="h-3.5 w-3.5" />
          Paste from a sheet or PDF
        </Button>
      </div>

      {pasting && (
        <div className="space-y-2 rounded-base border border-line bg-surface-sunken p-2.5">
          <p className="text-xs text-muted">
            Copy the rows and paste them here — tabs, commas or lined-up columns all work. In this order:{" "}
            <span className="font-medium text-text">{PASTE_COLUMNS.join(" · ")}</span>. A heading row is ignored.
          </p>
          <Textarea
            ref={pasteRef}
            rows={5}
            aria-label="Rows to paste"
            className="font-mono text-xs"
            placeholder={"CFQ7TTC0LH18-0001\tAcme Industries\t10\t750.00\n..."}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setPasting(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={applyPaste} disabled={!pasteText.trim()}>
              Use these {parsePasted(pasteText).length || ""} lines
            </Button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-base border border-line">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-2 py-1.5 font-medium">SKU *</th>
              <th className="px-2 py-1.5 font-medium">Customer *</th>
              <th className="w-16 px-2 py-1.5 font-medium">Qty *</th>
              <th className="w-24 px-2 py-1.5 font-medium">Unit cost</th>
              <th className="w-24 px-2 py-1.5 font-medium">Line total</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {/*
              A column heading is not a label — it names the column, not the cell — and an id repeated
              down the rows would point every label at row one. So each cell says its own column and
              line number, the same way the remove button does.
            */}
            {rows.map((row, index) => (
              <tr key={index} className="border-b border-line last:border-0">
                <td className="px-1.5 py-1">
                  <Input
                    aria-label={`SKU, line ${index + 1}`}
                    className="h-8 font-mono text-xs"
                    value={row.sku}
                    disabled={disabled}
                    onChange={(e) => setCell(index, "sku", e.target.value)}
                    placeholder="CFQ7TTC0LH18-0001"
                  />
                </td>
                <td className="px-1.5 py-1">
                  <Input
                    aria-label={`Customer, line ${index + 1}`}
                    className="h-8 text-[13px]"
                    value={row.customerRef}
                    disabled={disabled}
                    onChange={(e) => setCell(index, "customerRef", e.target.value)}
                    placeholder="Acme Industries"
                  />
                </td>
                <td className="px-1.5 py-1">
                  <Input
                    aria-label={`Qty, line ${index + 1}`}
                    className="h-8 text-[13px]"
                    inputMode="numeric"
                    value={row.quantity}
                    disabled={disabled}
                    onChange={(e) => setCell(index, "quantity", e.target.value)}
                    placeholder="10"
                  />
                </td>
                <td className="px-1.5 py-1">
                  <Input
                    aria-label={`Unit cost, line ${index + 1}`}
                    className="h-8 text-[13px]"
                    inputMode="decimal"
                    value={row.unitCost}
                    disabled={disabled}
                    onChange={(e) => setCell(index, "unitCost", e.target.value)}
                    placeholder="750.00"
                  />
                </td>
                <td className="px-1.5 py-1">
                  <Input
                    aria-label={`Line total, line ${index + 1}`}
                    className="h-8 text-[13px]"
                    inputMode="decimal"
                    value={row.lineTotal}
                    disabled={disabled}
                    onChange={(e) => setCell(index, "lineTotal", e.target.value)}
                    placeholder="7500.00"
                  />
                </td>
                <td className="px-1 py-1">
                  {rows.length > 1 && (
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      aria-label={`Remove line ${index + 1}`}
                      className="rounded-base p-1 text-subtle transition-colors hover:bg-danger-bg hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-2">
        {/* Either figure will do — a statement that gives only a total is perfectly ordinary. */}
        <p className="text-xs text-muted">Give a unit cost or a line total; the other is worked out.</p>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange([...rows, emptyManualRow()])}>
          <Plus className="h-3.5 w-3.5" />
          Add a line
        </Button>
      </div>
    </div>
  );
}
