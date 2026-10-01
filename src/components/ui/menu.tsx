"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { AnchoredPopover } from "@/components/ui/anchored-popover";

/**
 * A "More" button with a dropdown of actions.
 *
 * A document has a long tail of things you can do to it — mark it as something, retry an IRN,
 * delete the draft — and laying them all out as buttons buries the one or two that matter. This
 * keeps the toolbar to the actions people actually reach for and puts the rest a click away.
 */
export function Menu({
  label = "More",
  icon: Icon,
  children,
  width = 240,
  align = "end",
}: {
  label?: string;
  /**
   * Draw the trigger as this icon alone — a row's "⋯" — the size of an `IconButton`. `label` is then
   * its accessible name and tooltip ("More actions for Sales"), never shown.
   */
  icon?: LucideIcon;
  children: (close: () => void) => React.ReactNode;
  width?: number;
  align?: "start" | "end";
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (anchorRef.current?.contains(target)) return;
      // The panel is portalled to <body>, so it isn't inside the anchor — without this, mousedown
      // on an item would close the menu and the click would never reach the item's handler.
      if (target?.closest?.("[data-menu-panel]")) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      {Icon ? (
        <button
          ref={anchorRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          title={label}
          onClick={() => setOpen((v) => !v)}
          className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-base text-subtle transition-colors hover:bg-surface-sunken hover:text-brand"
        >
          <Icon className="h-4 w-4" />
        </button>
      ) : (
        <button
          ref={anchorRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-9 items-center gap-1 rounded-base border border-line-strong bg-surface px-3 text-sm text-text transition-colors hover:bg-surface-sunken"
        >
          {label}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      )}
      <AnchoredPopover anchorRef={anchorRef} open={open} width={width} align={align}>
        <div role="menu" data-menu-panel className="py-1">
          {children(() => setOpen(false))}
        </div>
      </AnchoredPopover>
    </>
  );
}

export function MenuItem({
  onClick,
  disabled,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`block w-full px-3 py-2 text-left text-sm transition-colors disabled:opacity-50 ${
        danger ? "text-danger hover:bg-danger-bg" : "text-text hover:bg-surface-sunken"
      }`}
    >
      {children}
    </button>
  );
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pb-1 pt-2 text-xs uppercase tracking-wide text-subtle">{children}</div>;
}

export function MenuSeparator() {
  return <div className="my-1 border-t border-line" />;
}
