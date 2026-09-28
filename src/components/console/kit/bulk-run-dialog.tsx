"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { ConsoleResult } from "@/actions/platform/console";
import type { BulkItemResult, BulkResult, Tone } from "@/lib/console-shared/types";
import { cn } from "@/lib/utils";
import { ConfirmBody } from "./confirm-dialog";
import { AffectedList } from "./impact";
import { useConsoleNotice } from "./notice";
import { SubHeading } from "./panel";
import { StatusPill } from "./status";
import { useConsoleAction } from "./use-console-action";

const INTEGER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

type ItemState = "failed" | "done" | "skipped";

const STATE: Record<ItemState, { label: string; tone: Tone; order: number }> = {
  failed: { label: "Failed", tone: "danger", order: 0 },
  done: { label: "Done", tone: "success", order: 1 },
  skipped: { label: "Skipped", tone: "neutral", order: 2 },
};

const stateOf = (item: BulkItemResult): ItemState => (item.skipped ? "skipped" : item.ok ? "done" : "failed");

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);

/** A result from the server, taken defensively — a missing list is an empty one, not a crash in a dialog. */
function normalise(data: BulkResult): BulkResult {
  const items = Array.isArray(data?.items) ? data.items : [];
  return {
    batchId: String(data?.batchId ?? ""),
    ok: count(data?.ok),
    failed: count(data?.failed),
    skipped: count(data?.skipped),
    items,
  };
}

/** "12 done, 1 failed" — and the skipped, when there were any. */
function summaryOf(r: BulkResult): string {
  const parts = [`${INTEGER.format(r.ok)} done`, `${INTEGER.format(r.failed)} failed`];
  if (r.skipped > 0) parts.push(`${INTEGER.format(r.skipped)} skipped`);
  return `${parts.join(", ")}.`;
}

/**
 * Every bulk action on the workspace directory (spec §1.12, T2): first what will happen and to
 * which rows, then — once it has run — what happened to each one.
 *
 * The server runs the rows one at a time and never stops a batch for one failure, so the answer is
 * a list, not a yes/no: failures first, with their reason, then the ones done, then the ones
 * skipped (the installation's own workspace never takes part). "Done" closes it, refreshes the page
 * and leaves the summary in the page notice; `onFinished` then runs (clear the selection there).
 * Closing with Escape or the × after a run counts as Done — the page must not be left showing the
 * rows as they were before.
 *
 * `preview` is the caller's impact block, from a server preview read; while `previewPending` the run
 * cannot be started, so nobody confirms an impact they have not yet been shown.
 */
export function BulkRunDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  tone = "primary",
  rows,
  preview,
  previewPending = false,
  checks,
  typed,
  run,
  onFinished,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "primary" | "danger";
  rows: { id: string; label: string; note?: string; tone?: Tone }[];
  preview?: ReactNode;
  previewPending?: boolean;
  checks?: string[];
  typed?: string;
  run: () => Promise<ConsoleResult<BulkResult>>;
  onFinished?: (result: BulkResult) => void;
}) {
  const router = useRouter();
  const { show } = useConsoleNotice();
  const { pending, error, run: runAction, reset } = useConsoleAction<BulkResult>();
  const [result, setResult] = useState<BulkResult | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  // Each opening starts at the confirmation, without the last run's results or refusal. Adjusted
  // while rendering, so the old results never paint for a frame.
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setResult(null);
      reset();
    }
  }

  function finish(r: BulkResult) {
    show(r.failed > 0 ? "error" : "success", summaryOf(r));
    router.refresh();
    onFinished?.(r);
    onClose();
  }

  function close() {
    if (pending) return;
    if (result) finish(result);
    else onClose();
  }

  function confirm() {
    runAction(run, { refresh: false, onDone: (data) => setResult(normalise(data)) });
  }

  const labels = new Map(rows.map((r) => [r.id, r.label]));

  return (
    <Dialog open={open} onClose={close} title={title}>
      {/* Mounted for both phases, so the outcome is read out when it arrives. */}
      <p aria-live="polite" className="sr-only">
        {result ? summaryOf(result) : ""}
      </p>
      {result ? (
        <BulkResults result={result} labelFor={(item) => labels.get(item.tenantId) ?? item.slug} onDone={() => finish(result)} />
      ) : (
        <ConfirmBody
          confirmLabel={confirmLabel}
          tone={tone}
          typed={typed}
          checks={checks}
          pending={pending}
          error={error}
          confirmDisabled={previewPending || rows.length === 0}
          onConfirm={confirm}
          onCancel={close}
        >
          <p>{description}</p>
          {previewPending ? (
            <p role="status" className="flex items-center gap-2 text-xs text-muted">
              <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              Working out what would change…
            </p>
          ) : (
            preview
          )}
          <div className="space-y-2">
            <SubHeading>Selected ({INTEGER.format(rows.length)})</SubHeading>
            <AffectedList rows={rows.map((r) => ({ key: r.id, label: r.label, note: r.note, tone: r.tone }))} />
          </div>
        </ConfirmBody>
      )}
    </Dialog>
  );
}

function BulkResults({ result, labelFor, onDone }: { result: BulkResult; labelFor: (item: BulkItemResult) => string; onDone: () => void }) {
  const doneRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // The confirm button that had focus is gone with the form it belonged to.
    doneRef.current?.focus();
  }, []);

  const items = result.items
    .map((item, index) => ({ item, index, state: stateOf(item) }))
    .sort((a, b) => STATE[a.state].order - STATE[b.state].order || a.index - b.index);

  return (
    <div className="space-y-4 p-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill tone={result.ok > 0 ? "success" : "neutral"}>{INTEGER.format(result.ok)} done</StatusPill>
        <StatusPill tone={result.failed > 0 ? "danger" : "neutral"}>{INTEGER.format(result.failed)} failed</StatusPill>
        {result.skipped > 0 && <StatusPill tone="neutral">{INTEGER.format(result.skipped)} skipped</StatusPill>}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted">Nothing was run.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {items.map(({ item, index, state }) => {
            const label = labelFor(item);
            const detail = state === "failed" ? item.error || "Failed without a reason." : item.outcome || (state === "skipped" ? item.error : undefined);
            return (
              <li key={`${index}-${item.tenantId}`} className="flex items-start justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text" title={label}>
                    {label}
                  </p>
                  {label !== item.slug && <p className="font-mono text-xs break-all text-subtle">{item.slug}</p>}
                  {detail && <p className={cn("mt-0.5 text-xs break-words", state === "failed" ? "text-danger" : "text-muted")}>{detail}</p>}
                </div>
                <StatusPill tone={STATE[state].tone} className="mt-0.5 shrink-0">
                  {STATE[state].label}
                </StatusPill>
              </li>
            );
          })}
        </ul>
      )}

      <div className="sticky bottom-0 flex justify-end bg-surface pt-2">
        <Button ref={doneRef} type="button" variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
