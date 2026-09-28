"use client";

import { useId, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { ActionNotice } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import type { ConsoleResult } from "@/actions/platform/console";
import type { Tone } from "@/lib/console-shared/types";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./confirm-dialog";
import { ImpactList } from "./impact";
import { useConsoleAction } from "./use-console-action";

/**
 * What to ask before running. `body` is the one consequence sentence (T1); `impact` adds the lines
 * of what changes (T2, static — a preview fetched from the server needs its own dialog); `typed` the
 * word to type (T3, checked in the browser only — the bound action cannot receive it).
 */
export type ConfirmSpec = {
  title: string;
  body: string;
  impact?: { label: string; value: string; tone?: Tone }[];
  confirmLabel?: string;
  tone?: "primary" | "danger";
  typed?: string;
  checks?: string[];
};

/** "Switch off…" asks; its dialog's button just does — "Switch off". */
const withoutEllipsis = (label: string) => label.replace(/(…|\.\.\.)\s*$/, "").trim();

/**
 * One console action as a button, for server pages: pass a server action with its arguments already
 * bound (`consoleReopen.bind(null, tenant.id)`), and optionally the confirmation to ask first. On
 * success the page notice says so and the page refreshes; a refusal stays in the dialog that asked,
 * or — with no dialog — under the button.
 *
 * `results` picks the notice by what the action returned (`String(result.data)`), for actions whose
 * answer is one of a few outcomes ("held", "lifted", "unchanged"); `success` is the fallback.
 *
 * `disabledReason` keeps the button in place, switched off, with the reason printed beside it —
 * a control that vanishes teaches nobody why it is not there.
 */
export function ActionButton({
  action,
  label,
  icon,
  variant = "secondary",
  size = "sm",
  confirm,
  success,
  results,
  disabledReason,
  className,
}: {
  action: () => Promise<ConsoleResult<unknown>>;
  label: string;
  icon?: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "subtle";
  size?: "sm" | "md";
  confirm?: ConfirmSpec;
  success?: string;
  results?: Record<string, string>;
  disabledReason?: string;
  className?: string;
}) {
  const { pending, error, run, reset } = useConsoleAction<unknown>();
  const [open, setOpen] = useState(false);
  const reasonId = useId();

  function noticeFor(data: unknown): string {
    const key = String(data);
    if (results && Object.prototype.hasOwnProperty.call(results, key)) return results[key] ?? "";
    return success ?? "";
  }

  function go() {
    run(action, { success: noticeFor, onDone: () => setOpen(false) });
  }

  function onClick() {
    if (pending) return;
    reset();
    if (confirm) setOpen(true);
    else go();
  }

  function close() {
    setOpen(false);
    reset();
  }

  if (disabledReason) {
    return (
      <span className={cn("inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1", className)}>
        <Button type="button" variant={variant} size={size} disabled aria-describedby={reasonId}>
          {icon}
          {label}
        </Button>
        <span id={reasonId} className="text-xs text-muted">
          {disabledReason}
        </span>
      </span>
    );
  }

  const button = (
    // Inert rather than disabled while pending. The dialog hands focus back to this button when it
    // closes, and a disabled button cannot take it — focus would fall to <body>, and the next Tab
    // would start again from the top of the page.
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={onClick}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      className={cn(pending && "cursor-wait opacity-70", confirm && className)}
    >
      {/* The spinner only when there is no dialog to show it — otherwise the dialog's button spins. */}
      {pending && !confirm ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : icon}
      {label}
    </Button>
  );

  if (!confirm) {
    return (
      <span className={cn("inline-flex max-w-full flex-col items-start gap-1", className)}>
        {button}
        {error && <ActionNotice tone="error">{error}</ActionNotice>}
      </span>
    );
  }

  const tone = confirm.tone ?? (variant === "danger" ? "danger" : "primary");
  return (
    <>
      {button}
      <ConfirmDialog
        open={open}
        onClose={close}
        title={confirm.title}
        confirmLabel={confirm.confirmLabel ?? withoutEllipsis(label)}
        tone={tone}
        typed={confirm.typed}
        checks={confirm.checks}
        pending={pending}
        error={error}
        onConfirm={go}
      >
        <p>{confirm.body}</p>
        {confirm.impact && confirm.impact.length > 0 && <ImpactList items={confirm.impact} />}
      </ConfirmDialog>
    </>
  );
}
