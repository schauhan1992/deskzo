"use client";

import { useRef, useTransition } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { cmsExportLeads } from "@/actions/cms/leads";
import { useConsoleNotice } from "@/components/console/kit/notice";
import { Button } from "@/components/ui/button";
import type { LeadFilters } from "@/lib/cms/types";

/** A byte-order mark, built from its code: Excel then reads the file as UTF-8 rather than the local code page. */
const BOM = String.fromCharCode(0xfeff);

function safeFilename(name: string): string {
  const base = String(name ?? "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, 120);
  if (!base) return "website-leads.csv";
  return /\.csv$/i.test(base) ? base : `${base}.csv`;
}

/**
 * Downloads the inbox, as filtered now, as CSV — built by the server action (capped at 10,000 rows,
 * guarded against spreadsheet formulas, and written to the activity log) and handed to the browser as
 * a file. There is no download address to share.
 */
export function ExportLeadsButton({ filters }: { filters: LeadFilters }) {
  const { show } = useConsoleNotice();
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);

  const onClick = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    startTransition(async () => {
      try {
        const result = await cmsExportLeads(filters);
        if (!result.ok) {
          show("error", result.error);
          return;
        }
        if (result.data.rows === 0) {
          show("info", "Nothing to export — no lead matches the filters.");
          return;
        }
        const blob = new Blob([BOM + result.data.csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = safeFilename(result.data.filename);
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
        show("success", `Exported ${result.data.rows.toLocaleString("en-IN")} ${result.data.rows === 1 ? "lead" : "leads"}.`);
      } catch {
        show("error", "The export didn't finish. Try again, or narrow the filters.");
      } finally {
        inFlight.current = false;
      }
    });
  };

  return (
    <Button type="button" variant="secondary" size="sm" onClick={onClick} aria-disabled={pending || undefined} aria-busy={pending || undefined} className={pending ? "cursor-wait opacity-70" : undefined}>
      {pending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Download aria-hidden="true" className="h-4 w-4" />}
      Export CSV
    </Button>
  );
}
