"use client";

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LAYER_POPOVER } from "@/components/ui/layers";
import { cn } from "@/lib/utils";

/** Anything that takes keyboard input, and so must be allowed to take focus. */
const FOCUSABLE_FIELDS = "input, textarea, select, [contenteditable='true']";

/**
 * Whether a mousedown on this target should be swallowed to keep focus on the anchor.
 *
 * Swallowing it is what stops the anchor's blur firing before a click on an option registers, and
 * that is worth keeping. But cancelling mousedown is precisely how a browser is told *not* to move
 * focus — so a panel that did it to everything could never contain a text field: the click lands,
 * the field never focuses, and typing goes nowhere with no error and nothing to see. That is not
 * hypothetical; it is how the "why" box on the renewals stage picker shipped broken.
 *
 * Exported because the failure is invisible in markup — the field renders perfectly and simply does
 * not work — so the rule is asserted directly rather than eyeballed. See `check:renewal-stage`.
 */
export function keepsFocusOnAnchor(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return !element?.closest?.(FOCUSABLE_FIELDS);
}

/**
 * Whether a mousedown landed in an open AnchoredPopover — its content, or its own scrollbar.
 *
 * The panel scrolls in this component's own box, so a press on the scrollbar has that box as its
 * target, not anything the caller rendered inside. An outside-click check that asked only about the
 * caller's content took dragging the scrollbar for a click elsewhere, and closed the panel the moment
 * anybody tried to scroll it (owner, 8 Oct 2026, the Contacts page's Fields filter).
 */
export function insideAnchoredPopover(target: EventTarget | null): boolean {
  return !!(target as { closest?: (selector: string) => unknown } | null)?.closest?.("[data-anchored-popover]");
}

/**
 * A dropdown panel that renders into `document.body` and positions itself against an anchor.
 *
 * An absolutely-positioned panel is clipped by the nearest scrolling ancestor, and a wide table
 * inside `overflow-x-auto` is exactly that — setting `overflow-x` alone makes the browser compute
 * `overflow-y: auto` too, so a picker opened in a table row gets cut off at the container's edge.
 * Portalling out of that subtree and positioning with `fixed` sidesteps it entirely.
 *
 * The trade-off is that a portalled panel no longer moves with its anchor for free, so this tracks
 * scroll and resize and flips above the anchor when there isn't room below.
 */
