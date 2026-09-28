"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { saveSupportSettings } from "@/actions/platform/console-support";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ChangedBy, SettingSwitch, type SettingChange } from "@/components/console/settings/signup-settings";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HELPLINE_PATTERN, RETENTION_DAYS, SETTINGS_LIMITS, SUPPORT_EMAIL_PLACEHOLDER, type SupportSettingsView } from "@/lib/support/types";
import { cn } from "@/lib/utils";

/**
 * Settings › Support, for owners and admins: whether workspaces show Contact Support at all, the
 * address new requests are announced to (and that customers' replies reach), the helpline and its
 * hours shown in the dialog, whether screen recording is offered, and how long a closed request's
 * files are kept. One form, one Save (`saveSupportSettings` writes all six); switching Contact
 * Support off for every workspace is confirmed first.
 *
 * The checks here mirror the server's (src/lib/support/settings.ts), which checks again and has the
 * last word.
 */

type Draft = { enabled: boolean; email: string; helpline: string; hours: string; languages: string; recording: boolean; days: string };

const FIELD_LABEL = "text-sm font-medium text-text";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const chars = (s: string) => [...s].length;

function draftOf(v: SupportSettingsView): Draft {
  return { enabled: v.enabled, email: v.email, helpline: v.helpline ?? "", hours: v.hours ?? "", languages: v.languages ?? "", recording: v.recording, days: String(v.retentionDays) };
}

/** What is wrong with each field, if anything — worded as the server words it. */
function problems(d: Draft): Partial<Record<"email" | "helpline" | "hours" | "languages" | "days", string>> {
  const out: Partial<Record<"email" | "helpline" | "hours" | "languages" | "days", string>> = {};
  const email = d.email.trim();
  if (!email) out.email = "Give the support email address.";
  else if (chars(email) > SETTINGS_LIMITS.email || !EMAIL.test(email)) out.email = "The support email isn't an email address.";
  const helpline = d.helpline.trim();
  if (helpline && (chars(helpline) > SETTINGS_LIMITS.helpline || !HELPLINE_PATTERN.test(helpline))) {
    out.helpline = "Digits, spaces, brackets, + and - only, at most 30.";
  }
  if (chars(d.hours.trim()) > SETTINGS_LIMITS.hours) out.hours = `Keep the hours to ${SETTINGS_LIMITS.hours} characters.`;
  if (chars(d.languages.trim()) > SETTINGS_LIMITS.languages) out.languages = `Keep the languages to ${SETTINGS_LIMITS.languages} characters.`;
  const days = /^\d{1,4}$/.test(d.days.trim()) ? Number(d.days.trim()) : NaN;
  if (!Number.isInteger(days) || days < RETENTION_DAYS.min || days > RETENTION_DAYS.max) out.days = `${RETENTION_DAYS.min} to ${RETENTION_DAYS.max} whole days.`;
  return out;
}

