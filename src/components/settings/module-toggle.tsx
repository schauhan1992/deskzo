"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setModuleEnabled } from "@/actions/module";

export function ModuleToggle({ moduleKey, enabled }: { moduleKey: string; enabled: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleToggle() {
    setError(null);
    startTransition(async () => {
      const result = await setModuleEnabled(moduleKey, !enabled);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={isPending}
        onClick={handleToggle}
        className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${
          enabled ? "bg-brand" : "bg-line-strong"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-transform ${
            enabled ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
