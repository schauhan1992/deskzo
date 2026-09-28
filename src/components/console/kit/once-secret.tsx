"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InsetBlock } from "./panel";

/**
 * A value the server will never show again — an invitation code, a password setup link, a support
 * pass. It is printed as text (selectable in one click, so it can be copied by hand when the
 * clipboard is refused), with a Copy button that says what it copies, and the warning that this is
 * the only chance. Nothing is kept on the client: when the component goes, so does the value.
 *
 * Focus lands on the Copy button when it appears. It usually replaces the form that asked for it,
 * and the button that was pressed has just gone — without this, focus falls to the page behind.
 */
export function OnceSecret({
  label,
  value,
  copyLabel,
  note = "Shown once — it can't be retrieved later.",
  extra,
  onDone,
}: {
  label: string;
  value: string;
  copyLabel: string;
  note?: string;
  extra?: ReactNode;
  onDone?: () => void;
}) {
  const id = useId();
  const copyRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    copyRef.current?.focus({ preventScroll: false });
    const pending = timer;
    return () => window.clearTimeout(pending.current);
  }, []);

  async function copy() {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
    } catch {
      // Not a secure context, or permission refused: the value is on screen, one click selects it.
      setCopied("failed");
    }
    timer.current = window.setTimeout(() => setCopied("idle"), 2000);
  }

  const labelId = `${id}-label`;
  const noteId = `${id}-note`;

  return (
    <div role="group" aria-labelledby={labelId} aria-describedby={noteId} className="space-y-3">
      <InsetBlock>
        <p id={labelId} className="text-xs font-medium text-muted">
          {label}
        </p>
        <div className="mt-1.5 flex flex-wrap items-start justify-between gap-3">
          {/* translate="no": a page translator rewriting a code is a code that no longer works. */}
          <p translate="no" className="min-w-0 flex-1 font-mono text-sm break-all text-text select-all">
            {value}
          </p>
          <Button ref={copyRef} type="button" variant="secondary" size="sm" onClick={copy}>
            {copied === "copied" ? <Check aria-hidden="true" className="h-4 w-4 text-success" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
            {copied === "copied" ? "Copied" : copyLabel}
          </Button>
        </div>
      </InsetBlock>
      <span aria-live="polite" className="sr-only">
        {copied === "copied" ? "Copied" : copied === "failed" ? "Couldn't copy — select the text and copy it instead" : ""}
      </span>
      {copied === "failed" && <p className="text-xs text-danger">Couldn&apos;t copy — select the text and copy it instead.</p>}
      <p id={noteId} className="flex items-start gap-1.5 text-xs text-warning">
        <KeyRound aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
        <span>{note}</span>
      </p>
      {extra}
      {onDone && (
        <div className="flex justify-end">
          <Button type="button" variant="primary" size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      )}
    </div>
  );
}
