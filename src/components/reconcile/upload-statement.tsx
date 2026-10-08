"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Keyboard, Plus, Upload } from "lucide-react";
import {
  commitManualStatement,
  commitStatement,
  previewManualStatement,
  previewStatement,
  type StatementPreview,
} from "@/actions/reconcile";
import { emptyManualRow, type ManualRow } from "@/lib/reconcile/manual";
import { ManualLines } from "@/components/reconcile/manual-lines";
import { FIELDS, type ColumnMapping, type FieldKey } from "@/lib/reconcile/mapping";
import type { Billing } from "@/lib/reconcile/match";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";

/**
 * Getting a statement in, either way, and checking it before it is stored.
 *
 * Two doors into one comparison. A file is the common case; typing is for the distributor who
 * emails four lines in the body of a message, and no amount of column mapping helps with that.
 *
 * For a file, the mapping step is the whole safety property. A statement whose "Unit Price" column
 * was read as "Price" produces two hundred price mismatches — a page of noise that looks exactly
 * like a page of findings, and the natural response to which is to stop trusting the module. So the
 * columns are guessed, shown with real values beside them, and confirmed by a person before
 * anything is stored. Typed rows get the same treatment through "Check these against our orders".
 */

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The month just gone — which is what a statement almost always covers. */
function lastMonth(): { start: string; end: string; label: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { start: iso(start), end: iso(end), label: `${MONTH_NAMES[start.getMonth()]} ${start.getFullYear()}` };
}

type Mode = "file" | "manual";

