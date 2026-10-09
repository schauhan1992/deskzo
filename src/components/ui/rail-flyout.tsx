"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnchoredPopover, insideAnchoredPopover } from "@/components/ui/anchored-popover";
import { cn } from "@/lib/utils";

export type RailFlyoutItem = {
  key: string;
  href: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  /** Read after the label by assistive tech and shown at the row's end — "3 new". */
  badge?: { text: string; label: string };
};

/**
 * One group of a collapsed sidebar: a single icon that opens its pages beside it.
 *
 * A collapsed sidebar used to flatten every group into one column of icons — forty of them in the
 * tenant app, several sharing an icon, their names only in a hover title that a keyboard or a touch
 * screen never shows — so the pages inside a group were hard to find and, for some people, out of
 * reach. Now each group is one button, marked when the page you are on is inside it; pressing it
 * opens the group's pages, named, in a panel beside the rail.
 *
 * The panel is portalled to the page body (AnchoredPopover), so the sidebar's own scrolling can't clip
 * it. It closes on Escape (focus back on the button), a click outside, Tab, or once a page is chosen;
 * arrow keys move through it. Pressing the button never navigates by itself, so opening a group can't
 * take you anywhere you didn't pick. The pages are whatever the caller passes — each sidebar's own,
 * already filtered to what this person may open — so nothing here decides who sees what.
 */
export function RailFlyout({
  label,
  icon,
  items,
  onNavigate,
  className,
}: {
  label: string;
  icon: ReactNode;
  items: RailFlyoutItem[];
  onNavigate?: () => void;
  /** The trigger's box, to match the sidebar's own rail items. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const pathname = usePathname();
  const active = items.some((i) => i.active);

  // A page chosen — by this panel or anything else — closes it.
  const [openedOn, setOpenedOn] = useState(pathname);
  if (open && openedOn !== pathname) {
    setOpen(false);
    setOpenedOn(pathname);
  }

  /**
   * Focus goes into the panel when it appears — the current page's link, so a keyboard lands where you
   * are, or else the first. A callback ref, because the panel is drawn only once it has been placed,
   * a render after `open` turns true.
   */
  // Stable, so it runs when the panel appears and not again on every re-render (a scroll re-places it).
  const placePanel = useCallback((el: HTMLDivElement | null) => {
    panelRef.current = el;
    if (!el) return;
    const current = el.querySelector<HTMLAnchorElement>("[aria-current='page']");
    (current ?? el.querySelector<HTMLAnchorElement>("[role='menuitem']"))?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (anchorRef.current?.contains(e.target as Node) || insideAnchoredPopover(e.target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    const links = Array.from(panelRef.current?.querySelectorAll<HTMLAnchorElement>("[role='menuitem']") ?? []);
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    const go = (i: number) => links[(i + links.length) % links.length]?.focus();
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      anchorRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      go(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      go(at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(links.length - 1);
    } else if (e.key === "Tab") {
      // The panel lives at the end of the page; tabbing on from it would leave the sidebar behind.
      e.preventDefault();
      setOpen(false);
      anchorRef.current?.focus();
    }
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${label}, ${items.length} pages${active ? ", contains the current page" : ""}`}
        title={label}
        onClick={() => {
          setOpenedOn(pathname);
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowRight") {
            e.preventDefault();
            setOpenedOn(pathname);
            setOpen(true);
          }
        }}
        className={cn(
          "relative flex w-full items-center justify-center rounded-base transition-colors duration-150",
          active || open ? "bg-brand-subtle text-brand" : "text-muted hover:bg-surface-sunken hover:text-text",
          className,
        )}
      >
        {active && <span aria-hidden="true" className="absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-r bg-brand" />}
        {icon}
        {/* A group, not a page: the corner mark says it opens rather than goes. */}
        <span aria-hidden="true" className="absolute right-1 bottom-1 h-0 w-0 border-t-[4px] border-l-[4px] border-t-transparent border-l-current opacity-50" />
      </button>
      {/* Past the rail's 10px of padding, so the panel starts beside the rail rather than over its edge. */}
      <AnchoredPopover anchorRef={anchorRef} open={open} side="right" offset={16} width={232} maxHeight={480}>
        <div ref={placePanel} id={menuId} role="menu" aria-label={label} onKeyDown={onKeyDown} className="p-1.5">
          <p className="px-2 pt-1 pb-1.5 text-[10px] font-semibold tracking-[0.08em] text-subtle uppercase">{label}</p>
          {items.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              role="menuitem"
              aria-current={item.active ? "page" : undefined}
              aria-label={item.badge ? `${item.label}, ${item.badge.label}` : undefined}
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              className={cn(
                "flex items-center gap-2.5 rounded-base px-2 py-1.5 text-[13px] font-medium outline-none transition-colors",
                "focus-visible:ring-2 focus-visible:ring-brand/40",
                item.active ? "bg-brand-subtle text-brand" : "text-muted hover:bg-surface-sunken hover:text-text focus:bg-surface-sunken focus:text-text",
              )}
            >
              {item.icon}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.badge && (
                <span aria-hidden="true" className="shrink-0 rounded-full bg-brand-subtle px-1.5 text-[11px] leading-5 font-semibold text-brand tabular-nums">
                  {item.badge.text}
                </span>
              )}
            </Link>
          ))}
        </div>
      </AnchoredPopover>
    </>
  );
}
