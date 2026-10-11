"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setSignatureClickTracking } from "@/actions/signature";

/** Counting clicks on banners and buttons, on or off — every signature changes, so every one goes out again. */
export function ClickTrackingSwitch({ on }: { on: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm font-medium text-text">
        <input
          type="checkbox"
          checked={on}
          disabled={pending}
          onChange={(e) =>
            start(async () => {
              setError(null);
              const r = await setSignatureClickTracking(e.target.checked);
              if (!r.ok) setError(r.error);
              else router.refresh();
            })
          }
        />
        Count clicks on banners and buttons
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
