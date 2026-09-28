"use client";

import { useId, useState } from "react";
import { X } from "lucide-react";
import { OptionCombobox, type ComboOption } from "@/components/ui/option-combobox";
import { Label, Select } from "@/components/ui/input";
import { COUNTRIES } from "@/lib/geo/countries";
import { cn } from "@/lib/utils";
import { COUNTRY_OPTIONS, countryName } from "./format";

/**
 * The partner forms' country fields: one country (a plain select, India first), and a partner's
 * territories — countries added one at a time from a type-to-search list and shown as removable
 * chips. Codes are ISO 3166-1 alpha-2, as the server keeps them.
 */

const TERRITORY_OPTIONS: ComboOption[] = COUNTRIES.map((c) => ({ id: c.code, name: `${c.name} (${c.code})` }));

export function CountrySelect({
  id,
  label,
  value,
  onChange,
  disabled,
  placeholder = "Choose a country",
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  placeholder?: string;
  describedBy?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-describedby={describedBy}>
        <option value="">{placeholder}</option>
        {COUNTRY_OPTIONS.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

/**
 * Territories: search a country, pick it, and it joins the chips (each once). `outside` marks chips
 * the server would refuse — a reseller's country outside its distributor's territories — in words as
 * well as colour.
 */
export function TerritoryPicker({
  label,
  value,
  onChange,
  disabled,
  outside = [],
  hint,
}: {
  label: string;
  value: string[];
  onChange: (codes: string[]) => void;
  disabled?: boolean;
  outside?: readonly string[];
  hint?: string;
}) {
  const id = useId();
  const inputId = `${id}-territory`;
  const hintId = `${id}-territory-hint`;
  // The combobox shows what was chosen until it is cleared; it is cleared as soon as the choice lands.
  const [picked, setPicked] = useState("");
  const off = new Set(outside);

  function add(option: ComboOption | null) {
    if (!option) {
      setPicked("");
      return;
    }
    if (!value.includes(option.id)) onChange([...value, option.id]);
    setPicked("");
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <OptionCombobox
        id={inputId}
        options={TERRITORY_OPTIONS.filter((o) => !value.includes(o.id))}
        value={picked}
        onSelect={add}
        listLabel="Countries"
        placeholder="Add a country…"
        emptyText="No country matches that."
        disabled={disabled}
      />
      {value.length > 0 && (
        <ul aria-label={`${label}: chosen`} className="flex flex-wrap gap-1.5 pt-1">
          {value.map((code) => (
            <li
              key={code}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-full border pr-1 pl-2 text-xs",
                off.has(code) ? "border-danger/40 bg-danger-bg text-danger" : "border-line bg-surface-sunken text-text",
              )}
            >
              <span title={countryName(code)}>{off.has(code) ? `${code} — outside` : code}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((c) => c !== code))}
                disabled={disabled}
                aria-label={`Remove ${countryName(code)}`}
                title={`Remove ${countryName(code)}`}
                className="grid h-4 w-4 place-items-center rounded-full text-subtle hover:bg-surface hover:text-text"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p id={hintId} className="text-xs text-muted">
        {hint ?? (value.length === 0 ? "At least one country." : `${value.length} ${value.length === 1 ? "country" : "countries"}.`)}
      </p>
    </div>
  );
}
