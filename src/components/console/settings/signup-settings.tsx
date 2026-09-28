"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { consoleSaveBillingSettings } from "@/actions/platform/console";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { plural } from "@/lib/console-shared/format";
import { cn } from "@/lib/utils";

/** Who last wrote a setting and when — from `PlatformSetting.updatedBy`/`updatedAt`, the name already looked up. */
export type SettingChange = { by: string | null; at: Date | string | null };

/** Writers that are not staff, in words ("tick" is the hourly platform tick). */
const NOT_STAFF: Record<string, string> = { tick: "the platform tick", check: "a check script", billing: "billing" };

/**
 * "Changed by Priya Sharma · 3 min ago" — the exact India time in the tooltip. Shared by every
 * setting on the Settings page, the read-only lists included.
 */
export function ChangedBy({
  change,
  prefix = "Changed by",
  never = "Not changed yet",
  className,
}: {
  change: SettingChange | null | undefined;
  prefix?: string;
  never?: string;
  className?: string;
}) {
  const classes = cn("text-[11px] text-subtle", className);
  if (!change?.at) return <p className={classes}>{never}</p>;
  const by = change.by ? (NOT_STAFF[change.by] ?? change.by) : "somebody";
  return (
    <p className={classes}>
      {`${prefix} ${by} · `}
      <RelativeTime at={change.at} />
    </p>
  );
}

/** An on/off switch whose state is also written next to it, so it is not told by colour and position alone. */
export function SettingSwitch({
  checked,
  onChange,
  labelledBy,
  describedBy,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  labelledBy: string;
  describedBy?: string;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className={cn("w-6 text-right text-xs font-medium", checked ? "text-text" : "text-muted")}>
        {checked ? "On" : "Off"}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-150 disabled:opacity-50",
          checked ? "bg-brand" : "bg-line-strong",
        )}
      >
        <span
          aria-hidden="true"
          className={cn("absolute top-0.5 left-0 h-5 w-5 rounded-full bg-surface shadow-sm transition-transform duration-150", checked ? "translate-x-5.5" : "translate-x-0.5")}
        />
      </button>
    </span>
  );
}

type Draft = { open: boolean; days: string; autoClose: boolean };

const OPEN_SENTENCE = "Anyone can create a workspace without an invitation.";
const AUTO_CLOSE_SENTENCE = "Workspaces held for billing for 90 days are closed: final backup, database dropped.";

