"use client";

import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import { exportReceivablesAging } from "@/actions/receivable";
import { exportPayablesAging } from "@/actions/payable";
import { Button } from "@/components/ui/button";

/**
 * Downloads the aging report on screen as an Excel workbook — the summary, and every invoice or bill behind
 * it. The server builds the file through the finance export's gates (src/lib/receivables/aging-export.ts);
 * the browser only saves it.
 */
export function AgingExportButton({ side, params }: { side: "AR" | "AP"; params: Record<string, string> }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function download() {
    setError(null);
    startTransition(async () => {
      const result = side === "AR" ? await exportReceivablesAging(params) : await exportPayablesAging(params);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const bytes = Uint8Array.from(atob(result.data.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.data.contentType }));
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
        {pending ? "Preparing…" : "Export Excel"}
      </Button>
      {error && (
        <span role="alert" className="max-w-xs text-right text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  );
}
