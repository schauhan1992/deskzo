"use client";

import { useId, useState, useSyncExternalStore, type FormEvent } from "react";
import { LoaderCircle, SlidersHorizontal } from "lucide-react";
import { consoleSetPartnerSettings } from "@/actions/platform/console-partners";
import { DefinitionList } from "@/components/console/kit/panel";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { useClock } from "@/components/time/clock-provider";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Checkbox } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import type { ProgrammeSettingsView } from "@/lib/partners/console-data";
import { cn } from "@/lib/utils";
import { wholeIn } from "./format";

/**
 * The programme's settings (spec §11, owner decisions O3 and O4) behind the /partners header's
 * "Programme settings": owners change them (`consoleSetPartnerSettings`, only what differs is sent),
 * everybody else reads them. The whole-number ranges come from the server page
 * (`PARTNER_SETTING_RANGES`), so the form and the library agree on them.
 */

export type SettingRanges = Record<"statementDay" | "dealDays" | "refCookieDays" | "clawbackMonths", { min: number; max: number; fallback: number }>;

type Settings = ProgrammeSettingsView["settings"];
type NumberKey = keyof SettingRanges;

const noSubscribe = () => () => {};

const NUMBERS: { key: NumberKey; label: string; unit: string; hint: (r: { min: number; max: number }) => string }[] = [
  { key: "statementDay", label: "Statements drafted on day", unit: "of the month", hint: (r) => `Last month's statements are drafted from this day, India time (${r.min}–${r.max}).` },
  { key: "dealDays", label: "Deal registration protects for", unit: "days", hint: (r) => `How long an approved registration holds a company for its partner (${r.min}–${r.max}).` },
  {
    key: "refCookieDays",
    label: "Referral cookie lasts",
    unit: "days",
    hint: (r) => `0 is off. The public site promises no tracking cookies and asks no consent — keep it off unless that changes (${r.min}–${r.max}).`,
  },
  { key: "clawbackMonths", label: "Refunds clawed back within", unit: "months", hint: (r) => `A refund takes back paid commission only this long after the payout (${r.min}–${r.max}).` },
];

