"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setEwayEnabled } from "@/actions/eway";
import { Button } from "@/components/ui/button";

export function EwayEnableToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-3">
      {error && <span className="text-sm text-danger">{error}</span>}
      <Button
        variant={enabled ? "secondary" : "primary"}
        size="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          startTransition(async () => {
            const result = await setEwayEnabled({ enabled: !enabled });
            setBusy(false);
            if (!result.ok) setError(result.error);
            else router.refresh();
          });
        }}
      >
        {enabled ? "Disable" : "Enable"}
      </Button>
    </div>
  );
}
