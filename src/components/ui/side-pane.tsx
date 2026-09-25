"use client";

import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useModalA11y } from "@/components/ui/use-modal-a11y";
import { LAYER_MODAL } from "@/components/ui/layers";

export function SidePane({
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
  /**
   * The same treatment the dialog beside it gets.
   *
   * This was a bare `<div>` with an Escape handler: nothing announced it as a dialog, focus never
   * entered it or came back on close, and the page behind went on scrolling under it.
   */
  const { titleId, containerRef } = useModalA11y(open, onClose);

  if (!open) return null;

  // Portalled for the same reasons as `Dialog` — see the note there.
  return createPortal(
    <div className={`fixed inset-0 ${LAYER_MODAL}`}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col bg-surface shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 id={titleId} className="text-sm font-semibold text-text">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-subtle hover:bg-surface-sunken hover:text-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
