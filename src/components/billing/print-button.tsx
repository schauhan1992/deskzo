"use client";

import { Printer } from "lucide-react";

/** The browser's print, which also saves the page as a PDF. */
export function PrintButton({ label = "Print or save as PDF" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-800 shadow-sm hover:bg-neutral-50"
    >
      <Printer aria-hidden="true" className="h-4 w-4" />
      {label}
    </button>
  );
}
