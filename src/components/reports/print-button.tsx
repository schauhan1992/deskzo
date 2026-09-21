"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The one interactive thing on a page that is otherwise entirely server-rendered. */
export function PrintButton() {
  return (
    <Button size="sm" variant="secondary" onClick={() => window.print()}>
      <Printer className="h-3.5 w-3.5" />
      Print or save as PDF
    </Button>
  );
}
