"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import type { ConsoleResult } from "@/actions/platform/console";
import {
  consoleBulkApplyStanding,
  consoleBulkExtendTrial,
  consoleBulkTag,
  consolePreviewApplyStanding,
  consolePreviewExtendTrial,
} from "@/actions/platform/console-directory";
import { BulkRunDialog } from "@/components/console/kit/bulk-run-dialog";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { AffectedList, ImpactList } from "@/components/console/kit/impact";
import { SubHeading } from "@/components/console/kit/panel";
import { useClock } from "@/components/time/clock-provider";
import { Input, Label } from "@/components/ui/input";
import { plural } from "@/lib/console-shared/format";
import { STANDING_KIND_LABEL } from "@/lib/console-shared/labels";
import type { BulkResult, Tone } from "@/lib/console-shared/types";
import type { ApplyStandingPreview, ExtendTrialPreview } from "@/lib/platform/bulk";
import { cn } from "@/lib/utils";

/**
 * The directory's bulk actions (spec §1.12, T2): apply billing rules, extend trials, add or remove a
 * tag. Each lists the rows it will touch before anything runs, and — through `BulkRunDialog` — what
 * happened to each one afterwards.
 *
 * The two that decide something per workspace ask the server first (a preview read), and the dialog
 * cannot be confirmed until that answer is on screen. The action works its preview out again when it
 * runs; applying billing rules is refused outright if it would now hold or close more than the
 * operator was shown. There is no bulk hold, reopen, close, plan change or migration.
 */

export type BulkRow = { id: string; slug: string; name: string; tags?: string[] };

type BulkDialogProps = {
  open: boolean;
  onClose: () => void;
  rows: BulkRow[];
  /** After a run, once "Done" is pressed — the directory clears its selection here. */
  onFinished?: () => void;
};

const UNREACHABLE = "Couldn't work out what would change — check the connection and try again.";

/** Trials are extended in bulk by a fixed length (spec §3.3); a single row's menu offers 7, 14 or 30. */
const BULK_TRIAL_DAYS = 14;

/** Module-level, so the preview effect below depends on a stable function. */
const previewTrials = (ids: string[]) => consolePreviewExtendTrial(ids, BULK_TRIAL_DAYS);

/**
 * A server preview for the rows selected, fetched each time the dialog opens and again on "Try
 * again". Nothing is set synchronously in the effect: the answer is stored against the request it
 * answers, and anything else — a closed dialog, a newer request — reads as still pending, so a stale
 * preview can never be the one confirmed.
 */
function usePreview<T>(open: boolean, ids: string[], load: (ids: string[]) => Promise<ConsoleResult<T>>) {
  const idsKey = ids.join(",");
  const [round, setRound] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);
  // A fresh request on every opening — adjusted while rendering, so a previous opening's answer is
  // never painted for a frame.
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setRound((r) => r + 1);
  }
  const key = `${round}|${idsKey}`;
  const [answer, setAnswer] = useState<{ key: string; result: ConsoleResult<T> } | null>(null);

  useEffect(() => {
    if (!open || !idsKey) return;
    let live = true;
    load(idsKey.split(",")).then(
      (result) => {
        if (live) setAnswer({ key, result: result && typeof result === "object" ? result : { ok: false, error: UNREACHABLE } });
      },
      () => {
        if (live) setAnswer({ key, result: { ok: false, error: UNREACHABLE } });
      },
    );
    return () => {
      live = false;
    };
  }, [open, key, idsKey, load]);

  const result = open && answer?.key === key ? answer.result : null;
  return {
    data: result?.ok ? result.data : null,
    error: result && !result.ok ? result.error || UNREACHABLE : null,
    pending: open && ids.length > 0 && result === null,
    retry: () => setRound((r) => r + 1),
  };
}

/**
 * The dialog when there is nothing to confirm — the preview failed (with "Try again"), or it found
 * nothing the action could do. Same frame and words as the confirmation, but its button never runs
 * the action.
 */
