"use client";

import { useEffect, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { LAYER_MODAL } from "@/components/ui/layers";

/**
 * A box that can fill the screen (owner, 16 Oct 2026) — for a dense screen such as a role's Module
 * access, whose record table ran off the box's right edge. The button sits in the box's own top-right
 * corner; Escape, or the button again, puts the box back where it was.
 *
 * Not a dialog: the same box restyled in place, so nothing inside remounts and nothing ticked or
 * typed is lost on the way in or out. The page behind stops scrolling while it is open; dropdowns
 * portal above it (LAYER_POPOVER), and a dialog opened from inside it renders inside it.
 *
 * Usage: `const fv = useFullView()`, add `fv.frameClass` to the box's classes with `cn` (it overrides
 * the box's rounding, border and overflow), and put `<FullViewButton {...fv} />` in its top-right.
 */
export function useFullView() {
  const [full, setFull] = useState(false);

  useEffect(() => {
    if (!full) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      // Not an Escape something inside has already dealt with — a combobox closing its list — nor
      // one meant for a dialog open over the box: that closes the dialog, and the next one this.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      setFull(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [full]);

  return {
    full,
    toggle: () => setFull((f) => !f),
    /**
     * Fills the screen and scrolls inside itself; a column, so a sticky footer sits at the bottom.
     * `m-0` because a parent's `space-y-*` margin stays on a fixed box and leaves a strip of page below.
     */
    frameClass: full ? `fixed inset-0 m-0 ${LAYER_MODAL} flex flex-col overflow-auto rounded-none border-0 bg-surface` : "",
  };
}

export function FullViewButton({ full, toggle }: { full: boolean; toggle: () => void }) {
  return <IconButton icon={full ? Minimize2 : Maximize2} label={full ? "Exit full view (Esc)" : "Full view"} aria-pressed={full} onClick={toggle} />;
}
