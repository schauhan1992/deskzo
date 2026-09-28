"use client";

import { useRef, useState, useTransition } from "react";
import { Archive, ArchiveRestore, LoaderCircle } from "lucide-react";
import { consoleSavePlan } from "@/actions/platform/console";
import { consolePreviewPlanSave } from "@/actions/platform/console-billing";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/console-shared/format";
import type { Tone } from "@/lib/console-shared/types";
import type { PlanSavePreview } from "@/lib/platform/entitlement-preview";
import type { PlanInput } from "@/lib/platform/plans";

/** Said when the preview itself fails rather than refusing — never the thrown text. */
const PREVIEW_FAILED = "Couldn't work out what this changes. Close this and try again.";

/**
 * Retire a plan, or offer a retired one again, from its card (T2, spec §1.12). The dialog asks the
 * server what the save would do before the button wakes up — how many workspaces are on it, and any
 * refusal in the save's own words — and the save is the plan exactly as the card shows it with only
 * `active` flipped. A retired plan cannot be the default, so retiring the default plan also stops it
 * being one, and the dialog says so.
 */
export function PlanCardActions({ plan, active }: { plan: PlanInput; active: boolean }) {
  const retiring = active;
  const wasDefault = !!plan.isDefault;
  const next: PlanInput = { ...plan, active: !retiring, isDefault: retiring ? false : wasDefault };

  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PlanSavePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, startPreview] = useTransition();
  // A preview that lands after the dialog was closed (or reopened) belongs to nobody.
  const ticket = useRef(0);
  const save = useConsoleAction<{ id: string; workspaces: number }>();

  function openDialog() {
    save.reset();
    setPreview(null);
    setPreviewError(null);
    setOpen(true);
    const mine = ++ticket.current;
    startPreview(async () => {
      try {
        const result = await consolePreviewPlanSave(next);
        if (mine !== ticket.current) return;
        if (result.ok) setPreview(result.data);
        else setPreviewError(result.error);
      } catch {
        if (mine === ticket.current) setPreviewError(PREVIEW_FAILED);
      }
    });
  }

  function close() {
    ticket.current++;
    setOpen(false);
  }

  function confirm() {
    save.run(() => consoleSavePlan(next), {
      success: retiring ? `${plan.name} retired.` : `${plan.name} is offered again.`,
      onDone: () => setOpen(false),
    });
  }

  const impact: { label: string; value: string; tone?: Tone }[] = [];
  if (preview) {
    impact.push({
      label: "Workspaces on it",
      value: preview.workspaces === 0 ? "None" : retiring ? `${plural(preview.workspaces, "workspace")} — they keep it` : plural(preview.workspaces, "workspace"),
    });
    impact.push({ label: "Given to new workspaces", value: retiring ? "Yes → No" : "No → Yes", tone: retiring ? "warning" : "success" });
    if (retiring && wasDefault) impact.push({ label: "Default for new workspaces", value: "Yes → No", tone: "warning" });
  }

  const Icon = retiring ? Archive : ArchiveRestore;
  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={openDialog} className="h-7 px-2 text-xs">
        <Icon aria-hidden="true" className="h-3.5 w-3.5" />
        {retiring ? "Retire" : "Offer again"}
      </Button>
      <ConfirmDialog
        open={open}
        onClose={close}
        title={retiring ? `Retire ${plan.name}` : `Offer ${plan.name} again`}
        confirmLabel={retiring ? "Retire plan" : "Offer again"}
        pending={save.pending}
        error={previewError ?? save.error}
        confirmDisabled={previewing || preview === null}
        onConfirm={confirm}
      >
        <p>
          {retiring
            ? "It stops being given to new workspaces and offered in invitations. Workspaces already on it keep it, and everything it includes."
            : "It can be given to workspaces and named in invitations again."}
        </p>
        {retiring && wasDefault && (
          <p className="text-warning">
            It is the default for new workspaces. After this no plan is, and a signup without an invitation plan starts with only the basics — make
            another plan the default.
          </p>
        )}
        {preview ? (
          <ImpactList items={impact} />
        ) : (
          !previewError && (
            <p className="flex items-center gap-2 text-muted">
              <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              Working out what this changes…
            </p>
          )
        )}
      </ConfirmDialog>
    </>
  );
}
