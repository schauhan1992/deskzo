"use client";

import { useRef, useTransition } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConsoleResult } from "@/actions/platform/console";
import { plural } from "@/lib/console-shared/format";
import type { CsvExport } from "@/lib/console-shared/types";
import { useConsoleNotice } from "./notice";

/**
 * A byte-order mark in front of the text: without it Excel opens a UTF-8 file as the local code page,
 * and "Café Müller Pvt Ltd" arrives as mojibake. Built from its char code on purpose — an escape
 * sequence written into source is easy to turn into an invisible character by accident.
 */
const BOM = String.fromCharCode(0xfeff);

/** Long enough for any browser to have started reading the blob; the URL is freed after. */
const REVOKE_AFTER_MS = 30_000;

/** A server-built name, but still only ever a file name: no folders, no control characters. */
function safeFilename(name: string): string {
  const base = String(name ?? "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, 120);
  if (!base) return "export.csv";
  return /\.csv$/i.test(base) ? base : `${base}.csv`;
}

function isNextSignal(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("digest" in err)) return false;
  const digest = (err as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

/**
 * Downloads the current list as CSV. The rows are built by a bound server action — the page's own
 * filters already applied, capped and audited there — and handed to the browser as a Blob; there is
 * no download route. The outcome ("Exported 142 rows", or the refusal) goes to the page notice.
 */
export function ExportCsvButton({ action, label = "Export CSV" }: { action: () => Promise<ConsoleResult<CsvExport>>; label?: string }) {
  const { show } = useConsoleNotice();
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);

  function download(file: CsvExport) {
    const blob = new Blob([BOM + file.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeFilename(file.filename);
    link.rel = "noopener";
    // In the document for the click: some browsers ignore a click on a detached anchor.
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }

  function onClick() {
    if (inFlight.current) return;
    inFlight.current = true;
    startTransition(async () => {
      try {
        let result: ConsoleResult<CsvExport> | undefined;
        try {
          result = await action();
        } catch (err) {
          if (isNextSignal(err)) throw err;
          show("error", "The export didn't finish. Try again, or narrow the filters.");
          return;
        }
        if (!result || typeof result !== "object") {
          show("error", "The export didn't finish. Try again, or narrow the filters.");
          return;
        }
        if (!result.ok) {
          show("error", result.error);
          return;
        }
        const rows = Number.isFinite(result.data.rows) ? result.data.rows : 0;
        if (rows === 0) {
          // A file with a header and nothing under it answers no question — say so instead.
          show("info", "Nothing to export — no rows match the current filters.");
          return;
        }
        download(result.data);
        show("success", `Exported ${plural(rows, "row")}.`);
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    // Inert rather than disabled while it works: a disabled button drops the keyboard focus it had.
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onClick}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      className={pending ? "cursor-wait opacity-70" : undefined}
    >
      {pending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Download aria-hidden="true" className="h-4 w-4" />}
      {label}
    </Button>
  );
}
