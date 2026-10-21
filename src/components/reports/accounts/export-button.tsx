"use client";

import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import { exportStockReportCsv, type StockReportKey, type StockReportParams } from "@/actions/stock-reports";
import { exportAccountsReportCsv, type AccountsReportKey, type AccountsReportParams } from "@/actions/accounts-reports";
import { Button } from "@/components/ui/button";

/** A byte-order mark, built from its code: Excel then reads the file as UTF-8 (the ₹ in the headings). */
const BOM = String.fromCharCode(0xfeff);

/**
 * Downloads the report on screen as CSV. The server builds the file — every row the filters match, formula-
 * guarded, with lines saying what it is, and logged as an export — and the browser only saves it, so there is
 * no address to share and no way round the export permission.
 */
export function ReportExportButton(
  props: { kind: "stock"; report: StockReportKey; params: StockReportParams } | { kind: "accounts"; report: AccountsReportKey; params: AccountsReportParams },
) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function download() {
    setError(null);
    startTransition(async () => {
      const result = props.kind === "stock" ? await exportStockReportCsv(props.report, props.params) : await exportAccountsReportCsv(props.report, props.params);
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
