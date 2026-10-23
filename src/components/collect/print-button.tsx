"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Prints the page as it stands — the browser's own print, to paper or a PDF. */
export function PrintButton() {
  return (
    <Button type="button" variant="secondary" size="sm" onClick={() => window.print()}>
      <Printer className="size-4" aria-hidden="true" />
      Print or save as PDF
    </Button>
  );
}