function describe(s: Settings, twoFactorDefault: string) {
  const onOff = (on: boolean) => (on ? "On" : "Off");
  return [
    { term: "Partner two-factor", value: `${s.twoFactor === "required" ? "Required" : "Optional"}${s.twoFactorChosen ? "" : ` (this environment's default: ${twoFactorDefault})`}` },
    { term: "Statements drafted on day", value: `${s.statementDay} of the month` },
    { term: "Deal registration protects for", value: `${s.dealDays} days` },
    { term: "Referral cookie", value: s.refCookieDays === 0 ? "Off" : `${s.refCookieDays} days` },
    { term: "Partner applications", value: s.applications ? "Open" : "Closed" },
    { term: "Find a partner page", value: onOff(s.directory) },
    { term: "Clawback window", value: `${s.clawbackMonths} months after the payout` },
    { term: "Two-person payout rule", value: onOff(s.twoPersonPayout) },
  ];
}

export function ProgrammeSettingsButton({ view, canEdit, ranges }: { view: ProgrammeSettingsView; canEdit: boolean; ranges: SettingRanges }) {
  const clock = useClock();
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<{ changed: string[] }>();
  const [open, setOpen] = useState(false);

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
        Programme settings
      </Button>
      <Dialog open={open && isClient} onClose={close} title="Programme settings">
        {canEdit ? (
          <SettingsForm view={view} ranges={ranges} action={action} onClose={close} />
        ) : (
          <div className="space-y-4">
            <DefinitionList columns={1} items={describe(view.settings, view.twoFactorDefault)} />
            <p className="text-xs text-muted">Only an owner changes these.</p>
            {view.lastChange && <p className="text-xs text-subtle">{`Last changed ${clock.date(view.lastChange.at)} by ${view.lastChange.byName}.`}</p>}
            <div className="flex justify-end">
              <Button type="button" variant="secondary" onClick={close}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}

function SettingsForm({
  view,
  ranges,
  action,
  onClose,
}: {
  view: ProgrammeSettingsView;
  ranges: SettingRanges;
  action: ReturnType<typeof useConsoleAction<{ changed: string[] }>>;
  onClose: () => void;
}) {
  const id = useId();
  const clock = useClock();
  const s = view.settings;
  const [twoFactor, setTwoFactor] = useState<"required" | "optional">(s.twoFactor);
  const [numbers, setNumbers] = useState<Record<NumberKey, string>>({
    statementDay: String(s.statementDay),
    dealDays: String(s.dealDays),
    refCookieDays: String(s.refCookieDays),
    clawbackMonths: String(s.clawbackMonths),
  });
  const [applications, setApplications] = useState(s.applications);
  const [directory, setDirectory] = useState(s.directory);
  const [twoPersonPayout, setTwoPersonPayout] = useState(s.twoPersonPayout);

  const parsed = Object.fromEntries(NUMBERS.map(({ key }) => [key, wholeIn(numbers[key], ranges[key].min, ranges[key].max)])) as Record<NumberKey, number | null>;
  const bad = NUMBERS.filter(({ key }) => parsed[key] === null).map(({ key }) => key);

  const changes: Record<string, string | number | boolean> = {};
  if (twoFactor !== s.twoFactor) changes.twoFactor = twoFactor;
  for (const { key } of NUMBERS) if (parsed[key] !== null && parsed[key] !== s[key]) changes[key] = parsed[key] as number;
  if (applications !== s.applications) changes.applications = applications;
  if (directory !== s.directory) changes.directory = directory;
  if (twoPersonPayout !== s.twoPersonPayout) changes.twoPersonPayout = twoPersonPayout;
  const changed = Object.keys(changes).length;
  const ready = bad.length === 0 && changed > 0 && !action.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    action.run(() => consoleSetPartnerSettings(changes), {
      success: (d) => `Programme settings saved — ${d.changed.length === 1 ? "1 setting" : `${d.changed.length} settings`} changed.`,
      onDone: onClose,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      <fieldset className="space-y-1.5">
        <legend className="text-[13px] font-medium text-muted">Partner two-factor</legend>
        <div className="flex flex-wrap gap-4 pt-1">
          {(["required", "optional"] as const).map((mode) => (
            <label key={mode} className="inline-flex cursor-pointer items-center gap-2 text-sm text-text">
              <input
                type="radio"
                name={`${id}-two-factor`}
                value={mode}
                checked={twoFactor === mode}
                onChange={() => setTwoFactor(mode)}
                disabled={action.pending}
                className="h-4 w-4 accent-brand"
              />
              {mode === "required" ? "Required" : "Optional"}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">
          {s.twoFactorChosen ? "Chosen by an owner." : `Nobody has chosen yet: this environment's default is ${view.twoFactorDefault}.`} Required in production is the programme&apos;s rule.
        </p>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        {NUMBERS.map(({ key, label, unit, hint }) => {
          const inputId = `${id}-${key}`;
          const hintId = `${id}-${key}-hint`;
          const invalid = parsed[key] === null;
          return (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={inputId}>{`${label} (${unit})`}</Label>
              <Input
                id={inputId}
                inputMode="numeric"
                value={numbers[key]}
                onChange={(e) => setNumbers((prev) => ({ ...prev, [key]: e.target.value }))}
                maxLength={3}
                aria-invalid={invalid || undefined}
                aria-describedby={hintId}
                readOnly={action.pending}
                className="tabular-nums"
              />
              <p id={hintId} className={cn("text-xs", invalid ? "text-danger" : "text-muted")}>
                {hint(ranges[key])}
              </p>
            </div>
          );
        })}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium text-muted">Switches</legend>
        <label className="flex cursor-pointer items-start gap-2 text-sm text-text">
          <Checkbox checked={applications} onChange={(e) => setApplications(e.target.checked)} disabled={action.pending} className="mt-0.5" />
          <span>
            Take partner applications
            <span className="block text-xs text-muted">The public &ldquo;Become a partner&rdquo; form.</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm text-text">
          <Checkbox checked={directory} onChange={(e) => setDirectory(e.target.checked)} disabled={action.pending} className="mt-0.5" />
          <span>
            Show the &ldquo;Find a partner&rdquo; page
            <span className="block text-xs text-muted">Lists active partners that chose to be listed.</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm text-text">
          <Checkbox checked={twoPersonPayout} onChange={(e) => setTwoPersonPayout(e.target.checked)} disabled={action.pending} className="mt-0.5" />
          <span>
            Two-person payout rule
            <span className="block text-xs text-muted">Whoever approved a statement can&apos;t also mark it paid — another owner or billing staff member does.</span>
          </span>
        </label>
      </fieldset>

      {view.lastChange && <p className="text-xs text-subtle">{`Last changed ${clock.date(view.lastChange.at)} by ${view.lastChange.byName}.`}</p>}

      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />

      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:items-center sm:justify-end">
        {changed === 0 && bad.length === 0 && <p className="text-xs text-muted sm:mr-auto">Nothing changed yet.</p>}
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-busy={action.pending || undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Save settings
        </Button>
      </div>
    </form>
  );
}
