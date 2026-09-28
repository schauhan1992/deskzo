"use client";

import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert, Undo2, X } from "lucide-react";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { CmsConflict } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

/**
 * The editor's frame pieces shared by pages and posts: the "Saved 2 min ago" line, the
 * conflict and leave-without-saving dialogs, the undo toast after removing a block, and the keyboard
 * shortcuts sheet.
 */

export function SaveState({
  saving,
  dirty,
  blocked,
  conflict,
  failure,
  autosave,
  lastSavedAt,
  neverSaved,
  readOnly,
}: {
  saving: boolean;
  dirty: boolean;
  blocked: number;
  conflict: boolean;
  failure: string | null;
  autosave: boolean;
  lastSavedAt: Date | null;
  neverSaved: string | null;
  readOnly: boolean;
}) {
  let body: ReactNode;
  let tone = "text-subtle";
  if (readOnly) body = "Read only";
  else if (saving) body = (
    <>
      <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
      Saving…
    </>
  );
  else if (conflict) {
    tone = "text-danger";
    body = "Not saved — somebody else saved";
  } else if (dirty && blocked > 0) {
    tone = "text-warning";
    body = `Unsaved — fix ${blocked === 1 ? "1 field" : `${blocked} fields`} to save`;
  } else if (dirty && failure) {
    tone = "text-danger";
    body = "Not saved";
  } else if (dirty) {
    tone = "text-muted";
    body = autosave ? "Unsaved changes · saves itself shortly" : "Unsaved changes";
  } else if (lastSavedAt) {
    body = (
      <>
        <CircleCheck aria-hidden="true" className="h-3.5 w-3.5 text-success" />
        Saved <RelativeTime at={lastSavedAt} />
      </>
    );
  } else body = neverSaved ?? "Saved";
  return (
    <p role="status" aria-live="polite" className={cn("inline-flex items-center gap-1.5 text-xs whitespace-nowrap", tone)}>
      {body}
    </p>
  );
}

/** "Somebody else saved": reload theirs, or keep mine and overwrite. */
export function ConflictDialog({ conflict, what, busy, onReload, onOverwrite, onClose }: { conflict: CmsConflict | null; what: string; busy: boolean; onReload: () => void; onOverwrite: () => void; onClose: () => void }) {
  return (
    <Dialog open={!!conflict} onClose={() => !busy && onClose()} title="Somebody else saved this">
      <div className="space-y-4 text-sm">
        <p className="text-text">
          <span className="font-medium">{conflict?.updatedBy || "Someone"}</span> saved this {what} after you opened it. Saving yours now would overwrite their changes.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-muted">
          <li>
            <span className="font-medium text-text">Reload their version</span> — theirs replaces what is on your screen. Your version stays one Undo away (Ctrl/⌘+Z), to copy anything back.
          </li>
          <li>
            <span className="font-medium text-text">Keep mine and overwrite</span> — yours is saved over theirs.
          </li>
        </ul>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onOverwrite} disabled={busy}>
            Keep mine and overwrite
          </Button>
          <Button type="button" onClick={onReload} disabled={busy}>
            {busy && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            Reload their version
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Leaving with unsaved changes: stay, save and go, or go without saving. */
export function LeaveDialog({ href, canSave, busy, onStay, onLeave, onSaveAndLeave }: { href: string | null; canSave: boolean; busy: boolean; onStay: () => void; onLeave: () => void; onSaveAndLeave: () => void }) {
  return (
    <Dialog open={!!href} onClose={() => !busy && onStay()} title="Leave without saving?">
      <div className="space-y-4 text-sm">
        <p className="text-text">You have changes that aren&apos;t saved yet.</p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onStay} disabled={busy}>
            Stay
          </Button>
          <Button type="button" variant="secondary" onClick={onLeave} disabled={busy} className="text-danger">
            Leave without saving
          </Button>
          {canSave && (
            <Button type="button" onClick={onSaveAndLeave} disabled={busy}>
              {busy && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
              Save and leave
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export type Toast = { id: number; message: string; undo?: () => void };

/** A short-lived message with an Undo — after removing a block. Stays 10 seconds, or until dismissed. */
export function UndoToast({ toast, onDismiss }: { toast: Toast | null; onDismiss: () => void }) {
  const expire = useEffectEvent(() => onDismiss());
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => expire(), 10_000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-4 left-1/2 z-[65] -translate-x-1/2">
      {toast && (
        <div className="pointer-events-auto flex animate-fade-rise items-center gap-3 rounded-lg border border-line bg-surface-raised px-4 py-2.5 text-sm text-text shadow-lg">
          <span>{toast.message}</span>
          {toast.undo && (
            <Button
              type="button"
              variant="subtle"
              size="sm"
              onClick={() => {
                toast.undo?.();
                onDismiss();
              }}
            >
              <Undo2 aria-hidden="true" className="h-4 w-4" />
              Undo
            </Button>
          )}
          <button type="button" onClick={onDismiss} aria-label="Dismiss" className="rounded p-1 text-subtle hover:text-text">
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

/** A banner in the editor: what is wrong or worth knowing, and what to do. */
export function EditorBanner({ tone, title, children, action }: { tone: "info" | "warning" | "danger" | "success"; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === "danger" ? CircleAlert : tone === "warning" ? TriangleAlert : tone === "success" ? CircleCheck : Info;
  const styles = {
    info: "border-info/30 bg-info-bg text-info",
    warning: "border-warning/40 bg-warning-bg text-warning",
    danger: "border-danger/40 bg-danger-bg text-danger",
    success: "border-success/40 bg-success-bg text-success",
  }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-4 py-2.5 text-sm", styles)}>
      <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-48 flex-1">
        <p className="font-medium">{title}</p>
        {children && <div className="mt-0.5 text-[13px] break-words opacity-90">{children}</div>}
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2 self-center">{action}</div>}
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Ctrl/⌘ + S", "Save the draft"],
  ["Ctrl/⌘ + Z", "Undo (outside a text box)"],
  ["Ctrl/⌘ + Shift + Z", "Redo"],
  ["Alt + ↑ / ↓", "Move the block (or item) whose title has focus"],
  ["Ctrl/⌘ + B / I / K", "Bold, italic, link — in rich text"],
  ["Enter / Backspace", "Add or remove a line — in a list of lines"],
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <dl className="divide-y divide-line text-sm">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys} className="flex items-center justify-between gap-4 py-2">
            <dt>
              <kbd className="rounded border border-line-strong bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-text">{keys}</kbd>
            </dt>
            <dd className="text-right text-muted">{what}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

/** A one-line outcome under the editor's top bar ("Published.", "Preview link made"). */
export function useEditorNotice() {
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; message: string; at: number } | null>(null);
  return {
    notice,
    show: (tone: "success" | "error" | "info", message: string) => setNotice({ tone, message, at: Date.now() }),
    clear: () => setNotice(null),
  };
}
