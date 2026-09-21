"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { BadgeCheck, CalendarRange, Calculator, CheckSquare, Coins, StickyNote, X } from "lucide-react";
import { SIDE_RAIL_STORAGE_KEY, parseTool, type SideRailTool } from "@/lib/side-rail";
import { RailTasks } from "@/components/layout/rail-tasks";
import { RailNotes } from "@/components/layout/rail-notes";
import { RailCalculator } from "@/components/layout/rail-calculator";
import { RailCurrency } from "@/components/layout/rail-currency";
import { RailLookup } from "@/components/layout/rail-lookup";
import { RailProRata } from "@/components/layout/rail-prorata";

const TOOLS: { key: SideRailTool; label: string; icon: typeof Calculator }[] = [
  { key: "tasks", label: "My tasks", icon: CheckSquare },
  { key: "notes", label: "Sticky notes", icon: StickyNote },
  { key: "calculator", label: "GST & margin", icon: Calculator },
  { key: "prorata", label: "Pro-rata", icon: CalendarRange },
  { key: "currency", label: "Currency", icon: Coins },
  { key: "lookup", label: "GSTIN check", icon: BadgeCheck },
];

/**
 * The tool rail, down the right-hand edge.
 *
 * Read through `useSyncExternalStore` rather than during render. `localStorage` is browser-only, so
 * touching it while rendering gives the server one answer and the client another — which is the
 * hydration mismatch this codebase has already been bitten by once, in the theme toggle. The server
 * snapshot is "closed", so the first paint is always the rail alone and the panel opens after
 * mount; nothing shifts unless the reader had actually left one open.
 *
 * The panel sits beside the content rather than over it. A tool you need *while* reading something
 * is no use if it covers the thing you were reading, which is the whole reason it is not a modal.
 */
export function SideRail() {
  const open = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const choose = useCallback((tool: SideRailTool) => {
    try {
      const next = getSnapshot() === tool ? null : tool;
      if (next) window.localStorage.setItem(SIDE_RAIL_STORAGE_KEY, next);
      else window.localStorage.removeItem(SIDE_RAIL_STORAGE_KEY);
    } catch {
      // Private browsing, or storage turned off. The rail still works for this page view; the
      // choice simply is not remembered, which is a better outcome than the click doing nothing.
    }
    window.dispatchEvent(new Event(SIDE_RAIL_STORAGE_KEY));
  }, []);

  // Escape closes it, like every other dismissible thing in this app.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") choose(open!);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, choose]);

  const active = TOOLS.find((t) => t.key === open);

  return (
    /*
      Runs from the very top rather than starting under the header.

      Sitting below it left a band of page background in the top-right corner, beside the header
      but not part of it, which read as something failing to load. The rail now spans the full
      height and repeats the header's own height and bottom border across itself, so the line under
      the header runs unbroken to the edge of the window and the corner belongs to something.
    */
    <div className="sticky top-0 z-20 flex h-screen shrink-0 border-l border-line bg-surface">
      {active && (
        <aside
          aria-label={active.label}
          className="flex w-72 flex-col overflow-hidden border-r border-line lg:w-80"
        >
          {/* Its title bar lines up with the app header rather than starting below it. */}
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
            <span className="text-sm font-medium text-text">{active.label}</span>
            <button
              type="button"
              onClick={() => choose(active.key)}
              aria-label="Close"
              className="rounded-base p-1 text-muted hover:bg-surface-sunken hover:text-text"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {active.key === "tasks" && <RailTasks />}
            {active.key === "notes" && <RailNotes />}
            {active.key === "calculator" && <RailCalculator />}
            {active.key === "prorata" && <RailProRata />}
            {active.key === "currency" && <RailCurrency />}
            {active.key === "lookup" && <RailLookup />}
          </div>
        </aside>
      )}

      <nav aria-label="Tools" className="flex w-12 shrink-0 flex-col items-center gap-1">
        {/* The header’s height and its border, continued. */}
        <div className="h-14 w-full shrink-0 border-b border-line" />
        <div className="flex flex-col items-center gap-1 py-2">
        {TOOLS.map((tool) => {
          const Icon = tool.icon;
          const isOpen = open === tool.key;
          return (
            <button
              key={tool.key}
              type="button"
              title={tool.label}
              aria-label={tool.label}
              aria-pressed={isOpen}
              onClick={() => choose(tool.key)}
              className={`grid h-9 w-9 place-items-center rounded-base transition-colors ${
                isOpen ? "bg-brand-subtle text-brand" : "text-muted hover:bg-surface-sunken hover:text-text"
              }`}
            >
              <Icon className="h-[18px] w-[18px]" />
            </button>
          );
        })}
        </div>
      </nav>
    </div>
  );
}

function subscribe(onChange: () => void) {
  // Both events: `storage` for the same tool opened in another tab, and our own for this one —
  // `storage` does not fire in the tab that made the change.
  window.addEventListener("storage", onChange);
  window.addEventListener(SIDE_RAIL_STORAGE_KEY, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(SIDE_RAIL_STORAGE_KEY, onChange);
  };
}

function getSnapshot(): SideRailTool | null {
  try {
    return parseTool(window.localStorage.getItem(SIDE_RAIL_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Always closed on the server. There is no reader there whose preference could be known. */
function getServerSnapshot(): SideRailTool | null {
  return null;
}
