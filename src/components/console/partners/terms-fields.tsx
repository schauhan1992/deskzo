"use client";

import { useId } from "react";
import { Plus, X } from "lucide-react";
import { percentToBp } from "@/components/console/commissions/format";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import type { PartnerKind, TermsInput } from "@/lib/partners/types";
import { cn } from "@/lib/utils";
import { COUNTRY_OPTIONS, wholeIn } from "./format";

/**
 * A partner's commission terms as a form (spec §3.3) — the New partner dialog's initial terms, the
 * Terms tab's "New terms", and a new reseller's first terms. Rates are percentages with at most two
 * decimals; the server turns them into basis points and checks everything again.
 *
 * What the form starts from is the programme's default (owner decision O1, `DEFAULT_TERMS`), handed
 * in by the server page — nothing is applied until staff save it.
 */

export type TermsDraft = {
  effectiveFrom: string;
  defaultRate: string;
  newRate: string;
  newMonths: string;
  renewalRate: string;
  durationMonths: string;
  overrideRate: string;
  territoryRate: string;
  planRates: { key: number; planKey: string; rate: string }[];
  countryRates: { key: number; country: string; rate: string }[];
  note: string;
  /** The next row key — rows are added in handlers, never keyed by position. */
  seq: number;
};

const MAX_RATE_ROWS = 50;
const NOTE_MAX = 500;

const text = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));

/** A form's starting state from terms as the server writes them (DEFAULT_TERMS). */
export function draftFromTerms(t: TermsInput): TermsDraft {
  const planRates = (t.planRates ?? []).map((r, i) => ({ key: i, planKey: r.planKey, rate: r.rate }));
  const countryRates = (t.countryRates ?? []).map((r, i) => ({ key: planRates.length + i, country: r.country, rate: r.rate }));
  return {
    effectiveFrom: text(t.effectiveFrom),
    defaultRate: text(t.defaultRate),
    newRate: text(t.newRate),
    newMonths: text(t.newMonths ?? 12),
    renewalRate: text(t.renewalRate),
    durationMonths: text(t.durationMonths),
    overrideRate: text(t.overrideRate),
    territoryRate: text(t.territoryRate),
    planRates,
    countryRates,
    note: text(t.note),
    seq: planRates.length + countryRates.length,
  };
}

/** The draft as the actions take it. A reseller's override and territory rate are left out. */
export function termsFromDraft(d: TermsDraft, kind: PartnerKind): TermsInput {
  const blankToNull = (v: string) => (v.trim() ? v.trim() : null);
  const distributor = kind === "DISTRIBUTOR";
  return {
    effectiveFrom: blankToNull(d.effectiveFrom),
    defaultRate: d.defaultRate.trim(),
    newRate: blankToNull(d.newRate),
    renewalRate: blankToNull(d.renewalRate),
    newMonths: d.newMonths.trim() ? Number(d.newMonths.trim()) : null,
    durationMonths: d.durationMonths.trim() ? Number(d.durationMonths.trim()) : null,
    overrideRate: distributor ? blankToNull(d.overrideRate) : null,
    territoryRate: distributor ? blankToNull(d.territoryRate) : null,
    planRates: d.planRates.map((r) => ({ planKey: r.planKey, rate: r.rate.trim() })),
    countryRates: d.countryRates.map((r) => ({ country: r.country, rate: r.rate.trim() })),
    note: blankToNull(d.note),
  };
}

const rateOk = (v: string, optional: boolean) => (v.trim() === "" ? optional : percentToBp(v) !== null);

/** The first thing the server would refuse, in words — null when the draft looks sendable. */
export function termsProblem(d: TermsDraft, kind: PartnerKind, todayKey: string): string | null {
  if (!rateOk(d.defaultRate, false)) return "Give the default rate as a percentage from 0 to 100.";
  if (!rateOk(d.newRate, true)) return "The new-customer rate is a percentage from 0 to 100.";
  if (!rateOk(d.renewalRate, true)) return "The renewal rate is a percentage from 0 to 100.";
  if (d.newMonths.trim() && wholeIn(d.newMonths, 1, 60) === null) return "A customer is new for 1 to 60 months.";
  if (d.durationMonths.trim() && wholeIn(d.durationMonths, 1, 240) === null) return "Commission lasts 1 to 240 months, or leave it empty for the customer's lifetime.";
  if (kind === "DISTRIBUTOR" && !rateOk(d.overrideRate, true)) return "The override rate is a percentage from 0 to 100.";
  if (kind === "DISTRIBUTOR" && !rateOk(d.territoryRate, true)) return "The territory rate is a percentage from 0 to 100.";
  if (d.effectiveFrom.trim() && (!/^\d{4}-\d{2}-\d{2}$/.test(d.effectiveFrom.trim()) || d.effectiveFrom.trim() < todayKey)) return "Terms start today or later — never in the past.";
  const plans = d.planRates.map((r) => r.planKey);
  if (plans.some((p) => !p)) return "Choose the plan for each plan rate.";
  if (new Set(plans).size !== plans.length) return "Give each plan one rate.";
  if (d.planRates.some((r) => !rateOk(r.rate, false))) return "Each plan rate is a percentage from 0 to 100.";
  const countries = d.countryRates.map((r) => r.country);
  if (countries.some((c) => !c)) return "Choose the country for each country rate.";
  if (new Set(countries).size !== countries.length) return "Give each country one rate.";
  if (d.countryRates.some((r) => !rateOk(r.rate, false))) return "Each country rate is a percentage from 0 to 100.";
  if (d.note.trim().length > NOTE_MAX) return "Keep the note to 500 characters.";
  return null;
}

