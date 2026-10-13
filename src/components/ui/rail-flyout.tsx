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
  /** Left out for a plain list of names, as the tenant app's sidebar draws its groups. */
  icon?: ReactNode;
  active: boolean;
  /** Read after the label by assistive tech and shown at the row's end — "3 new". */
  badge?: { text: string; label: string };
};

/** How long the pointer rests on an icon before its pages open — sweeping past an icon on the way to another opens nothing. */
const OPEN_DELAY_MS = 90;
/** How long the panel waits once the pointer has left both the icon and the panel. The gap between them is crossed well inside it. */
const CLOSE_DELAY_MS = 220;

/** A mouse or a stylus, which hover. A finger doesn't: on a touch screen a tap opens the panel instead. */
const hovers = (pointerType: string | null) => pointerType === "mouse" || pointerType === "pen";

/** The one flyout open on the page. Opening another closes it at once, so two panels never show together. */
let closeOpenFlyout: (() => void) | null = null;

/** Focus the current page's link in the panel, so a keyboard lands where you are, or else its first. */
function focusInto(panel: HTMLElement | null) {
  const current = panel?.querySelector<HTMLAnchorElement>("[aria-current='page']");
  (current ?? panel?.querySelector<HTMLAnchorElement>("[role='menuitem']"))?.focus();
}

/**
 * One group of a collapsed sidebar: a single icon that opens its pages beside it.
 *
 * A collapsed sidebar used to flatten every group into one column of icons — forty of them in the
 * tenant app, several sharing an icon, their names only in a hover title that a keyboard or a touch
 * screen never shows — so the pages inside a group were hard to find and, for some people, out of
 * reach. Now each group is one button, marked when the page you are on is inside it, and its pages
 * open, named, in a panel beside the rail.
 *
 * With a mouse the panel opens on hover: resting on the icon opens it, and it stays open while the
 * pointer is on the icon or the panel, closing a moment after it has left both. A click opens it
 * too, and never closes one already open — the click that follows a hover must not undo it. From
 * the keyboard (Enter, Space, ↓ or →) or a tap it opens with focus inside, and stays until Escape,
 * Tab, a click elsewhere or a page is chosen; arrow keys move through it.
 *
 * The panel is portalled to the page body (AnchoredPopover), so the sidebar's own scrolling can't clip
 * it, and it is kept on screen and scrolls inside itself when the group is long. Pressing the button
 * never navigates by itself, so opening a group can't take you anywhere you didn't pick. The pages are
 * whatever the caller passes — each sidebar's own, already filtered to what this person may open — so
 * nothing here decides who sees what.
 */
