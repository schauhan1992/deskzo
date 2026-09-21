"use client";

import { useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Columns2, LayoutGrid, Rows3 } from "lucide-react";
import { setViewMode } from "@/actions/view-mode";
import { LAYOUTS, SELECTED_PARAM, type ViewMode, type ViewModeKey } from "@/lib/view-mode";

const OPTIONS: Record<ViewMode, { label: string; icon: typeof Rows3; title: string }> = {
  list: { label: "Table", icon: Rows3, title: "Show the full table" },
  split: { label: "Split", icon: Columns2, title: "Open records beside the list" },
  cards: { label: "Cards", icon: LayoutGrid, title: "One card per record" },
};

/**
 * Switches a list between the full table and the split view, and remembers the choice.
 *
 * The preference lives in a cookie rather than the URL so it survives navigation and sharing a
 * filtered link doesn't impose your layout on whoever opens it. Switching back to the table drops
 * the selected record from the URL — it means nothing there, and leaving it would quietly put the
 * split view back the next time the page reloads.
 */
export function ViewModeToggle({ viewKey, mode }: { viewKey: ViewModeKey; mode: ViewMode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function choose(next: ViewMode) {
    if (next === mode) return;
    startTransition(async () => {
      await setViewMode(viewKey, next);
      const params = new URLSearchParams(searchParams.toString());
      if (next === "list") params.delete(SELECTED_PARAM);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      router.refresh();
    });
  }

  return (
    <div
      role="group"
      aria-label="List layout"
      className={`inline-flex rounded-md border border-line-strong bg-surface p-0.5 ${pending ? "opacity-60" : ""}`}
    >
      {/* Only what this list actually offers — a button for a layout the page cannot render is
          a button that appears to do nothing. */}
      {LAYOUTS[viewKey].offers.map((candidate) => {
        const option = OPTIONS[candidate];
        const Icon = option.icon;
        const active = candidate === mode;
        return (
          <button
            key={candidate}
            type="button"
            aria-pressed={active}
            title={option.title}
            onClick={() => choose(candidate)}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium transition-colors ${
              active ? "bg-brand text-brand-contrast" : "text-muted hover:bg-surface-sunken hover:text-text"
            }`}
          >
            <Icon className="h-4 w-4" />
            <span className="hidden sm:inline">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
