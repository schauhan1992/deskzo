"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { OutboundLink } from "@/components/ui/outbound-link";
import { cn } from "@/lib/utils";

/**
 * Copies a value to the clipboard. The clipboard is touched only inside the click — browsers refuse
 * it anywhere else — and the outcome is said out loud through a live region, since a changed icon
 * is only seen.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const pending = timer;
    return () => window.clearTimeout(pending.current);
  }, []);

  async function copy() {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      // Not a secure context, or permission refused: the value is on screen to select by hand.
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 1500);
  }

  return (
    <>
      <IconButton icon={state === "copied" ? Check : Copy} label={label} onClick={copy} className={state === "copied" ? "text-success hover:text-success" : undefined} />
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy — select the text and copy it instead" : ""}
      </span>
    </>
  );
}

/**
 * A value to read and copy: a webhook URL, an external id, a terminal serial. The value is printed as
 * text — never only in an attribute or an input — so it can be read, selected, and found by anything
 * that reads the page's text.
 */
export function CopyField({ value, label, href, hrefLabel, className }: { value: string; label: string; href?: string; hrefLabel?: string; className?: string }) {
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-1", className)}>
      <span className="min-w-0 font-mono text-xs break-all text-text">{value}</span>
      <CopyButton value={value} label={`Copy ${label}`} />
      {href && (
        <OutboundLink href={href} className="inline-flex shrink-0 items-center gap-0.5 rounded-base text-xs font-medium text-brand hover:underline">
          {hrefLabel ?? "Open"}
          <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only"> (opens in a new tab)</span>
        </OutboundLink>
      )}
    </span>
  );
}