export function RailFlyout({
  label,
  icon,
  items,
  onNavigate,
  className,
  offset = 16,
  itemClassName,
  headingClassName,
  panelClassName,
}: {
  label: string;
  icon: ReactNode;
  items: RailFlyoutItem[];
  onNavigate?: () => void;
  /** The trigger's box, to match the sidebar's own rail items. */
  className?: string;
  /** From the trigger's right edge to the panel: far enough to clear the rail's edge. */
  offset?: number;
  /** Added to each page's link in the panel — a sidebar's own text size for its pages. */
  itemClassName?: string;
  /** Added to the group's name at the top of the panel — a sidebar's own size for its headings. */
  headingClassName?: string;
  /** Added to the panel itself — a sidebar's own colours, which a portalled panel doesn't inherit. */
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** "hover": opened by a pointer, and closed by it leaving. "press": opened from the keyboard or by a tap, focus inside. */
  const openedBy = useRef<"hover" | "press">("hover");
  /** The pointer behind the click about to arrive — none at all for a keyboard's Enter or Space. */
  const pressedWith = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const menuId = useId();
  const pathname = usePathname();
  const active = items.some((i) => i.active);

  // A page chosen — by this panel or anything else — closes it.
  const [openedOn, setOpenedOn] = useState(pathname);
  if (open && openedOn !== pathname) {
    setOpen(false);
    setOpenedOn(pathname);
  }

  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const close = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  function show(by: "hover" | "press") {
    clearTimer();
    openedBy.current = by;
    setOpenedOn(pathname);
    setOpen(true);
  }

  /** The pointer is resting on the icon: open after a moment, unless it moves on first. */
  function hoverIn() {
    clearTimer();
    if (open) return;
    timer.current = window.setTimeout(() => show("hover"), OPEN_DELAY_MS);
  }

  /** The pointer has left the icon or the panel: close after a moment, unless it comes back onto either. */
  function hoverOut() {
    clearTimer();
    if (!open || openedBy.current !== "hover") return;
    timer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }

  /**
   * Focus goes into the panel when it appears from the keyboard or a tap — not from a hover, which
   * must never take focus from wherever it is. A callback ref, because the panel is drawn only once
   * it has been placed, a render after `open` turns true.
   */
  // Stable, so it runs when the panel appears and not again on every re-render (a scroll re-places it).
  const placePanel = useCallback((el: HTMLDivElement | null) => {
    panelRef.current = el;
    if (el && openedBy.current === "press") focusInto(el);
  }, []);

  // One panel at a time, whichever sidebar it is in.
  useEffect(() => {
    if (!open) return;
    if (closeOpenFlyout && closeOpenFlyout !== close) closeOpenFlyout();
    closeOpenFlyout = close;
    return () => {
      if (closeOpenFlyout === close) closeOpenFlyout = null;
    };
  }, [open, close]);

  useEffect(() => clearTimer, [clearTimer]);

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
      close();
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
      close();
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
        onPointerEnter={(e) => hovers(e.pointerType) && hoverIn()}
        onPointerLeave={(e) => hovers(e.pointerType) && hoverOut()}
        onPointerDown={(e) => {
          pressedWith.current = e.pointerType;
        }}
        onClick={() => {
          const pointer = pressedWith.current;
          pressedWith.current = null;
          if (hovers(pointer)) {
            // Usually open already, from the hover a click follows. Opening is all a click does.
            if (!open) show("hover");
            return;
          }
          if (open) close();
          else show("press");
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowRight") {
            e.preventDefault();
            if (open) {
              openedBy.current = "press";
              focusInto(panelRef.current);
            } else {
              show("press");
            }
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            close();
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
      </button>
      {/* Past the rail's padding, so the panel starts beside the rail rather than over its edge. */}
      <AnchoredPopover
        anchorRef={anchorRef}
        open={open}
        side="right"
        offset={offset}
        width={240}
        maxHeight={560}
        onPointerEnter={(e) => hovers(e.pointerType) && clearTimer()}
        onPointerLeave={(e) => hovers(e.pointerType) && hoverOut()}
      >
        <div ref={placePanel} id={menuId} role="menu" aria-label={label} onKeyDown={onKeyDown} className={panelClassName}>
          {/* The group's name, kept in view while a long group scrolls under it. */}
          <p
            aria-hidden="true"
            className={cn("sticky top-0 z-[1] bg-surface px-3.5 pt-3 pb-1.5 text-[10px] font-semibold tracking-[0.08em] text-subtle uppercase", headingClassName)}
          >
            {label}
          </p>
          <div className="space-y-0.5 px-1.5 pb-1.5">
            {items.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                role="menuitem"
                aria-current={item.active ? "page" : undefined}
                aria-label={item.badge ? `${item.label}, ${item.badge.label}` : undefined}
                onClick={() => {
                  close();
                  onNavigate?.();
                }}
                className={cn(
                  "flex h-8 items-center gap-2.5 rounded-base px-2 text-[13px] font-medium outline-none transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-brand/40",
                  item.active ? "bg-brand-subtle text-brand" : "text-muted hover:bg-surface-sunken hover:text-text focus:bg-surface-sunken focus:text-text",
                  itemClassName,
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
        </div>
      </AnchoredPopover>
    </>
  );
}
