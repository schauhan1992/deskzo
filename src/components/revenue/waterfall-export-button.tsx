"use client";

import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import { exportWaterfallCsv } from "@/actions/revenue-screens";
import { Button } from "@/components/ui/button";

/** A byte-order mark, built from its code: Excel then reads the file as UTF-8 (the ₹ in the headings) rather than the local code page. */
const BOM = String.fromCharCode(0xfeff);

/**
 * Downloads the waterfall on screen as CSV. The server builds the file — formula-guarded, with a few
 * lines saying what it is, and logged as an export — and the browser only saves it, so there is no
 * address to share and no way round the export permission.
 */
export function WaterfallExportButton({ by, months }: { by: "customer" | "item"; months: 12 | 24 }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function download() {
    setError(null);
    startTransition(async () => {
      const result = await exportWaterfallCsv({ by, months });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const url = URL.createObjectURL(new Blob([BOM + result.data.csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.data.filename;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={download}>
        <Download aria-hidden="true" className="h-4 w-4" />
        {pending ? "Preparing…" : "Export CSV"}
      </Button>
      {error && (
        <span role="alert" className="max-w-xs text-right text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  );
}
