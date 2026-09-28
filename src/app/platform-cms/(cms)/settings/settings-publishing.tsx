"use client";

import { useState } from "react";
import { ChevronRight, LoaderCircle, RotateCcw, Save, Send, TriangleAlert } from "lucide-react";
import { Banner } from "@/components/console/kit/banner";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { LiveStatePill } from "@/components/cms/common/status";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/console-shared/format";
import { cn } from "@/lib/utils";
import type { SettingsDraft } from "./use-settings-draft";

/**
 * The top of a settings page: whether the site shows what is saved here ("Live" or "Draft — not
 * live"), who saved it and when it was last published, what publishing would change — as a short
 * list, in words — and the Publish button. Somebody else's save in between is said here too, with the
 * two ways out: load their version, or keep this one and overwrite it.
 */
export function PublishStatus<F>({ draft, canEdit }: { draft: SettingsDraft<F>; canEdit: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const { saved: current, changes, dirty, isLive } = draft;

  const headline = !current.saved
    ? "The site shows the built-in defaults."
    : isLive || changes.length === 0
      ? "The site shows exactly what's saved here."
      : `${plural(changes.length, "change")} saved but not on the site yet.`;

  return (
    <section aria-label="Publishing" className="rounded-xl border border-line bg-surface shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <LiveStatePill live={isLive} />
            {dirty && canEdit && <span className="text-xs font-medium text-warning">Unsaved edits below</span>}
          </div>
          <p className="text-sm font-medium text-text">{headline}</p>
          <p className="text-xs text-muted">
            {current.updatedAt ? (
              <>
                Saved by {current.updatedBy ?? "somebody"} <RelativeTime at={current.updatedAt} />
              </>
            ) : canEdit ? (
              "Change anything below and save a draft — nothing goes live until it's published."
            ) : (
              "Only editors and admins change the site's settings."
            )}
            {" · "}
            {current.publishedAt ? (
              <>
                last published <RelativeTime at={current.publishedAt} />
              </>
            ) : (
              "never published"
            )}
          </p>
        </div>
        {canEdit && (!isLive || dirty) && changes.length > 0 && (
          <Button
            type="button"
            onClick={() => {
              if (draft.ready("publish")) setConfirming(true);
            }}
            aria-disabled={draft.pending || undefined}
            aria-haspopup="dialog"
          >
            <Send aria-hidden="true" className="h-4 w-4" />
            Publish…
          </Button>
        )}
      </div>

      {changes.length > 0 && (
        <details className="group border-t border-line">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-5 py-2.5 text-[13px] font-medium text-text hover:bg-surface-sunken [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden="true" className="h-4 w-4 text-subtle transition-transform group-open:rotate-90" />
            What changes on publish
            <span className="rounded-full bg-surface-sunken px-1.5 text-[11px] text-muted tabular-nums">{changes.length}</span>
            {dirty && <span className="text-xs font-normal text-muted">— including your unsaved edits</span>}
          </summary>
          <div className="px-5 pb-4">
            <ChangeList changes={changes} />
          </div>
        </details>
      )}

      {draft.conflict && (
        <div className="border-t border-line p-4">
          <Banner
            tone="warning"
            title={`${draft.conflict.updatedBy} saved these settings since you opened them`}
            action={
              <>
                <Button type="button" variant="secondary" size="sm" onClick={draft.reloadTheirs} aria-disabled={draft.pending || undefined}>
                  <RotateCcw aria-hidden="true" className="h-4 w-4" />
                  Load their version
                </Button>
                <Button type="button" variant="danger" size="sm" onClick={draft.overwrite} aria-disabled={draft.pending || undefined}>
                  Keep mine and overwrite
                </Button>
              </>
            }
          >
            Loading theirs drops your edits here. Keeping yours replaces what they saved.
          </Banner>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          draft.resetError();
        }}
        title="Publish the site settings"
        confirmLabel="Publish"
        pending={draft.pending}
        error={draft.conflict ? null : draft.error}
        onConfirm={() => draft.publish({ onDone: () => setConfirming(false), onRefused: () => setConfirming(false) })}
      >
        <p>The public site shows these straight away — on every page, for every visitor.</p>
        <ChangeList changes={changes} />
        <p className="text-xs text-muted">Publishing puts the whole settings draft live, including anything saved on the other settings pages.</p>
      </ConfirmDialog>
    </section>
  );
}

function ChangeList({ changes }: { changes: SettingsDraft<unknown>["changes"] }) {
  return (
    <ImpactList
      items={changes.map((c) => ({
        label: c.label,
        value: (
          <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5 font-normal">
            <span className="text-muted line-through decoration-subtle">{c.from}</span>
            <span aria-hidden="true" className="text-subtle">
              →
            </span>
            <span className="sr-only">becomes</span>
            <span className="font-medium text-text">{c.to}</span>
          </span>
        ),
      }))}
    />
  );
}

/**
 * The bar that follows the page while there are unsaved edits: say so, and Discard, Save draft, or
 * save and publish in one go. It is sticky to the bottom of the screen, so the way to keep the work is
 * never scrolled away from.
 */
export function SaveBar<F>({ draft }: { draft: SettingsDraft<F> }) {
  const issueCount = Object.keys(draft.issues).length;
  return (
    <div
      className={cn(
        "sticky bottom-0 z-10 -mx-4 mt-6 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6",
        !draft.dirty && !draft.error && "hidden",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          {issueCount > 0 ? (
            <p className="flex items-center gap-1.5 font-medium text-danger">
              <TriangleAlert aria-hidden="true" className="h-4 w-4" />
              {plural(issueCount, "field")} need{issueCount === 1 ? "s" : ""} attention
            </p>
          ) : (
            <p className="font-medium text-text">{draft.dirty ? "You have unsaved changes" : "Not saved"}</p>
          )}
          <p className="text-xs text-muted">Saving keeps a draft. The site changes only when it&apos;s published.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={draft.discard} disabled={!draft.dirty || draft.pending}>
            Discard
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => draft.save()}
            aria-disabled={draft.pending || undefined}
            aria-busy={draft.pending || undefined}
            className={draft.pending ? "cursor-wait opacity-70" : undefined}
          >
            {draft.pending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Save aria-hidden="true" className="h-4 w-4" />}
            Save draft
          </Button>
        </div>
      </div>
      {!draft.conflict && <ActionNoticeRegion notice={draft.error ? { tone: "error", message: draft.error } : null} className="[&:not(:empty)]:mt-2" />}
    </div>
  );
}
