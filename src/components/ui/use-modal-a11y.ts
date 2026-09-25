"use client";

import { useEffect, useId, useRef } from "react";

/**
 * The three things an overlay owes a keyboard user, in one place.
 *
 * `Dialog` and `SidePane` each did part of this and neither did all of it: `Dialog` locked the page
 * scroll and handled Escape but never named itself or held focus; `SidePane` was a bare `<div>` with
 * an Escape handler — not announced as a dialog at all, and the page behind it went on scrolling.
 * Tabbing out of either landed silently in the page underneath, which a sighted mouse user never
 * notices and a screen-reader user cannot recover from.
 *
 *   · **Named.** `role="dialog"`, `aria-modal`, and `aria-labelledby` pointing at the title that is
 *     already on screen — so the thing announces what it is rather than reading out as a group of
 *     anonymous buttons.
 *   · **Focused.** Focus moves in on open and returns to whatever opened it on close. Without the
 *     return, dismissing a pane drops focus to `<body>` and the next Tab starts from the top of the
 *     page.
 *   · **Held.** Tab cycles within the overlay rather than wandering behind it.
 *
 * Returns the id to put on the title element and the ref to put on the container.
 */
export function useModalA11y(open: boolean, onClose: () => void) {
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  /**
   * Held in a ref so the effect below depends on `open` alone.
   *
   * Callers pass `onClose` as a closure — `() => setOpen(false)`, or a function declared in the
   * component body — which is a new identity on every render. With `onClose` in the dependency
   * array, every keystroke in any field inside an overlay re-rendered the parent, changed that
   * identity, and tore the whole effect down and back up: the scroll lock was released and
   * re-applied, focus was returned to the element behind the overlay and then moved back in, and
   * "back in" means onto the first focusable control — the close button in the header.
   *
   * The visible result was that typing a passphrase moved focus to the X after *every single
   * character*, so the second character went nowhere. Every overlay in the app shares this hook, so
   * every overlay had it; it only became obvious in a dialog somebody has to type a long string
   * into.
   *
   * A ref rather than `useCallback` at each call site, because that is a rule every future caller
   * would have to know, and the one who forgets gets this bug back.
   */
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;

    returnFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusable = () =>
      Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);

    // Onto the first control rather than the container, so the first Tab goes forwards from
    // somewhere sensible instead of back out to the page.
    const first = focusable()[0];
    (first ?? containerRef.current)?.focus?.();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        /**
         * Only if nothing inside has already dealt with it.
         *
         * This listener is on `document`, so an Escape pressed anywhere in the dialog reaches it —
         * including one a nested widget has just handled. A combobox dismissing its own dropdown
         * calls `preventDefault()` and the dialog then closed on the very same keystroke, throwing
         * away a half-filled form because somebody wanted to close a suggestion list.
         *
         * Checking `defaultPrevented` rather than asking each widget to stop propagation: it holds
         * for every nested escapable thing — the comboboxes, the date picker's calendar, anything
         * added later — without each of them having to remember.
         */
        if (event.defaultPrevented) return;
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const items = focusable();
      if (items.length === 0) return;
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const active = document.activeElement;

      // Wrapped by hand: the browser has no notion of a modal boundary for a div.
      if (event.shiftKey && (active === firstItem || !containerRef.current?.contains(active))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocusTo.current?.focus?.();
    };
  }, [open]);

  return { titleId, containerRef };
}
