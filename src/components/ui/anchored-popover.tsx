"use client";

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";

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
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  children: React.ReactNode;
  width?: number;
  maxHeight?: number;
  align?: "start" | "end";
}) {
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
      const spaceBelow = window.innerHeight - rect.bottom;
      // Flip up only when below genuinely can't fit and above has more room, so the panel doesn't
      // jump around as the page scrolls past the midpoint.
      const flipped = spaceBelow < Math.min(maxHeight, 200) && rect.top > spaceBelow;
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
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchorRef, width, maxHeight, align]);

  if (!isClient || !open || !position) return null;

  return createPortal(
    <div
      // Keeping mousedown from reaching the document stops the anchor's blur firing before a click
      // on an option registers.
      onMouseDown={(e) => e.preventDefault()}
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
      className="z-50 overscroll-contain overflow-y-auto rounded-lg border border-line bg-surface shadow-lg"
    >
      {children}
    </div>,
    document.body,
  );
}