function RateInput({
  id,
  label,
  value,
  onChange,
  optional,
  disabled,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  const bad = value.trim() !== "" && percentToBp(value) === null;
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={8}
          autoComplete="off"
          placeholder={optional ? "Not set" : undefined}
          aria-invalid={bad || undefined}
          aria-describedby={hintId}
          readOnly={disabled}
          className="pr-8 tabular-nums"
        />
        <span aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-subtle">
          %
        </span>
      </div>
      <p id={hintId} className={cn("text-xs", bad ? "text-danger" : "text-muted")}>
        {bad ? "A percentage from 0 to 100, at most two decimals." : (hint ?? (optional ? "Optional." : "Required."))}
      </p>
    </div>
  );
}

export function TermsFields({
  kind,
  draft,
  onChange,
  plans,
  todayKey,
  disabled,
}: {
  kind: PartnerKind;
  draft: TermsDraft;
  onChange: (next: TermsDraft) => void;
  /** Plans a plan rate may name: on offer, never internal. */
  plans: { key: string; name: string }[];
  /** Today on India's calendar (from the loader's clock): the earliest day terms may start. */
  todayKey: string;
  disabled?: boolean;
}) {
  const id = useId();
  const set = (patch: Partial<TermsDraft>) => onChange({ ...draft, ...patch });
  const distributor = kind === "DISTRIBUTOR";

  const fromId = `${id}-from`;
  const fromHint = `${id}-from-hint`;
  const monthsId = `${id}-months`;
  const monthsHint = `${id}-months-hint`;
  const durationId = `${id}-duration`;
  const durationHint = `${id}-duration-hint`;
  const noteId = `${id}-note`;

  const monthsBad = draft.newMonths.trim() !== "" && wholeIn(draft.newMonths, 1, 60) === null;
  const durationBad = draft.durationMonths.trim() !== "" && wholeIn(draft.durationMonths, 1, 240) === null;
  const fromBad = draft.effectiveFrom.trim() !== "" && draft.effectiveFrom.trim() < todayKey;

  function addPlanRate() {
    set({ planRates: [...draft.planRates, { key: draft.seq, planKey: "", rate: "" }], seq: draft.seq + 1 });
  }
  function addCountryRate() {
    set({ countryRates: [...draft.countryRates, { key: draft.seq, country: "", rate: "" }], seq: draft.seq + 1 });
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        For each invoice line the first rate that applies wins: a plan rate, then a country rate, then the new-customer or renewal rate, then the default.
        Commission is on what the customer paid, less tax.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <RateInput id={`${id}-default`} label="Default rate" value={draft.defaultRate} onChange={(v) => set({ defaultRate: v })} disabled={disabled} hint="When nothing else applies." />
        <div className="space-y-1.5">
          <Label htmlFor={fromId}>Starts</Label>
          <Input
            id={fromId}
            type="date"
            min={todayKey}
            value={draft.effectiveFrom}
            onChange={(e) => set({ effectiveFrom: e.target.value })}
            aria-invalid={fromBad || undefined}
            aria-describedby={fromHint}
            readOnly={disabled}
          />
          <p id={fromHint} className={cn("text-xs", fromBad ? "text-danger" : "text-muted")}>
            {fromBad ? "Not before today — terms are never backdated." : "Empty or today: from now. A later day: from the start of it, India time."}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <RateInput id={`${id}-new`} label="New-customer rate" value={draft.newRate} onChange={(v) => set({ newRate: v })} optional disabled={disabled} />
        <div className="space-y-1.5">
          <Label htmlFor={monthsId}>New for (months)</Label>
          <Input
            id={monthsId}
            inputMode="numeric"
            value={draft.newMonths}
            onChange={(e) => set({ newMonths: e.target.value })}
            maxLength={2}
            aria-invalid={monthsBad || undefined}
            aria-describedby={monthsHint}
            readOnly={disabled}
            className="tabular-nums"
          />
          <p id={monthsHint} className={cn("text-xs", monthsBad ? "text-danger" : "text-muted")}>
            {monthsBad ? "1 to 60 months." : "From its first paid invoice."}
          </p>
        </div>
        <RateInput id={`${id}-renewal`} label="Renewal rate" value={draft.renewalRate} onChange={(v) => set({ renewalRate: v })} optional disabled={disabled} hint="After that. Optional." />
      </div>

      <div className="space-y-1.5 sm:max-w-xs">
        <Label htmlFor={durationId}>Commission lasts (months)</Label>
        <Input
          id={durationId}
          inputMode="numeric"
          value={draft.durationMonths}
          onChange={(e) => set({ durationMonths: e.target.value })}
          maxLength={3}
          placeholder="The customer's lifetime"
          aria-invalid={durationBad || undefined}
          aria-describedby={durationHint}
          readOnly={disabled}
          className="tabular-nums"
        />
        <p id={durationHint} className={cn("text-xs", durationBad ? "text-danger" : "text-muted")}>
          {durationBad ? "1 to 240 months, or empty." : "Empty: for as long as the customer pays."}
        </p>
      </div>

      {distributor && (
        <div className="grid gap-4 sm:grid-cols-2">
          <RateInput
            id={`${id}-override`}
            label="Override rate"
            value={draft.overrideRate}
            onChange={(v) => set({ overrideRate: v })}
            optional
            disabled={disabled}
            hint="On its resellers' customers, on top of the reseller's own. Optional."
          />
          <RateInput
            id={`${id}-territory`}
            label="Territory default rate"
            value={draft.territoryRate}
            onChange={(v) => set({ territoryRate: v })}
            optional
            disabled={disabled}
            hint="Credits direct signups in its territories. Off unless set."
          />
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium text-muted">Plan rates</legend>
        {draft.planRates.length === 0 && <p className="text-xs text-muted">None — every plan follows the rates above.</p>}
        {draft.planRates.map((row, i) => (
          <div key={row.key} className="flex items-end gap-2">
            <Select
              aria-label={`Plan for plan rate ${i + 1}`}
              value={row.planKey}
              onChange={(e) => set({ planRates: draft.planRates.map((r) => (r.key === row.key ? { ...r, planKey: e.target.value } : r)) })}
              disabled={disabled}
              className="flex-1"
            >
              <option value="">Choose a plan</option>
              {plans.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Input
              aria-label={`Rate for plan rate ${i + 1}, percent`}
              inputMode="decimal"
              value={row.rate}
              onChange={(e) => set({ planRates: draft.planRates.map((r) => (r.key === row.key ? { ...r, rate: e.target.value } : r)) })}
              maxLength={8}
              placeholder="%"
              readOnly={disabled}
              className="w-24 tabular-nums"
            />
            <IconButton icon={X} label={`Remove plan rate ${i + 1}`} onClick={() => set({ planRates: draft.planRates.filter((r) => r.key !== row.key) })} disabled={disabled} className="mb-1" />
          </div>
        ))}
        {draft.planRates.length < MAX_RATE_ROWS && plans.length > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={addPlanRate} disabled={disabled}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add a plan rate
          </Button>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium text-muted">Country rates</legend>
        {draft.countryRates.length === 0 && <p className="text-xs text-muted">None — every country follows the rates above.</p>}
        {draft.countryRates.map((row, i) => (
          <div key={row.key} className="flex items-end gap-2">
            <Select
              aria-label={`Country for country rate ${i + 1}`}
              value={row.country}
              onChange={(e) => set({ countryRates: draft.countryRates.map((r) => (r.key === row.key ? { ...r, country: e.target.value } : r)) })}
              disabled={disabled}
              className="flex-1"
            >
              <option value="">Choose a country</option>
              {COUNTRY_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
            <Input
              aria-label={`Rate for country rate ${i + 1}, percent`}
              inputMode="decimal"
              value={row.rate}
              onChange={(e) => set({ countryRates: draft.countryRates.map((r) => (r.key === row.key ? { ...r, rate: e.target.value } : r)) })}
              maxLength={8}
              placeholder="%"
              readOnly={disabled}
              className="w-24 tabular-nums"
            />
            <IconButton
              icon={X}
              label={`Remove country rate ${i + 1}`}
              onClick={() => set({ countryRates: draft.countryRates.filter((r) => r.key !== row.key) })}
              disabled={disabled}
              className="mb-1"
            />
          </div>
        ))}
        {draft.countryRates.length < MAX_RATE_ROWS && (
          <Button type="button" variant="ghost" size="sm" onClick={addCountryRate} disabled={disabled}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add a country rate
          </Button>
        )}
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor={noteId}>Note (optional)</Label>
        <Textarea id={noteId} value={draft.note} onChange={(e) => set({ note: e.target.value })} maxLength={NOTE_MAX} rows={2} placeholder="e.g. agreed in the partner contract of 1 Oct 2026" readOnly={disabled} />
      </div>
    </div>
  );
}