function PreviewStop({
  open,
  onClose,
  title,
  error,
  onRetry,
  confirmLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  error: string | null;
  onRetry?: () => void;
  confirmLabel: string;
  children: ReactNode;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={title}
      confirmLabel={onRetry ? "Try again" : confirmLabel}
      pending={false}
      error={error}
      confirmDisabled={!onRetry}
      onConfirm={() => onRetry?.()}
    >
      {children}
    </ConfirmDialog>
  );
}

/** "3 selected" as the rows the dialog will list: the first ten, then "and N more". */
function SelectedList({ rows }: { rows: { id: string; label: string; note?: string; tone?: Tone }[] }) {
  return (
    <div className="space-y-2">
      <SubHeading>Selected ({rows.length})</SubHeading>
      <AffectedList rows={rows.map((r) => ({ key: r.id, label: r.label, note: r.note, tone: r.tone }))} />
    </div>
  );
}

// ─── Apply billing rules ─────────────────────────────────────────────────────────────────────────

type Planned = ApplyStandingPreview["items"][number]["planned"];

const PLANNED: Record<Planned | "skipped" | "gone", { note: string; tone?: Tone; order: number }> = {
  closed: { note: "Will be closed", tone: "danger", order: 0 },
  held: { note: "Will be held", tone: "warning", order: 1 },
  lifted: { note: "Hold lifted", tone: "success", order: 2 },
  none: { note: "No change", order: 3 },
  skipped: { note: "Skipped — installation's own", order: 4 },
  gone: { note: "No longer exists", order: 5 },
};

export function BulkStandingDialog({ open, onClose, rows, onFinished }: BulkDialogProps) {
  const ids = rows.map((r) => r.id);
  const preview = usePreview(open, ids, consolePreviewApplyStanding);
  const title = "Apply billing rules";
  const description =
    "Each selected workspace's billing standing is applied now, as the hourly tick would: a hold placed or lifted, a reminder sent when one is due, and — with auto-close on — a lapsed workspace closed.";

  if (preview.error) {
    return (
      <PreviewStop open={open} onClose={onClose} title={title} error={preview.error} onRetry={preview.retry} confirmLabel={title}>
        <p>{description}</p>
        <SelectedList rows={rows.map((r) => ({ id: r.id, label: r.name }))} />
      </PreviewStop>
    );
  }

  const data = preview.data;
  const planned = new Map((data?.items ?? []).map((i) => [i.tenantId, i]));
  const listed = rows
    .map((r, index) => {
      const item = planned.get(r.id);
      const state = !data ? null : !item ? PLANNED.gone : item.skipped ? PLANNED.skipped : PLANNED[item.planned];
      const standing = item && !item.skipped ? STANDING_KIND_LABEL[item.standing] : null;
      const note = state ? (standing && item?.planned === "none" ? `${state.note} · ${standing}` : state.note) : undefined;
      return { id: r.id, label: r.name, note, tone: state?.tone, order: state?.order ?? 0, index };
    })
    // What will change first, so the ten rows shown are the ones worth reading.
    .sort((a, b) => a.order - b.order || a.index - b.index);

  const counts = data?.counts ?? { held: 0, lifted: 0, closed: 0 };
  const reminders = data?.items.filter((i) => i.remind && !i.skipped).length ?? 0;
  const unchanged = data?.items.filter((i) => i.planned === "none" && !i.skipped).length ?? 0;
  const harmful = counts.held + counts.closed > 0;
  const expect = { held: counts.held, closed: counts.closed };

  const impact = data && (
    <div className="space-y-2">
      <ImpactList
        items={[
          ...(counts.held > 0 ? [{ label: "Will be held", value: plural(counts.held, "workspace"), tone: "warning" as const }] : []),
          ...(counts.closed > 0 ? [{ label: "Will be closed", value: plural(counts.closed, "workspace"), tone: "danger" as const }] : []),
          ...(counts.lifted > 0 ? [{ label: "Hold lifted", value: plural(counts.lifted, "workspace"), tone: "success" as const }] : []),
          ...(reminders > 0 ? [{ label: "Reminders sent", value: plural(reminders, "reminder") }] : []),
          { label: "No change", value: plural(unchanged, "workspace") },
        ]}
      />
      {counts.closed > 0 && (
        <p className="text-xs text-danger">A closed workspace can no longer be signed in to. Its final backup is kept until it is purged.</p>
      )}
    </div>
  );

  return (
    <BulkRunDialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      confirmLabel={title}
      tone={counts.closed > 0 ? "danger" : "primary"}
      rows={listed}
      preview={impact || undefined}
      previewPending={preview.pending}
      typed={harmful ? "apply" : undefined}
      run={() => consoleBulkApplyStanding(ids, expect)}
      onFinished={onFinished}
    />
  );
}

