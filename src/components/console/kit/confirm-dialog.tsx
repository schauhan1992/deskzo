"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Checkbox } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type ReasonSpec = { label: string; minLength: number; maxLength: number; placeholder?: string };

export type ConfirmBodyProps = {
  confirmLabel: string;
  tone?: "primary" | "danger";
  children?: ReactNode;
  typed?: string;
  checks?: string[];
  reason?: ReasonSpec;
  pending: boolean;
  error: string | null;
  confirmDisabled?: boolean;
  onConfirm: (input: { typed: string; reason: string }) => void;
  onCancel: () => void;
};

/** The fields an operator fills in — the first of these gets focus when the dialog opens. */
const FIELDS = "input:not([disabled]):not([type='hidden']), textarea:not([disabled]), select:not([disabled])";

/**
 * The inside of a confirmation: the consequence, then whatever has to be done before the verb
 * button wakes up — a reason long enough, every "I understand" ticked, the exact word typed.
 *
 * Its inputs live here rather than in `ConfirmDialog`, so they reset by unmounting: the dialog
 * renders nothing while closed, and opening it again starts from empty fields — no half-typed slug
 * left over from last time, and no effect that clears state after a render has already shown it.
 *
 * Exported for dialogs that confirm and then show something else in the same frame (the bulk run
 * swaps this for its per-row results); everything else uses `ConfirmDialog`.
 */
export function ConfirmBody({
  confirmLabel,
  tone = "primary",
  children,
  typed,
  checks,
  reason,
  pending,
  error,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmBodyProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [typedValue, setTypedValue] = useState("");
  const [reasonValue, setReasonValue] = useState("");
  // Keyed by the sentence, not its position: a preview that arrives later and rewrites a check
  // leaves the new wording unticked instead of carrying over a tick given to the old one.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    // The dialog moves focus to its first control (the close button) in its own effect, which runs
    // after this one — so wait a frame and then put focus where the typing starts.
    const frame = window.requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLElement>(FIELDS)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const word = typed?.trim() ?? "";
  const typedOk = word === "" || typedValue.trim() === word;
  const checkList = checks ?? [];
  const checksOk = checkList.every((text) => ticked.has(text));
  const reasonText = reasonValue.trim();
  const remaining = reason ? Math.max(0, reason.minLength - reasonText.length) : 0;
  const ready = typedOk && checksOk && remaining === 0 && !confirmDisabled;
  const canConfirm = ready && !pending;

  function confirm() {
    if (!canConfirm) return;
    onConfirm({ typed: typedValue.trim(), reason: reasonText });
  }

  function toggle(text: string, on: boolean) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(text);
      else next.delete(text);
      return next;
    });
  }

  function onTypedKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    confirm();
  }

  function onReasonKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter is a new line in a reason; Ctrl/⌘+Enter sends it.
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    confirm();
  }

  const reasonId = `${id}-reason`;
  const reasonHintId = `${id}-reason-hint`;
  const typedId = `${id}-typed`;

  return (
    // p-0.5: the dialog body scrolls, and a scroll box clips the focus ring of a field at its edge.
    <div ref={rootRef} className="space-y-4 p-0.5">
      {children && <div className="space-y-3 text-sm text-text">{children}</div>}

      {reason && (
        <div className="space-y-1.5">
          <Label htmlFor={reasonId}>{reason.label}</Label>
          <Textarea
            id={reasonId}
            value={reasonValue}
            onChange={(e) => setReasonValue(e.target.value)}
            onKeyDown={onReasonKeyDown}
            maxLength={reason.maxLength}
            placeholder={reason.placeholder}
            rows={3}
            aria-describedby={reasonHintId}
            aria-required={reason.minLength > 0 || undefined}
            readOnly={pending}
          />
          <p id={reasonHintId} className={cn("text-xs tabular-nums", remaining > 0 ? "text-muted" : "text-subtle")}>
            {remaining > 0 ? `${remaining} more character${remaining === 1 ? "" : "s"}` : `${reasonValue.length} / ${reason.maxLength}`}
          </p>
        </div>
      )}

      {checkList.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="sr-only">Confirm before going on</legend>
          {checkList.map((text, i) => {
            const checkId = `${id}-check-${i}`;
            return (
              <div key={`${i}-${text}`} className="flex items-start gap-2.5">
                <Checkbox id={checkId} checked={ticked.has(text)} onChange={(e) => toggle(text, e.target.checked)} disabled={pending} className="mt-0.5 shrink-0" />
                <label htmlFor={checkId} className="cursor-pointer text-sm text-text">
                  {text}
                </label>
              </div>
            );
          })}
        </fieldset>
      )}

      {word !== "" && (
        <div className="space-y-1.5">
          <Label htmlFor={typedId}>
            Type <span className="font-mono break-all text-text">{word}</span> to confirm
          </Label>
          <Input
            id={typedId}
            value={typedValue}
            onChange={(e) => setTypedValue(e.target.value)}
            onKeyDown={onTypedKeyDown}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore=""
            maxLength={200}
            readOnly={pending}
            className="font-mono"
          />
        </div>
      )}

      <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />

      {/* Sticky, so a long impact list scrolls under the buttons rather than pushing them away. */}
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        {/*
          * Inert rather than disabled while pending: disabling the button that has focus drops focus
          * to <body>, outside the dialog, and the refusal then arrives with nothing focused near it.
          */}
        <Button
          type="button"
          variant={tone === "danger" ? "danger" : "primary"}
          onClick={confirm}
          disabled={!ready}
          aria-disabled={pending || undefined}
          aria-busy={pending || undefined}
          className={pending ? "cursor-wait opacity-70" : undefined}
        >
          {pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Every console confirmation (spec §1.12) — the replacement for `window.confirm`.
 *
 *   T1: a title that is the verb, one consequence sentence as `children`, Cancel and the verb.
 *   T2: `children` carries the impact (`ImpactList`, `DiffChips`, `AffectedList`), plus `reason`
 *       and/or `checks` when the change needs a why or an "I understand".
 *   T3: `typed` — the button stays off until that exact word is typed. The typed text is handed to
 *       `onConfirm`, so an action that checks it on the server (closing a workspace) can.
 *
 * While `pending` the dialog cannot be dismissed: closing it mid-flight would drop the refusal the
 * operator is waiting to read, and leave them unsure whether anything happened.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  wide,
  pending,
  ...body
}: Omit<ConfirmBodyProps, "onCancel"> & { open: boolean; onClose: () => void; title: string; wide?: boolean }) {
  const close = () => {
    if (!pending) onClose();
  };
  return (
    <Dialog open={open} onClose={close} title={title} wide={wide}>
      <ConfirmBody {...body} pending={pending} onCancel={close} />
    </Dialog>
  );
}
