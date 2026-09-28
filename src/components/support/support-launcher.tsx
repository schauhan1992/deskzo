"use client";

import { useState, useSyncExternalStore } from "react";
import { ChevronLeft, Headset, X } from "lucide-react";
import { SupportDialog } from "@/components/support/support-dialog";
import { COLLAPSED_STORAGE_KEY, type LauncherState } from "@/lib/support/types";
import { cn } from "@/lib/utils";

/**
 * The "Contact Support" button, fixed at the bottom right of every workspace page, and the dialog it
 * opens (src/components/support/support-dialog.tsx).
 *
 * Whether it appears at all is the server's decision: the dashboard layout renders this only when
 * `supportLauncherState()` returns a state — not for a view-as, platform support staff, or while
 * support is switched off (src/actions/support.ts). Nothing here second-guesses that.
 *
 * **Clear of the tool rail.** From `xl` the rail (src/components/layout/side-rail.tsx) is a
 * full-height column down the right edge, 48px wide and wider with a tool open, and a button at
 * `right-6` would sit on it. So the width is measured — the layout marks the rail's wrapper
 * `data-side-rail` — and the button keeps 24px to its left. Until it has been measured, and on the
 * server, `xl:right-[72px]` is the closed rail's answer, so the first paint is already right.
 *
 * `z-30`: over the page and the sticky header (z-20), under every overlay — dialogs, the celebration
 * splash (z-[60]) and the DLP guard's bottom-centre toast (z-[96]) all paint over it, never under.
 *
 * Below `md` it is a round icon; from `md` a pill with its label, which a small × on hover or focus
 * shrinks to the icon. That choice is remembered in this browser (`wroffy:support-collapsed`), read
 * through `useSyncExternalStore` so the server's HTML is always the pill and nothing mismatches.
 */

/** Where the layout marks the rail's wrapper. */
const RAIL_SELECTOR = "[data-side-rail]";
/** The gap kept to the rail's left — the same 24px as `md:right-6` keeps to the window's edge. */
const RAIL_GAP_PX = 24;
/** Fired in this tab when the collapsed choice changes; `storage` covers the other tabs. */
const COLLAPSED_EVENT = "wroffy:support-collapsed-change";

export function SupportLauncher({ state }: { state: LauncherState }) {
  const [open, setOpen] = useState(false);
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, expandedOnServer);
  const railWidth = useSyncExternalStore(subscribeRail, readRailWidth, unmeasuredOnServer);

  return (
    <>
      <div
        className={cn(
          "group fixed bottom-4 right-4 z-30 md:bottom-6 md:right-6 xl:right-[72px]",
          // Hidden, not removed, while the dialog (or a recording) is open: it is where the dialog
          // hands the focus back when it closes, and the recording bar is the control meanwhile.
          open && "invisible",
        )}
        style={railWidth ? { right: railWidth + RAIL_GAP_PX } : undefined}
      >
        <button
          type="button"
          aria-label="Contact support"
          aria-haspopup="dialog"
          title={collapsed ? "Contact support" : undefined}
          onClick={() => setOpen(true)}
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-full bg-brand text-brand-contrast shadow-lg",
            "transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.97]",
            !collapsed && "md:h-11 md:w-auto md:gap-2 md:px-4",
          )}
        >
          <Headset aria-hidden="true" className="h-5 w-5 shrink-0" />
          {!collapsed && <span className="hidden text-sm font-medium md:inline">Contact Support</span>}
        </button>
        {/*
          Only from md: below it the button is already just the icon. Untouchable while invisible, so
          a tap on a tablet can't hit a control nobody could see.
        */}
        <button
          type="button"
          aria-label={collapsed ? "Show the Contact Support label" : "Shrink Contact Support to an icon"}
          title={collapsed ? "Show the label" : "Shrink to an icon"}
          onClick={() => setCollapsed(!collapsed)}
          className={cn(
            "absolute -left-1.5 -top-1.5 hidden h-5 w-5 place-items-center rounded-full border border-line bg-surface text-muted shadow-sm md:grid",
            "pointer-events-none opacity-0 transition-opacity hover:text-text",
            "focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          )}
        >
          {collapsed ? <ChevronLeft aria-hidden="true" className="h-3 w-3" /> : <X aria-hidden="true" className="h-3 w-3" />}
        </button>
      </div>

      <SupportDialog state={state} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

// ─── The collapsed choice ──────────────────────────────────────────────────────────────────────

function subscribeCollapsed(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(COLLAPSED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(COLLAPSED_EVENT, onChange);
  };
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function expandedOnServer(): boolean {
  return false;
}

function setCollapsed(collapsed: boolean) {
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSED_STORAGE_KEY, "1");
    else window.localStorage.removeItem(COLLAPSED_STORAGE_KEY);
  } catch {
    // Private browsing, or storage switched off: the choice holds for this page view only — the
    // event below still tells the button — which beats the click doing nothing.
  }
  window.dispatchEvent(new Event(COLLAPSED_EVENT));
}

// ─── The rail's width ──────────────────────────────────────────────────────────────────────────

function subscribeRail(onChange: () => void) {
  const rail = document.querySelector(RAIL_SELECTOR);
  // Opening a tool widens the rail and crossing `xl` hides or shows it; both resize the wrapper.
  const observer = rail && typeof ResizeObserver === "function" ? new ResizeObserver(() => onChange()) : null;
  if (rail && observer) observer.observe(rail);
  window.addEventListener("resize", onChange);
  return () => {
    observer?.disconnect();
    window.removeEventListener("resize", onChange);
  };
}

/** The rail's width in pixels; 0 where it is hidden (below `xl`) or absent. */
function readRailWidth(): number | null {
  const rail = document.querySelector<HTMLElement>(RAIL_SELECTOR);
  return rail ? rail.offsetWidth : 0;
}

function unmeasuredOnServer(): number | null {
  return null;
}