// ─── Extend trials ───────────────────────────────────────────────────────────────────────────────

export function BulkTrialDialog({ open, onClose, rows, onFinished }: BulkDialogProps) {
  const clock = useClock();
  const ids = rows.map((r) => r.id);
  const preview = usePreview(open, ids, previewTrials);
  const title = `Extend trials by ${BULK_TRIAL_DAYS} days`;
  const confirmLabel = `Extend by ${BULK_TRIAL_DAYS} days`;
  const description = `Each selected trial is extended by ${BULK_TRIAL_DAYS} days from its current end — or from today, if it has already ended. A workspace held because its trial ran out is reopened.`;

  if (preview.error) {
    return (
      <PreviewStop open={open} onClose={onClose} title={title} error={preview.error} onRetry={preview.retry} confirmLabel={confirmLabel}>
        <p>{description}</p>
        <SelectedList rows={rows.map((r) => ({ id: r.id, label: r.name }))} />
      </PreviewStop>
    );
  }

  const data: ExtendTrialPreview | null = preview.data;
  const planned = new Map((data?.items ?? []).map((i) => [i.tenantId, i]));
  const listed = rows
    .map((r, index) => {
      const item = planned.get(r.id);
      if (!data) return { id: r.id, label: r.name, order: 0, index };
      if (!item) return { id: r.id, label: r.name, note: "No longer exists", order: 2, index };
      if (!item.eligible || !item.to) return { id: r.id, label: r.name, note: item.why ?? "No trial to extend", order: 1, index };
      const dates = `${clock.dayMonth(item.from)} → ${clock.dayMonth(item.to)}`;
      return { id: r.id, label: r.name, note: item.liftsHold ? `${dates} · reopens` : dates, tone: item.liftsHold ? ("success" as const) : undefined, order: 0, index };
    })
    .sort((a, b) => a.order - b.order || a.index - b.index);

  const eligible = data?.items.filter((i) => i.eligible) ?? [];
  const reopens = eligible.filter((i) => i.liftsHold).length;
  const skipped = rows.length - eligible.length;

  if (data && eligible.length === 0) {
    return (
      <PreviewStop open={open} onClose={onClose} title={title} error={null} confirmLabel={confirmLabel}>
        <p>None of the selected workspaces has a trial that can be extended — a workspace paying at a gateway, closed, or never on a trial is left as it is.</p>
        <SelectedList rows={listed} />
      </PreviewStop>
    );
  }

  const impact = data && (
    <ImpactList
      items={[
        { label: "Extended", value: plural(eligible.length, "trial"), tone: "success" },
        ...(reopens > 0 ? [{ label: "Reopened", value: plural(reopens, "workspace"), tone: "success" as const }] : []),
        ...(skipped > 0 ? [{ label: "Skipped", value: plural(skipped, "workspace") }] : []),
      ]}
    />
  );

  return (
    <BulkRunDialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      rows={listed}
      preview={impact || undefined}
      previewPending={preview.pending}
      run={() => consoleBulkExtendTrial(ids, BULK_TRIAL_DAYS)}
      onFinished={onFinished}
    />
  );
}

