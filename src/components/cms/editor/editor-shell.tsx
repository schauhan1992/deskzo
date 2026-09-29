"use client";

import { useState, type ReactNode } from "react";
import { Eye, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The editor's layout: a top bar that stays in view, then the form on the left and the live preview
 * on the right. Below `lg` the two share the width and a pair of tabs switches between them.
 */
export function EditorShell({ header, banners, edit, preview }: { header: ReactNode; banners?: ReactNode; edit: ReactNode; preview: ReactNode }) {
  const [pane, setPane] = useState<"edit" | "preview">("edit");
  return (
    <div className="min-w-0">
      <div className="sticky top-14 z-10 -mx-4 border-b border-line bg-bg/90 px-4 py-2.5 backdrop-blur-md md:-mx-6 md:px-6">{header}</div>
      {banners && <div className="mt-4 space-y-2">{banners}</div>}
      <div role="tablist" aria-label="Editor view" className="mt-4 inline-flex rounded-base border border-line bg-surface-sunken p-0.5 lg:hidden">
        {(
          [
            ["edit", "Edit", PenLine],
            ["preview", "Preview", Eye],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={pane === key}
            onClick={() => setPane(key)}
            className={cn("inline-flex h-8 items-center gap-1.5 rounded-[6px] px-3 text-[13px] font-medium", pane === key ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}
          >
            <Icon aria-hidden="true" className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className={cn("min-w-0", pane === "preview" && "hidden lg:block")}>{edit}</div>
        <div className={cn("min-w-0", pane === "edit" && "hidden lg:block")}>
          <div className="h-[75vh] overflow-hidden rounded-xl border border-line bg-surface shadow-sm lg:sticky lg:top-32 lg:h-[calc(100vh-9.5rem)]">{preview}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Tabs inside the edit pane ("Blocks", "Page settings"), all rendered, the others hidden. `badge` is a
 * count of issues; `extra` anything else the tab should carry (the SEO score on the settings tab).
 */
export function PaneTabs<K extends string>({ tabs, active, onChange, label }: { tabs: { key: K; label: string; badge?: number; extra?: ReactNode }[]; active: K; onChange: (key: K) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="mb-4 flex max-w-full gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--line)]">
      {tabs.map((tab) => {
        const on = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(tab.key)}
            onKeyDown={(e) => {
              const i = tabs.findIndex((t) => t.key === tab.key);
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
                const list = e.currentTarget.parentElement;
                onChange(next.key);
                window.requestAnimationFrame(() => list?.querySelector<HTMLElement>(`[data-tab="${next.key}"]`)?.focus());
              }
            }}
            data-tab={tab.key}
            tabIndex={on ? 0 : -1}
            className={cn("inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap", on ? "border-brand text-text" : "border-transparent text-muted hover:border-line-strong hover:text-text")}
          >
            {tab.label}
            {!!tab.badge && <span className="rounded-full bg-danger-bg px-1.5 text-[11px] text-danger tabular-nums">{tab.badge}</span>}
            {tab.extra}
          </button>
        );
      })}
    </div>
  );
}
