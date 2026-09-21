"use client";

import { X } from "lucide-react";
import { useModalA11y } from "@/components/ui/use-modal-a11y";

export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  // Escape, the scroll lock, the focus trap and the accessible name — see use-modal-a11y.ts.
  const { titleId, containerRef } = useModalA11y(open, onClose);

  if (!open) return null;

  return (
    /**
     * The positioning layer, and nothing more.
     *
     * It used to carry `role="dialog" aria-modal="true"` as well, which put two nested dialogs on
     * the page — and the outer one, which is the one a screen reader reaches first, had no
     * accessible name and contained the backdrop. The role belongs on the card that holds the title
     * and the focus trap.
     */
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 animate-fade-in bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      {/* Full-width sheet on phones, centred card from small screens up. */}
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-lg animate-scale-in rounded-t-2xl border border-line bg-surface p-5 shadow-lg sm:rounded-xl"
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
        <div className="mt-4 max-h-[75vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