export function AnchoredPopover({
  anchorRef,
  open,
  children,
  /** Defaults to the anchor's own width, which is what a picker under a field should do. */
  width,
  maxHeight = 320,
  /** "end" right-aligns the panel with the anchor, for a menu that sits near the viewport's edge. */
  align = "start",
  /**
   * "right" opens beside the anchor instead of under it — a collapsed sidebar's group, whose pages
   * have nowhere to go below. Kept on screen: moved up when the anchor is near the bottom.
   */
  side = "bottom",
  /** How far from the anchor's right edge a "right" panel opens — past the padding of what holds it. */
  offset = 6,
  /**
   * The pointer coming onto and leaving the panel — its own box, scrollbar and border included, which
   * the caller's content inside it is not. A menu that opens on hover keeps itself open with these.
   */
  onPointerEnter,
  onPointerLeave,
  /**
   * The height the panel needs to show whole — a calendar, which is no use scrolled. It opens above the
   * anchor when below can't hold that and above has more room.
   */
  fitHeight,
  /** Added to the panel's own classes: a calendar's rounder corners. */
  className,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  children: React.ReactNode;
  width?: number;
  maxHeight?: number;
  align?: "start" | "end";
  side?: "bottom" | "right";
  offset?: number;
  onPointerEnter?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerLeave?: (e: React.PointerEvent<HTMLDivElement>) => void;
  fitHeight?: number;
  className?: string;
}) {
  /** The panel once drawn, so a "right" panel can be placed by the height it really has. */
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    width: number;
    flipped: boolean;
    /** What will actually fit on screen, which is not the same as what the caller asked for. */
    available: number;
  } | null>(null);
  // `createPortal` needs a real `document`, so the panel can't render during SSR. Reading that as
  // external state rather than flipping a flag in an effect keeps it out of the render cycle.
  const isClient = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  useEffect(() => {
    if (!open) return;

    function place() {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      if (side === "right") {
        const room = Math.min(maxHeight, window.innerHeight - 16);
        // Moved up only by as much as the panel actually needs. Reserving the whole `maxHeight` lifted
        // a short group's panel far above the icon that opened it, near the foot of a sidebar.
        const want = panel ? Math.min(panel.scrollHeight + 2, room) : 0;
        const top = Math.max(8, Math.min(rect.top, window.innerHeight - want - 8));
        // `top - 4` because the panel is drawn 4px below `top` (the gap a dropdown keeps from its field).
        const next = { top: top - 4, left: rect.right + offset, width: width ?? rect.width, flipped: false, available: window.innerHeight - top - 8 };
        setPosition((prev) =>
          prev && prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.available === next.available && !prev.flipped ? prev : next,
        );
        return;
      }
      const spaceBelow = window.innerHeight - rect.bottom;
      // Flip up only when below genuinely can't fit and above has more room, so the panel doesn't
      // jump around as the page scrolls past the midpoint.
      const flipped = spaceBelow < Math.min(maxHeight, fitHeight ?? 200) && rect.top > spaceBelow;
      const panelWidth = width ?? rect.width;
      setPosition({
        top: flipped ? rect.top : rect.bottom,
        // Clamped so an end-aligned panel wider than its anchor can't run off the left edge.
        left: align === "end" ? Math.max(8, rect.right - panelWidth) : rect.left,
        width: panelWidth,
        flipped,
        // A panel taller than the room it has does not overflow the viewport — it scrolls inside.
        // Measured rather than assumed, because `maxHeight` is what the caller wants and this is
        // what the window is prepared to give; on a short laptop screen they are rarely the same.
        available: Math.max(140, (flipped ? rect.top : spaceBelow) - 12),
      });
    }

    place();
    // `true` catches scrolling in any ancestor, not just the window — the panel has to follow the
    // table it was opened from.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    // And once something animates into place — a sidebar easing to its collapsed width moves the
    // anchor without a scroll or a resize.
    window.addEventListener("transitionend", place, true);
    // A "right" panel is placed again once drawn, and whenever its content changes height.
    const resized = side === "right" && panel ? new ResizeObserver(place) : null;
    if (resized && panel) resized.observe(panel.firstElementChild ?? panel);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("transitionend", place, true);
      resized?.disconnect();
    };
  }, [open, anchorRef, width, maxHeight, align, side, offset, panel, fitHeight]);

  if (!isClient || !open || !position) return null;

  return createPortal(
    <div
      ref={setPanel}
      data-anchored-popover=""
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onMouseDown={(e) => {
        if (keepsFocusOnAnchor(e.target)) e.preventDefault();
      }}
      style={{
        position: "fixed",
        top: position.flipped ? undefined : position.top + 4,
        bottom: position.flipped ? window.innerHeight - position.top + 4 : undefined,
        left: position.left,
        width: position.width,
        maxHeight: Math.min(maxHeight, position.available),
      }}
      // `overscroll-contain` stops a scroll that reaches the end of the panel from carrying on into
      // the page behind it — which reads as the dropdown dragging the whole app around under it.
      // Above a modal, not level with it: this panel is always opened *from* something, and when
      // that something is a combobox inside a dialog, a popover on the same layer disappears behind
      // the dialog it belongs to.
      className={cn(LAYER_POPOVER, "overscroll-contain overflow-y-auto rounded-lg border border-line bg-surface shadow-lg", className)}
    >
      {children}
    </div>,
    document.body,
  );
}
