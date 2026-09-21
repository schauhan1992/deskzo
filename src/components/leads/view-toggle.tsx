"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { LayoutGrid, Rows3, Columns2 } from "lucide-react";
import { setViewMode } from "@/actions/view-mode";
import { SELECTED_PARAM, type ViewMode } from "@/lib/view-mode";

type LeadView = "board" | "list" | "split";

const TABS: { key: LeadView; label: string; icon: typeof LayoutGrid }[] = [
  { key: "board", label: "Board", icon: LayoutGrid },
  { key: "list", label: "Table", icon: Rows3 },
  { key: "split", label: "Split", icon: Columns2 },
];

/**
 * Board, table, or one lead open beside the list.
 *
 * Board versus list stays in the URL because they're genuinely different views of the pipeline and
 * a link to the board should open the board. Table versus split is a layout preference, so it's
 * remembered in a cookie instead — the same way every other list does it.
 */
export function ViewToggle({
  view,
  mode,
  otherParams,
}: {
  view: "board" | "list";
  /** The remembered table/split choice, which only applies while `view` is "list". */
  mode: ViewMode;
  otherParams: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const active: LeadView = view === "board" ? "board" : mode === "split" ? "split" : "list";

  function go(key: LeadView) {
    if (key === active) return;
    startTransition(async () => {
      if (key !== "board") await setViewMode("leads", key === "split" ? "split" : "list");
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(otherParams)) if (v) params.set(k, v);
      if (key === "board") params.delete(SELECTED_PARAM);
      else params.set("view", "list");
      const query = params.toString();
      router.push(query ? `/leads?${query}` : "/leads", { scroll: false });
      router.refresh();
    });
  }

  return (
    <div
      role="group"
      aria-label="Pipeline view"
      className={`inline-flex rounded-md border border-line-strong bg-surface p-0.5 ${pending ? "opacity-60" : ""}`}
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = active === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            aria-pressed={isActive}
            onClick={() => go(tab.key)}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium transition-colors ${
              isActive ? "bg-brand text-brand-contrast" : "text-muted hover:bg-surface-sunken hover:text-text"
            }`}
          >
            <Icon className="h-4 w-4" />
            <span className="hidden sm:inline">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