/** A whole number of days from 1 to 90, or null. */
function trialLength(text: string): number | null {
  if (!/^\d{1,2}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= 90 ? n : null;
}

/**
 * Signup and trials, for an owner (spec §3.18): open signup, the trial's length and whether lapsed
 * workspaces are closed by themselves — one form, one Save (`consoleSaveBillingSettings` writes all
 * three together, which is why the form says when it was last saved rather than per setting).
 *
 * Opening signup to everybody is confirmed with what it means; turning automatic closing on also
 * asks for `on` to be typed, because from then on the platform drops databases by itself. Turning
 * either off, or changing the trial's length alone, saves straight away.
 */
export function SignupSettingsForm({
  signupOpen,
  trialDays,
  autoDeprovision,
  lastSaved,
}: {
  signupOpen: boolean;
  trialDays: number;
  autoDeprovision: boolean;
  /** When the three were last written, and by whom. */
  lastSaved?: SettingChange | null;
}) {
  const id = useId();
  const action = useConsoleAction<null>();
  const [confirming, setConfirming] = useState(false);

  // The saved values, as a draft to edit — reset whenever the page brings back different ones
  // (after a save, or somebody else's), adjusted while rendering rather than in an effect.
  const saved = `${signupOpen}|${trialDays}|${autoDeprovision}`;
  const [synced, setSynced] = useState(saved);
  const [draft, setDraft] = useState<Draft>({ open: signupOpen, days: String(trialDays), autoClose: autoDeprovision });
  if (saved !== synced) {
    setSynced(saved);
    setDraft({ open: signupOpen, days: String(trialDays), autoClose: autoDeprovision });
  }

  const days = trialLength(draft.days);
  const changes = {
    open: draft.open !== signupOpen,
    days: days !== null && days !== trialDays,
    autoClose: draft.autoClose !== autoDeprovision,
  };
  const dirty = changes.open || changes.autoClose || draft.days.trim() !== String(trialDays);
  const valid = days !== null;
  const opening = draft.open && !signupOpen;
  const autoClosing = draft.autoClose && !autoDeprovision;

  function edit(change: Partial<Draft>) {
    action.reset();
    setDraft((d) => ({ ...d, ...change }));
  }

  function discard() {
    action.reset();
    setDraft({ open: signupOpen, days: String(trialDays), autoClose: autoDeprovision });
  }

  function commit() {
    if (days === null) return;
    action.run(() => consoleSaveBillingSettings({ signupOpen: draft.open, trialDays: days, autoDeprovision: draft.autoClose }), {
      success: "Signup and trial settings saved.",
      onDone: () => setConfirming(false),
    });
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dirty || !valid || action.pending) return;
    if (opening || autoClosing) {
      action.reset();
      setConfirming(true);
      return;
    }
    commit();
  }

  const openLabel = `${id}-open`;
  const openHelp = `${id}-open-help`;
  const daysField = `${id}-days`;
  const daysHelp = `${id}-days-help`;
  const closeLabel = `${id}-close`;
  const closeHelp = `${id}-close-help`;

  const impact = [
    ...(changes.open ? [{ label: "Open signup", value: draft.open ? "Invite-only → Open" : "Open → Invite-only", tone: draft.open ? ("warning" as const) : undefined }] : []),
    ...(changes.days && days !== null ? [{ label: "Trial length", value: `${trialDays} → ${plural(days, "day")}` }] : []),
    ...(changes.autoClose ? [{ label: "Close lapsed workspaces automatically", value: draft.autoClose ? "Off → On" : "On → Off", tone: draft.autoClose ? ("danger" as const) : undefined }] : []),
  ];

  return (
    <>
      <form onSubmit={submit} noValidate>
        <div className="divide-y divide-line">
          <Row
            label={
              <span id={openLabel} className="text-sm font-medium text-text">
                Open signup
              </span>
            }
            help={
              <p id={openHelp} className="text-xs text-muted">
                {draft.open ? OPEN_SENTENCE : "Invite-only: people need an invitation to sign up."}
              </p>
            }
            control={<SettingSwitch checked={draft.open} onChange={(open) => edit({ open })} labelledBy={openLabel} describedBy={openHelp} disabled={action.pending} />}
          />
          <Row
            label={
              <label htmlFor={daysField} className="text-sm font-medium text-text">
                Trial length
              </label>
            }
            help={
              <p id={daysHelp} className={cn("text-xs", valid ? "text-muted" : "text-danger")}>
                {valid ? "New workspaces start with a trial this long. Trials already running keep their end date." : "A trial is 1 to 90 days, in whole days."}
              </p>
            }
            control={
              <span className="inline-flex items-center gap-2">
                <Input
                  id={daysField}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={90}
                  step={1}
                  value={draft.days}
                  onChange={(e) => edit({ days: e.target.value.slice(0, 3) })}
                  readOnly={action.pending}
                  aria-invalid={!valid || undefined}
                  aria-describedby={daysHelp}
                  className={cn("w-20 text-right tabular-nums", !valid && "border-danger")}
                />
                <span className="text-sm text-muted">days</span>
              </span>
            }
          />
          <Row
            label={
              <span id={closeLabel} className="text-sm font-medium text-text">
                Close lapsed workspaces automatically
              </span>
            }
            help={
              <p id={closeHelp} className="text-xs text-muted">
                {draft.autoClose ? AUTO_CLOSE_SENTENCE : "Off: a lapsed workspace stays held until somebody closes it by hand."}
              </p>
            }
            control={
              <SettingSwitch checked={draft.autoClose} onChange={(autoClose) => edit({ autoClose })} labelledBy={closeLabel} describedBy={closeHelp} disabled={action.pending} />
            }
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <ChangedBy change={lastSaved} prefix="Last saved by" never="Never saved — these are the defaults" />
          <div className="flex items-center gap-2">
            {dirty && (
              <Button type="button" variant="ghost" size="sm" onClick={discard} disabled={action.pending}>
                Discard
              </Button>
            )}
            {/* Inert rather than disabled while pending, so focus stays on the button that was pressed. */}
            <Button
              type="submit"
              size="sm"
              disabled={!dirty || !valid}
              aria-disabled={action.pending || undefined}
              aria-busy={action.pending || undefined}
              className={cn(action.pending && !confirming && "cursor-wait opacity-70")}
            >
              {action.pending && !confirming && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
        <ActionNoticeRegion notice={!confirming && action.error ? { tone: "error", message: action.error } : null} className="mt-3 empty:mt-0" />
      </form>

      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          action.reset();
        }}
        title="Save signup and trial settings"
        confirmLabel="Save settings"
        tone={autoClosing ? "danger" : "primary"}
        typed={autoClosing ? "on" : undefined}
        pending={action.pending}
        error={action.error}
        onConfirm={commit}
      >
        <ImpactList items={impact} />
        {opening && (
          <p>
            <span className="font-medium">{OPEN_SENTENCE}</span>
            {days !== null ? ` Each new workspace starts with a ${days}-day trial.` : ""}
          </p>
        )}
        {autoClosing && (
          <p>
            <span className="font-medium text-danger">{AUTO_CLOSE_SENTENCE}</span> The platform tick does it on its own from its next run; after that,
            only the final backup is left.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

/** One setting: its name and what the current choice means on the left, the control on the right. */
function Row({ label, help, control }: { label: ReactNode; help: ReactNode; control: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3 first:pt-0">
      <div className="min-w-0 flex-1 basis-64">
        {label}
        <div className="mt-0.5">{help}</div>
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}
