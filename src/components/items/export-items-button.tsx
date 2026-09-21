"use client";

import { useState } from "react";
import { exportItemsCsv } from "@/actions/item";
import { Button } from "@/components/ui/button";

export function ExportItemsButton() {
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setError(null);
    setIsExporting(true);
    const result = await exportItemsCsv();
    setIsExporting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    const blob = new Blob([result.data.csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = result.data.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" variant="secondary" onClick={handleExport} disabled={isExporting}>
        {isExporting ? "Exporting…" : "Export CSV"}
      </Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
