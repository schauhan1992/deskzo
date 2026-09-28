"use client";

import { useRef, useState, useTransition } from "react";
import { LoaderCircle, Play } from "lucide-react";
import { consolePreviewLifecycle, consoleRunBillingLifecycle } from "@/actions/platform/console-billing";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { AffectedList, ImpactList } from "@/components/console/kit/impact";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import type { Tone } from "@/lib/console-shared/types";

type Preview = { held: string[]; lifted: string[]; closed: string[]; remind: string[] };
type Ran = { held: string[]; lifted: string[]; closed: string[]; reminded: number };

const GROUPS: { key: keyof Preview; label: string; heading: string; tone: Tone }[] = [
  { key: "held", label: "Held", heading: "Would be held", tone: "danger" },
  { key: "closed", label: "Closed", heading: "Would be closed", tone: "danger" },
  { key: "lifted", label: "Hold lifted", heading: "Would have the hold lifted", tone: "success" },
  { key: "remind", label: "Reminded", heading: "Would be sent a reminder", tone: "info" },
];

/**
 * "Run billing lifecycle now" (managers): what the hourly tick does, without waiting for it.
 *
 * Nothing runs from the first click. The dialog asks the server what the run would do right now —
 * who would be held, lifted, closed and reminded — and shows it; when anybody would be held or
 * closed, the operator types `apply` as well. The counts they saw go with the request, and the
 * server refuses a run that would now do more than that, so nobody is held who was not on the list.
 */
export function LifecycleRunButton() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, startPreview] = useTransition();
  const run = useConsoleAction<Ran>();
  // A preview that answers after the dialog was closed (or reopened) belongs to nobody.
  const asked = useRef(0);

  function start() {
    run.reset();
    setPreview(null);
    setPreviewError(null);
    setOpen(true);
    const mine = ++asked.current;
    startPreview(async () => {
      try {
        const result = await consolePreviewLifecycle();
        if (mine !== asked.current) return;
        if (result.ok) setPreview(result.data);
        else setPreviewError(result.error);
      } catch {
        if (mine === asked.current) setPreviewError("Couldn't work out what it would do. Close this and try again.");
      }
    });
  }

  function close() {
    asked.current += 1;
    setOpen(false);
    run.reset();
  }

  const drastic = preview ? preview.held.length + preview.closed.length > 0 : false;
  const nothing = preview ? GROUPS.every((g) => preview[g.key].length === 0) : false;

  function confirm() {
    if (!preview) return;
    const expect = { held: preview.held.length, closed: preview.closed.length };
    run.run(() => consoleRunBillingLifecycle(expect), {
      success: (d) => `Billing lifecycle ran: ${d.held.length} held, ${d.lifted.length} lifted, ${d.closed.length} closed, ${d.reminded} reminded.`,
      onDone: () => {
        asked.current += 1;
        setOpen(false);
      },
    });
  }

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={start}>
        <Play aria-hidden="true" className="h-4 w-4" />
        Run billing lifecycle now
      </Button>
      <ConfirmDialog
        open={open}
        onClose={close}
        title="Run billing lifecycle now"
        confirmLabel={nothing ? "Run anyway" : "Run now"}
        tone={drastic ? "danger" : "primary"}
        typed={drastic ? "apply" : undefined}
        pending={run.pending}
        error={run.error ?? previewError}
        confirmDisabled={!preview || previewing}
        onConfirm={confirm}
      >
        <p>
          Does now what the hourly tick does: applies each open or held workspace&apos;s billing standing, and sends the reminders that are due.
        </p>
        {previewing && (
          <p className="flex items-center gap-2 text-muted">
            <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
            Working out what it would do…
          </p>
        )}
        {preview && (
          <>
            <ImpactList items={GROUPS.map((g) => ({ label: g.label, value: preview[g.key].length, tone: preview[g.key].length > 0 ? g.tone : undefined }))} />
            {nothing ? (
              <p className="text-muted">Nothing is due right now — running it changes no workspace.</p>
            ) : (
              GROUPS.filter((g) => preview[g.key].length > 0).map((g) => (
                <div key={g.key} className="space-y-1.5">
                  <p className="text-xs font-medium text-muted">{`${g.heading} (${preview[g.key].length})`}</p>
                  <AffectedList rows={preview[g.key].map((slug) => ({ key: slug, label: slug, tone: g.tone }))} />
                </div>
              ))
            )}
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