// ─── Tags ────────────────────────────────────────────────────────────────────────────────────────

const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/;
const MAX_TAGS = 10;
const TAG_RULE = "1–24 lower-case letters, digits and dashes, starting with a letter or digit.";

/**
 * A tag added to, or removed from, every selected workspace. No server preview is needed — what each
 * row will do follows from its own tags, shown beside it as the tag is typed. The tag is checked
 * here and again on the server; a workspace already at ten tags is passed over, never refused.
 */
export function BulkTagDialog({
  open,
  onClose,
  rows,
  onFinished,
  mode = "add",
  knownTags = [],
}: BulkDialogProps & { mode?: "add" | "remove"; knownTags?: string[] }) {
  const id = useId();
  const [tag, setTag] = useState("");
  const [wasOpen, setWasOpen] = useState(open);
  // Each opening starts with an empty field.
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setTag("");
  }

  const add = mode === "add";
  const clean = tag.trim().toLowerCase();
  const valid = TAG.test(clean);
  const ids = rows.map((r) => r.id);

  // Suggestions: to remove, the tags the selection carries; to add, tags already in use on the page.
  const counts = new Map<string, number>();
  for (const r of add ? [] : rows) for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  const suggestions = add
    ? [...new Set(knownTags)].sort().slice(0, 12)
    : [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t).slice(0, 12);

  const listed = rows.map((r) => {
    const tags = r.tags ?? [];
    if (!valid) return { id: r.id, label: r.name };
    if (add) {
      if (tags.includes(clean)) return { id: r.id, label: r.name, note: "Already tagged" };
      if (tags.length >= MAX_TAGS) return { id: r.id, label: r.name, note: `Has ${MAX_TAGS} tags — skipped` };
      return { id: r.id, label: r.name, note: "Will be tagged", tone: "success" as const };
    }
    return tags.includes(clean) ? { id: r.id, label: r.name, note: "Tag removed", tone: "warning" as const } : { id: r.id, label: r.name, note: "Not tagged" };
  });

  const title = add ? "Add a tag" : "Remove a tag";
  const hintId = `${id}-hint`;
  const invalid = clean !== "" && !valid;

  function run(): Promise<ConsoleResult<BulkResult>> {
    if (!valid) return Promise.resolve({ ok: false, error: clean ? `A tag is ${TAG_RULE}` : "Type the tag first." });
    return consoleBulkTag(ids, clean, add);
  }

  const field = (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-tag`}>Tag</Label>
      <Input
        id={`${id}-tag`}
        value={tag}
        onChange={(e) => setTag(e.target.value.toLowerCase().slice(0, 24))}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
        maxLength={24}
        placeholder={add ? "e.g. enterprise" : "The tag to remove"}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore=""
        aria-invalid={invalid || undefined}
        aria-describedby={hintId}
        className="font-mono"
      />
      <p id={hintId} className={cn("text-xs", invalid ? "text-danger" : "text-subtle")}>
        {invalid ? `A tag is ${TAG_RULE}` : add ? `${TAG_RULE} At most ${MAX_TAGS} tags a workspace.` : TAG_RULE}
      </p>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span className="text-xs text-muted">{add ? "In use:" : "On the selection:"}</span>
          {suggestions.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTag(t)}
              aria-pressed={clean === t}
              className={cn(
                "inline-flex h-5 items-center rounded-full border px-2 font-mono text-[11px]",
                clean === t ? "border-brand/40 bg-brand-subtle text-brand" : "border-line bg-surface-sunken text-muted hover:border-line-strong hover:text-text",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <BulkRunDialog
      open={open}
      onClose={onClose}
      title={title}
      description={
        add
          ? "The tag is added to every selected workspace that does not have it yet. Tags are for finding workspaces again — filter the directory by one."
          : "The tag is taken off every selected workspace that has it."
      }
      confirmLabel={add ? "Add tag" : "Remove tag"}
      rows={listed}
      preview={field}
      run={run}
      onFinished={onFinished}
    />
  );
}
