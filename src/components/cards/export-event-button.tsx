"use client";

import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import { exportEventContacts } from "@/actions/card";
import { Button } from "@/components/ui/button";

// Excel reads a CSV as UTF-8 only when it starts with a byte-order mark; names in other scripts need it.
const BOM = String.fromCharCode(0xfeff);

/** Everybody met at an event, downloaded as a CSV — made by the server, never a link to pass around. */
export function ExportEventButton({ eventId }: { eventId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const result = await exportEventContacts(eventId);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            const url = URL.createObjectURL(new Blob([BOM + result.data.csv], { type: "text/csv;charset=utf-8" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = result.data.filename;
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
          })
        }
      >
        <Download className="h-4 w-4" />
        {pending ? "Preparing…" : "Export CSV"}
      </Button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
