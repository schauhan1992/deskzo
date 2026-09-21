"use client";

import { useState, useTransition } from "react";
import { FileCheck2, Link2, Loader2 } from "lucide-react";
import { ewayForDocument, type EwayDocumentView, type EwayStatus } from "@/actions/eway";
import type { TransporterOption } from "@/components/logistics/transporter-combobox";
import { EwayPanel } from "@/components/logistics/eway-panel";
import { SidePane } from "@/components/ui/side-pane";
import { Button } from "@/components/ui/button";

/**
 * Raise a bill from the row it belongs to.
 *
 * The list is a to-do list, and a to-do list you cannot act on from is a report. Opening the whole
 * panel in a side pane rather than sending somebody to the document keeps them where the work is —
 * two hundred outstanding documents is two hundred round trips otherwise — and means there is
 * exactly one e-way bill panel in the app rather than a cut-down copy that drifts from it.
 *
 * Loaded when the pane opens, not with the page: fetching the transport details of every row to
 * draw a button nobody has pressed would make the list slower for the one thing it is good at.
 */
export function EwayRowActions({
  documentId,
  docNumber,
  status,
  required,
  transporters,
}: {
  documentId: string;
  docNumber: string;
  status: EwayStatus;
  required: boolean;
  transporters: TransporterOption[];
}) {
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<EwayDocumentView | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    startTransition(async () => {
      const result = await ewayForDocument(documentId);
      if (result.ok) setView(result.data);
      else setError(result.error);
    });
  }

  function show() {
    setOpen(true);
    setView(null);
    setError(null);
    load();
  }

  const outstanding = status === "NOT_GENERATED" || status === "EXPIRED" || status === "CANCELLED" || status === "FAILED";

  return (
    <>
      <Button
        size="sm"
        // Prominent only where something is actually owed. A blue button beside every document in
        // order would tell you nothing about which one needs you.
        variant={outstanding && required ? "primary" : "ghost"}
        onClick={show}
      >
        {outstanding ? (
          <>
            <FileCheck2 className="h-3.5 w-3.5" />
            {status === "EXPIRED" ? "Raise a new one" : status === "CANCELLED" ? "Raise again" : "Generate"}
          </>
        ) : (
          <>
            <Link2 className="h-3.5 w-3.5" />
            Manage
          </>
        )}
      </Button>

      <SidePane open={open} onClose={() => setOpen(false)} title={docNumber}>
        {error && <p className="text-sm text-danger">{error}</p>}
        {!view && !error && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading the transport details…
          </p>
        )}
        {view && <EwayPanel view={view} transporters={transporters} onChanged={load} />}
      </SidePane>
    </>
  );
}
