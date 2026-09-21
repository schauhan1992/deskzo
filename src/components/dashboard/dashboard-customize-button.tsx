"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Settings2 } from "lucide-react";
import { setDashboardPreferences, resetDashboardPreferences, type DashboardPresetOption } from "@/actions/dashboard";
import type { DashboardWidgetDefinition } from "@/lib/dashboard-widgets";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export function DashboardCustomizeButton({
  options,
  selected,
  customized,
  presets,
}: {
  options: DashboardWidgetDefinition[];
  selected: string[];
  customized: boolean;
  presets: DashboardPresetOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set(selected));
  const [isPending, startTransition] = useTransition();

  function toggle(key: string) {
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleOpen() {
    setCheckedKeys(new Set(selected));
    setOpen(true);
  }

  function handleSave() {
    startTransition(async () => {
      await setDashboardPreferences(Array.from(checkedKeys));
      setOpen(false);
      router.refresh();
    });
  }

  function handleReset() {
    startTransition(async () => {
      await resetDashboardPreferences();
      setOpen(false);
      router.refresh();
    });
  }

  function handleApplyPreset(preset: DashboardPresetOption) {
    startTransition(async () => {
      await setDashboardPreferences(preset.widgets);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={handleOpen}>
        <Settings2 className="h-4 w-4" />
        Customize
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Customize your dashboard">
        {presets.length > 0 && (
          <div className="mb-4 border-b border-line pb-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Predefined layouts</p>
            <p className="mt-1 text-xs text-muted">
              One-click layouts set up by your admin — pick one to use it as your default, or fine-tune manually
              below instead.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  disabled={isPending}
                  onClick={() => handleApplyPreset(preset)}
                  className="rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-text hover:bg-surface-sunken disabled:opacity-50"
                >
                  Use &ldquo;{preset.label}&rdquo; layout
                </button>
              ))}
            </div>
          </div>
        )}
        <p className="text-sm text-muted">
          Choose which sections show on your dashboard. Only sections you currently have access to are listed here.
        </p>
        <div className="mt-3 max-h-80 space-y-1 overflow-y-auto">
          {options.map((widget) => (
            <label
              key={widget.key}
              className="flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-surface-sunken"
            >
              <input
                type="checkbox"
                checked={checkedKeys.has(widget.key)}
                onChange={() => toggle(widget.key)}
                className="mt-0.5 h-4 w-4 rounded border-line-strong"
              />
              <span>
                <span className="block text-sm font-medium text-text">{widget.label}</span>
                <span className="block text-xs text-muted">{widget.description}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          {customized ? (
            <button
              type="button"
              onClick={handleReset}
              disabled={isPending}
              className="text-xs text-muted hover:text-text hover:underline disabled:opacity-50"
            >
              Reset to default
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={handleSave} disabled={isPending}>
              {isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
