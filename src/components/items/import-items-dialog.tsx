"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { importItems, type ImportItemsResult } from "@/actions/item";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** The first twenty names and a count of the rest — a first import can add hundreds. */
function listSome(names: string[]) {
  return names.slice(0, 20).join(", ") + (names.length > 20 ? ` and ${names.length - 20} more` : "");
}

export function ImportItemsDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportItemsResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleClose() {
    setOpen(false);
    setFile(null);
    setError(null);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleImport() {
    if (!file) return;
    setError(null);
    setResult(null);
    setIsImporting(true);

    const formData = new FormData();
    formData.set("file", file);
    const res = await importItems(formData);

    setIsImporting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setResult(res.data);
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    router.refresh();
  }

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Import CSV
      </Button>

      <Dialog open={open} onClose={handleClose} title="Import items">
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Upload a CSV of goods, services, or subscriptions. Rows with a SKU that already
            exists update that item&rsquo;s details (stock is never touched by import — record
            stock movements from the item page). New rows are created.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
            <li>
              Every field on the item form has a column — including <strong>brand</strong>,{" "}
              <strong>productFamily</strong> and <strong>hsnCode</strong> (HSN or SAC, 4, 6 or 8 digits).
              Headers like &ldquo;Selling Price&rdquo; or &ldquo;HSN/SAC&rdquo; are understood too.
            </li>
            <li>
              Brands and families are matched by name, ignoring case. One that isn&rsquo;t in the catalogue yet
              is added — if you manage the catalogue; otherwise that row is skipped and named below.
            </li>
            <li>
              Leave out the brand, family or HSN column entirely and existing items keep theirs; include the
              column but leave a cell blank and that item&rsquo;s value is cleared. An export can be edited and
              imported straight back.
            </li>
          </ul>

          <a
            href="/items-import-template.csv"
            download
            className="inline-block text-sm font-medium text-text underline underline-offset-2 hover:text-text"
          >
            Download sample CSV
          </a>

          <input
            aria-label="CSV file"
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-text hover:file:bg-surface-sunken"
          />

          {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}

          {result && (
            <div className="rounded-md bg-surface-sunken px-3 py-2 text-sm">
              <p className="font-medium text-text">
                Created {result.created}, updated {result.updated}
                {result.errors.length > 0 ? `, ${result.errors.length} row(s) skipped` : ""}.
              </p>
              {/* Listed by name so a typo that became a new brand is caught now, not in a report. */}
              {result.brandsCreated.length > 0 && (
                <p className="mt-1 text-muted">
                  Added {result.brandsCreated.length} brand(s): {listSome(result.brandsCreated)}
                </p>
              )}
              {result.familiesCreated.length > 0 && (
                <p className="mt-1 text-muted">
                  Added {result.familiesCreated.length} product family(ies): {listSome(result.familiesCreated)}
                </p>
              )}
              {result.errors.length > 0 && (
                <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto text-danger">
                  {result.errors.map((e, idx) => (
                    <li key={idx}>
                      Row {e.row}: {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={handleClose}>
              Close
            </Button>
            <Button type="button" size="sm" disabled={!file || isImporting} onClick={handleImport}>
              {isImporting ? "Importing…" : "Import"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