export function SupportSettingsForm({ settings, lastSaved }: { settings: SupportSettingsView; lastSaved?: SettingChange | null }) {
  const id = useId();
  const action = useConsoleAction<SupportSettingsView>();
  const [confirming, setConfirming] = useState(false);

  // The saved values as a draft to edit — reset whenever the page brings back different ones, while
  // rendering rather than in an effect.
  const saved = JSON.stringify(settings);
  const [synced, setSynced] = useState(saved);
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  if (saved !== synced) {
    setSynced(saved);
    setDraft(draftOf(settings));
  }

  const initial = draftOf(settings);
  const dirty = (Object.keys(initial) as (keyof Draft)[]).some((k) => (typeof initial[k] === "string" ? String(draft[k]).trim() !== initial[k] : draft[k] !== initial[k]));
  const errors = problems(draft);
  const valid = Object.keys(errors).length === 0;
  const switchingOff = settings.enabled && !draft.enabled;

  function edit(change: Partial<Draft>) {
    action.reset();
    setDraft((d) => ({ ...d, ...change }));
  }

  function discard() {
    action.reset();
    setDraft(draftOf(settings));
  }

  function commit() {
    action.run(
      () =>
        saveSupportSettings({
          enabled: draft.enabled,
          email: draft.email.trim(),
          helpline: draft.helpline.trim() || null,
          hours: draft.hours.trim() || null,
          languages: draft.languages.trim() || null,
          recording: draft.recording,
          retentionDays: draft.days.trim(),
        }),
      { success: "Support settings saved.", onDone: () => setConfirming(false) },
    );
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dirty || !valid || action.pending) return;
    if (switchingOff) {
      action.reset();
      setConfirming(true);
      return;
    }
    commit();
  }

  const f = {
    enabled: `${id}-enabled`,
    enabledHelp: `${id}-enabled-help`,
    email: `${id}-email`,
    emailHelp: `${id}-email-help`,
    helpline: `${id}-helpline`,
    helplineHelp: `${id}-helpline-help`,
    hours: `${id}-hours`,
    hoursHelp: `${id}-hours-help`,
    languages: `${id}-languages`,
    languagesHelp: `${id}-languages-help`,
    recording: `${id}-recording`,
    recordingHelp: `${id}-recording-help`,
    days: `${id}-days`,
    daysHelp: `${id}-days-help`,
  };
  const placeholderEmail = draft.email.trim() === SUPPORT_EMAIL_PLACEHOLDER;
  // The labels, written out here rather than inside the props below, where check:a11y would not see them.
  const emailLabel = (
    <label htmlFor={f.email} className={FIELD_LABEL}>
      Support email
    </label>
  );
  const helplineLabel = (
    <label htmlFor={f.helpline} className={FIELD_LABEL}>
      Helpline
    </label>
  );
  const hoursLabel = (
    <label htmlFor={f.hours} className={FIELD_LABEL}>
      Helpline hours
    </label>
  );
  const languagesLabel = (
    <label htmlFor={f.languages} className={FIELD_LABEL}>
      Languages
    </label>
  );
  const daysLabel = (
    <label htmlFor={f.days} className={FIELD_LABEL}>
      Keep files after closing
    </label>
  );

  return (
    <>
      <form onSubmit={submit} noValidate>
        <div className="divide-y divide-line">
          <Row
            label={
              <span id={f.enabled} className="text-sm font-medium text-text">
                Contact Support in workspaces
              </span>
            }
            help={
              <p id={f.enabledHelp} className="text-xs text-muted">
                {draft.enabled
                  ? "Everybody signed in to a workspace sees the Contact Support button — except staff who went in as support, and anyone viewing as another user."
                  : "Off: no workspace shows the button, and new requests are refused."}
              </p>
            }
            control={<SettingSwitch checked={draft.enabled} onChange={(enabled) => edit({ enabled })} labelledBy={f.enabled} describedBy={f.enabledHelp} disabled={action.pending} />}
          />
          <Field
            helpId={f.emailHelp}
            label={emailLabel}
            error={errors.email}
            help={
              placeholderEmail
                ? "Still the placeholder — set the real mailbox. New requests are announced here, and customers' replies to staff emails come back here."
                : "New requests are announced here, and it is the Reply-To of every email to a customer — their replies come back here, not to the console."
            }
            warn={placeholderEmail}
          >
            <Input
              id={f.email}
              type="email"
              value={draft.email}
              onChange={(e) => edit({ email: e.target.value })}
              maxLength={SETTINGS_LIMITS.email}
              placeholder={SUPPORT_EMAIL_PLACEHOLDER}
              autoComplete="off"
              readOnly={action.pending}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={f.emailHelp}
              className={cn("w-full sm:w-72", errors.email && "border-danger")}
            />
          </Field>
          <Field helpId={f.helplineHelp} label={helplineLabel} error={errors.helpline} help="Shown in the Contact Support dialog with the hours. Leave both empty to show neither.">
            <Input
              id={f.helpline}
              type="tel"
              value={draft.helpline}
              onChange={(e) => edit({ helpline: e.target.value })}
              maxLength={SETTINGS_LIMITS.helpline}
              placeholder="+91 80 1234 5678"
              autoComplete="off"
              readOnly={action.pending}
              aria-invalid={errors.helpline ? true : undefined}
              aria-describedby={f.helplineHelp}
              className={cn("w-full sm:w-72", errors.helpline && "border-danger")}
            />
          </Field>
          <Field helpId={f.hoursHelp} label={hoursLabel} error={errors.hours} help={`One line, at most ${SETTINGS_LIMITS.hours} characters.`}>
            <Input
              id={f.hours}
              value={draft.hours}
              onChange={(e) => edit({ hours: e.target.value })}
              maxLength={SETTINGS_LIMITS.hours}
              placeholder="Mon–Fri, 9:00 AM – 6:00 PM IST"
              autoComplete="off"
              readOnly={action.pending}
              aria-invalid={errors.hours ? true : undefined}
              aria-describedby={f.hoursHelp}
              className={cn("w-full sm:w-72", errors.hours && "border-danger")}
            />
          </Field>
          <Field helpId={f.languagesHelp} label={languagesLabel} error={errors.languages} help="The languages support answers in, shown with the helpline on every workspace's dashboard.">
            <Input
              id={f.languages}
              value={draft.languages}
              onChange={(e) => edit({ languages: e.target.value })}
              maxLength={SETTINGS_LIMITS.languages}
              placeholder="English, Hindi"
              autoComplete="off"
              readOnly={action.pending}
              aria-invalid={errors.languages ? true : undefined}
              aria-describedby={f.languagesHelp}
              className={cn("w-full sm:w-72", errors.languages && "border-danger")}
            />
          </Field>
          <Row
            label={
              <span id={f.recording} className="text-sm font-medium text-text">
                Screen recording
              </span>
            }
            help={
              <p id={f.recordingHelp} className="text-xs text-muted">
                {draft.recording
                  ? "Offered in the dialog, after the customer consents — except where a workspace's copy or print protection applies to them."
                  : "Off: the Record screen button is disabled in every workspace."}
              </p>
            }
            control={<SettingSwitch checked={draft.recording} onChange={(recording) => edit({ recording })} labelledBy={f.recording} describedBy={f.recordingHelp} disabled={action.pending} />}
          />
          <Field
            helpId={f.daysHelp}
            label={daysLabel}
            error={errors.days}
            help={`Attachments and recordings are deleted this many days after a request is closed; the request itself stays. ${RETENTION_DAYS.min} to ${RETENTION_DAYS.max} days.`}
          >
            <span className="inline-flex items-center gap-2">
              <Input
                id={f.days}
                type="number"
                inputMode="numeric"
                min={RETENTION_DAYS.min}
                max={RETENTION_DAYS.max}
                step={1}
                value={draft.days}
                onChange={(e) => edit({ days: e.target.value.slice(0, 5) })}
                readOnly={action.pending}
                aria-invalid={errors.days ? true : undefined}
                aria-describedby={f.daysHelp}
                className={cn("w-24 text-right tabular-nums", errors.days && "border-danger")}
              />
              <span className="text-sm text-muted">days</span>
            </span>
          </Field>
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <ChangedBy change={lastSaved} prefix="Last saved by" never="Never saved — these are the defaults" />
          <div className="flex items-center gap-2">
            {dirty && (
              <Button type="button" variant="ghost" size="sm" onClick={discard} disabled={action.pending}>
                Discard
              </Button>
            )}
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
        title="Switch Contact Support off"
        confirmLabel="Switch it off"
        tone="danger"
        pending={action.pending}
        error={action.error}
        onConfirm={commit}
      >
        <p>
          <span className="font-medium">Every workspace loses its Contact Support button</span> until it is switched back on. Requests already sent stay here
          and can still be answered.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** A switch setting: its name and what the current choice means on the left, the control on the right. */
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

/** A text setting: label, the field, and its hint — or, when the value won't do, what is wrong with it. */
function Field({ helpId, label, help, error, warn, children }: { helpId: string; label: ReactNode; help: string; error?: string; warn?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-64">
        {label}
        <p id={helpId} role={error ? "alert" : undefined} className={cn("mt-0.5 text-xs", error ? "text-danger" : warn ? "text-warning" : "text-muted")}>
          {error ?? help}
        </p>
      </div>
      <div className="w-full shrink-0 sm:w-auto">{children}</div>
    </div>
  );
}
