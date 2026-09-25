"use client";

import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useModalA11y } from "@/components/ui/use-modal-a11y";
import { LAYER_MODAL } from "@/components/ui/layers";

export function Dialog({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** Room for two panes side by side — an editor and its preview. */
  wide?: boolean;
}) {
  // Escape, the scroll lock, the focus trap and the accessible name — see use-modal-a11y.ts.
  const { titleId, containerRef } = useModalA11y(open, onClose);

  if (!open) return null;

  /**
   * Rendered into `<body>`, not where it was written.
   *
   * A dialog is drawn over the whole page, but as a DOM node it lives wherever it was opened from —
   * and that has decided its behaviour twice. Opened from a `<td className="whitespace-nowrap
   * text-right">`, every paragraph inside it stopped wrapping and the content scrolled sideways.
   * Opened from inside the sticky header, whose `sticky z-20` is its own stacking context, its
   * z-index only ever meant "within the header" — so the create menu, portalled to the body at the
   * same level, painted over the top of it.
   *
   * Both are the same fault: a fixed overlay inheriting a context it has no business being in.
   * A portal is the fix for the whole class rather than for the two that were noticed.
   *
   * Checked before doing it: no `Dialog` or `SidePane` in this repo is nested inside a `<form>`,
   * so nothing loses its implicit form association by moving.
   */
  return createPortal(
    /**
     * The positioning layer, and nothing more.
     *
     * It used to carry `role="dialog" aria-modal="true"` as well, which put two nested dialogs on
     * the page — and the outer one, which is the one a screen reader reaches first, had no
     * accessible name and contained the backdrop. The role belongs on the card that holds the title
     * and the focus trap.
     */
    <div className={`fixed inset-0 ${LAYER_MODAL} flex items-end justify-center p-0 sm:items-center sm:p-4`}>
      <div className="absolute inset-0 animate-fade-in bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      {/* Full-width sheet on phones, centred card from small screens up. */}
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        /**
         * `whitespace-normal text-left` because this card is not where it looks like it is.
         *
         * A dialog is drawn over everything, but it is still a DOM descendant of whatever opened
         * it — and inherited text properties do not care about `position: fixed`. Opened from a
         * `<td className="whitespace-nowrap text-right">`, every paragraph in here rendered on one
         * unwrapped line: a two-sentence warning came out 1435px wide inside a 470px card, so the
         * content scrolled sideways and the labels sat against the right edge. Nothing was wrong
         * with the dialog's own markup, which is exactly why it was hard to see.
         *
         * Reset here rather than at each call site, because every future caller would have to
         * remember, and the one that forgets looks broken in a way that points at its own contents.
         */
        className={`relative w-full ${wide ? "max-w-6xl" : "max-w-lg"} animate-scale-in whitespace-normal rounded-t-2xl border border-line bg-surface p-5 text-left shadow-lg sm:rounded-xl`}
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id={titleId} className="text-sm font-semibold text-text">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-base p-1 text-subtle transition-colors hover:bg-surface-sunken hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className={`mt-4 ${wide ? "max-h-[85vh]" : "max-h-[75vh]"} overflow-y-auto`}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