export function UploadStatement({ vendors }: { vendors: { id: string; name: string }[] }) {
  const [mode, setMode] = useState<Mode>("file");
  const [manualRows, setManualRows] = useState<ManualRow[]>([emptyManualRow()]);
  const [manual, setManual] = useState<{
    summary: StatementPreview["summary"];
    problems: { rowNumber: number; reason: string }[];
    totalBilled: number;
    usable: number;
  } | null>(null);
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const defaults = lastMonth();
  const [vendorId, setVendorId] = useState("");
  const [label, setLabel] = useState("");
  const [periodStart, setPeriodStart] = useState(defaults.start);
  const [periodEnd, setPeriodEnd] = useState(defaults.end);
  const [billing, setBilling] = useState<Billing>("MONTHLY");
  const [complete, setComplete] = useState(true);

  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setMapping({});
    setError(null);
    setManualRows([emptyManualRow()]);
    setManual(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  /**
   * Re-runs the comparison on the typed rows.
   *
   * Explicit rather than on every keystroke: this is a database query per press, and a preview that
   * fires while somebody is halfway through typing a SKU reports nonsense at them as they type.
   */
  const lookManual = () => {
    setError(null);
    startTransition(async () => {
      const result = await previewManualStatement({
        rows: manualRows,
        periodStart,
        periodEnd,
        billing,
        complete,
        vendorId: vendorId || null,
      });
      if (!result.ok) {
        setError(result.error);
        setManual(null);
        return;
      }
      setManual(result.data);
    });
  };

  const look = (base64: string, name: string, withMapping: ColumnMapping | null) => {
    setError(null);
    startTransition(async () => {
      const result = await previewStatement({
        filename: name,
        base64,
        periodStart,
        periodEnd,
        billing,
        mapping: withMapping,
        complete,
        vendorId: vendorId || null,
      });
      if (!result.ok) {
        setError(result.error);
        setPreview(null);
        return;
      }
      setPreview(result.data);
      setMapping(result.data.mapping);
    });
  };

  const choose = (f: File) => {
    reset();
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1] ?? "";
      setFile({ name: f.name, base64 });
      if (!label.trim()) {
        const vendor = vendors.find((v) => v.id === vendorId);
        setLabel(vendor ? `${vendor.name} — ${defaults.label}` : defaults.label);
      }
      look(base64, f.name, null);
    };
    reader.onerror = () => setError("That file couldn't be read.");
    reader.readAsDataURL(f);
  };

  /** Re-runs the comparison with a column the person corrected. */
  const remap = (field: FieldKey, column: string) => {
    const next = { ...mapping, [field]: column || undefined };
    setMapping(next);
    if (file) look(file.base64, file.name, next);
  };

  const commitManual = () => {
    setError(null);
    startTransition(async () => {
      const result = await commitManualStatement({ vendorId, label, rows: manualRows, periodStart, periodEnd, billing, complete });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      reset();
      router.push(`/purchase/reconciliation/${result.data.statementId}`);
      router.refresh();
    });
  };

  const commit = () => {
    if (!file) return;
    setError(null);
    startTransition(async () => {
      const result = await commitStatement({
        vendorId,
        label,
        filename: file.name,
        base64: file.base64,
        periodStart,
        periodEnd,
        billing,
        complete,
        mapping,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      reset();
      router.push(`/purchase/reconciliation/${result.data.statementId}`);
      router.refresh();
    });
  };

  const typedSomething = manualRows.some((r) => r.sku.trim() && r.customerRef.trim());
  const ready =
    mode === "file"
      ? Boolean(vendorId && label.trim() && preview && preview.missing.length === 0)
      : Boolean(vendorId && label.trim() && typedSomething);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        Add a statement
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        title="Reconcile a vendor statement"
      >
        <div className="mt-4 max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          {/*
            Two doors into the same comparison. A file is the common case; typing is for the
            distributor who emails four lines in the body of a message, which no amount of column
            mapping will help with.
          */}
          <div className="flex gap-1 rounded-base bg-surface-sunken p-1">
            {([
              { key: "file", label: "Upload a file", icon: Upload },
              { key: "manual", label: "Type or paste", icon: Keyboard },
            ] as const).map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => {
                  setMode(m.key);
                  setComplete(m.key === "file");
                  setManual(null);
                  setError(null);
                }}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-base px-3 py-1.5 text-sm font-medium transition-colors ${
                  mode === m.key ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"
                }`}
              >
                <m.icon className="h-3.5 w-3.5" />
                {m.label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="rec-vendor">Vendor</Label>
              <Select id="rec-vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                <option value="">Choose…</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rec-label">Name</Label>
              <Input id="rec-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ingram — Sep 2026" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rec-from">Period from</Label>
              <Input id="rec-from" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rec-to">Period to</Label>
              <Input id="rec-to" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="rec-billing">These lines are billed</Label>
              <Select id="rec-billing" value={billing} onChange={(e) => setBilling(e.target.value as Billing)}>
                <option value="MONTHLY">Monthly — a twelfth of the annual cost per line</option>
                <option value="ANNUAL">Annually — the full term on one line</option>
                <option value="ONE_OFF">One-off — perpetual licences or hardware</option>
              </Select>
              {/*
                Said plainly because getting it wrong does not fail, it just makes every line look
                wrong by a factor of twelve — which reads as a broken tool rather than a wrong answer.
              */}
              <p className="text-xs text-muted">
                Our orders record the cost of a full term. Tell it which, or every price will look wrong.
              </p>
            </div>

            {/*
              Whether an absence means anything. On a whole month, one of our live orders not
              appearing is a finding. On four lines typed to check one thing, every other order is
              missing by construction and saying so buries what they came to look at.
            */}
            <label className="flex items-start gap-2.5 sm:col-span-2">
              <input
                type="checkbox"
                checked={complete}
                onChange={(e) => setComplete(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                <span className="block text-sm font-medium text-text">
                  This is everything they billed for the period
                </span>
                <span className="block text-sm text-muted">
                  {complete
                    ? "Our live orders that are missing from it will be reported, which is how you catch a subscription that was never provisioned."
                    : "A spot check — nothing will be reported just for being absent."}
                </span>
              </span>
            </label>
          </div>

          {mode === "file" && (
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.pdf"
              aria-label="Statement file"
              aria-describedby="statement-file-hint"
              className="block w-full text-sm text-muted file:mr-3 file:rounded-base file:border-0 file:bg-brand-subtle file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) choose(f);
              }}
            />
            <p id="statement-file-hint" className="mt-1.5 text-xs text-muted">
              Excel, CSV, or a PDF from the vendor&apos;s portal. A scanned PDF or a photo can&apos;t be read — ask for Excel or CSV instead.
            </p>
          </div>
          )}

          {mode === "manual" && (
            <div className="space-y-3">
              <ManualLines rows={manualRows} onChange={setManualRows} disabled={isPending} />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={lookManual} disabled={isPending || !typedSomething}>
                  Check these against our orders
                </Button>
                {manual && (
                  <span className="text-xs text-muted">
                    {manual.usable} line{manual.usable === 1 ? "" : "s"} · {formatCurrency(manual.totalBilled)}
                  </span>
                )}
              </div>

              {manual?.summary && manual.usable > 0 && (
                <div className="rounded-base bg-surface-sunken px-3 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="green">{manual.summary.matched} matched</Badge>
                    {manual.summary.exceptions > 0 && <Badge tone="red">{manual.summary.exceptions} to look at</Badge>}
                  </div>
                  {manual.summary.atRisk > 0 && (
                    <p className="mt-1.5 text-sm font-medium text-danger">
                      {formatCurrency(manual.summary.atRisk)} worth checking.
                    </p>
                  )}
                </div>
              )}

              {manual && manual.problems.length > 0 && (
                <div className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
                  <span className="font-medium">
                    {manual.problems.length} line{manual.problems.length === 1 ? "" : "s"} could not be read
                  </span>
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {manual.problems.slice(0, 10).map((p) => (
                      <li key={p.rowNumber}>
                        Line {p.rowNumber}: {p.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>
          )}

          {isPending && <p className="text-sm text-muted">Reading…</p>}

          {mode === "file" && preview && (
            <div className="space-y-3">
              <div className="rounded-base border border-line">
                <div className="border-b border-line px-3 py-2 text-xs font-medium text-text">
                  Which column is which
                </div>
                <div className="space-y-2 p-3">
                  {FIELDS.map((f) => (
                    <div key={f.key} className="grid grid-cols-[9rem_1fr] items-center gap-2">
                      <label htmlFor={`map-${f.key}`} className="text-xs text-muted">
                        {f.label}
                        {f.required && <span className="text-danger"> *</span>}
                      </label>
                      <Select
                        id={`map-${f.key}`}
                        className="h-8 text-[13px]"
                        value={mapping[f.key] ?? ""}
                        onChange={(e) => remap(f.key, e.target.value)}
                      >
                        <option value="">— not in this file —</option>
                        {preview.headers.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ))}
                </div>
              </div>

              {preview.missing.length > 0 && (
                <p className="flex items-start gap-2 rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  Map the SKU, customer and quantity columns — nothing can be matched without them.
                </p>
              )}

              {preview.sample.length > 0 && (
                <div className="overflow-x-auto rounded-base border border-line">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-line text-left text-xs text-muted">
                        <th className="px-3 py-1.5 font-medium">SKU</th>
                        <th className="px-3 py-1.5 font-medium">Customer</th>
                        <th className="px-3 py-1.5 font-medium">Qty</th>
                        <th className="px-3 py-1.5 font-medium">Unit</th>
                        <th className="px-3 py-1.5 font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sample.map((r, i) => (
                        <tr key={i} className="border-b border-line last:border-0">
                          <td className="px-3 py-1.5 font-mono text-xs text-text">{r.sku}</td>
                          <td className="px-3 py-1.5 text-text">{r.customerRef}</td>
                          <td className="px-3 py-1.5 text-text">{r.quantity}</td>
                          <td className="px-3 py-1.5 text-text">{formatCurrency(r.unitCost)}</td>
                          <td className="px-3 py-1.5 text-text">{formatCurrency(r.lineTotal)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {preview.summary && (
                <div className="rounded-base bg-surface-sunken px-3 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="green">{preview.summary.matched} matched</Badge>
                    {preview.summary.exceptions > 0 && <Badge tone="red">{preview.summary.exceptions} to look at</Badge>}
                    <span className="text-xs text-muted">
                      {preview.rowCount} rows · {formatCurrency(preview.totalBilled)} billed
                    </span>
                  </div>
                  {preview.summary.atRisk > 0 && (
                    <p className="mt-1.5 text-sm font-medium text-danger">
                      {formatCurrency(preview.summary.atRisk)} worth checking.
                    </p>
                  )}
                </div>
              )}

              {preview.problems.length > 0 && (
                <details className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
                  <summary className="cursor-pointer font-medium">
                    {preview.problems.length} row{preview.problems.length === 1 ? "" : "s"} could not be read
                  </summary>
                  <ul className="mt-1.5 space-y-0.5 text-xs">
                    {preview.problems.slice(0, 20).map((p) => (
                      <li key={p.rowNumber}>
                        Line {p.rowNumber}: {p.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-line pt-3">
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(false);
              reset();
            }}
          >
            Cancel
          </Button>
          <Button onClick={mode === "file" ? commit : commitManual} disabled={!ready || isPending}>
            <Check className="h-4 w-4" />
            {mode === "file" ? "Import and reconcile" : "Save and reconcile"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
