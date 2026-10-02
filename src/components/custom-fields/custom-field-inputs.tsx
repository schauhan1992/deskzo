"use client";

import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { CUSTOM_FIELD_LIMITS, groupDefs, sentence, type CustomFieldDef } from "@/lib/custom-fields/rules";

/** What the inputs hold for each field: text for most, true/false for yes-or-no, a list for multi-select. */
export type CustomFieldFormValues = Record<string, string | boolean | string[]>;
export type CustomFieldPerson = { id: string; name: string };

/**
 * The fields still empty that must be answered — checked before a form is sent, so the person sees
 * which ones at once; the server checks again (src/lib/custom-fields/rules.ts `applyInput`).
 */
export function missingRequired(fields: CustomFieldDef[], values: CustomFieldFormValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (!f.required || f.type === "CHECKBOX") continue;
    const v = values[f.key];
    if (v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0)) out[f.key] = sentence(`Enter ${f.label}`);
  }
  return out;
}

/**
 * A workspace's own fields as inputs, under their headings — for any form, whatever it is built with:
 * it holds nothing itself, the form keeps `values` and is told of every change.
 */
export function CustomFieldInputs({
  fields,
  values,
  onChange,
  errors = {},
  people = [],
  idPrefix = "cf",
  disabled = false,
}: {
  fields: CustomFieldDef[];
  values: CustomFieldFormValues;
  onChange: (key: string, value: string | boolean | string[]) => void;
  errors?: Record<string, string>;
  people?: CustomFieldPerson[];
  /** Keeps ids apart when one page has two of these. */
  idPrefix?: string;
  disabled?: boolean;
}) {
  const groups = groupDefs(fields);
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.group || "_"} className="space-y-3">
          {g.group && <h3 className="text-sm font-medium text-text">{g.group}</h3>}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {g.fields.map((f) => (
              <FieldInput
                key={f.key}
                field={f}
                value={values[f.key]}
                onChange={(v) => onChange(f.key, v)}
                error={errors[f.key]}
                people={people}
                idPrefix={idPrefix}
                disabled={disabled}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  error,
  people,
  idPrefix,
  disabled,
}: {
  field: CustomFieldDef;
  value: string | boolean | string[] | undefined;
  onChange: (value: string | boolean | string[]) => void;
  error?: string;
  people: CustomFieldPerson[];
  idPrefix: string;
  disabled: boolean;
}) {
  const id = `${idPrefix}-${field.key}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [field.helpText ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const text = typeof value === "string" ? value : "";
  const aria = {
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    "aria-required": field.required || undefined,
  } as const;

  const label = (
    <span>
      {field.label}
      {field.required && (
        <span className="text-danger" aria-hidden="true">
          {" "}
          *
        </span>
      )}
      {field.restricted && <span className="ml-1.5 text-xs font-normal text-subtle">restricted</span>}
    </span>
  );
  const footer = (
    <>
      {field.helpText && (
        <p id={hintId} className="text-xs text-subtle">
          {field.helpText}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      )}
    </>
  );

  if (field.type === "CHECKBOX") {
    return (
      <div className="space-y-1.5 self-end">
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" className="h-4 w-4" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} {...aria} />
          {label}
        </label>
        {footer}
      </div>
    );
  }

  if (field.type === "MULTI_SELECT") {
    const chosen = Array.isArray(value) ? value : [];
    const offered = field.options.filter((o) => !o.archived || chosen.includes(o.value));
    return (
      <fieldset className="space-y-1.5 sm:col-span-2" aria-describedby={describedBy} aria-invalid={error ? true : undefined}>
        <legend className="text-sm font-medium text-text">{label}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {offered.map((o) => (
            <label key={o.value} className="flex items-center gap-1.5 text-sm text-text">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={chosen.includes(o.value)}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked ? [...chosen, o.value] : chosen.filter((v) => v !== o.value))}
              />
              {o.label}
              {o.archived && <span className="text-xs text-subtle">(retired)</span>}
            </label>
          ))}
        </div>
        {footer}
      </fieldset>
    );
  }

  let control: React.ReactNode;
  switch (field.type) {
    case "LONG_TEXT":
      control = <Textarea id={id} value={text} maxLength={CUSTOM_FIELD_LIMITS.longText} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...aria} />;
      break;
    case "NUMBER":
    case "MONEY":
      control = (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          step={field.type === "MONEY" ? "0.01" : "any"}
          value={text}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          {...aria}
        />
      );
      break;
    case "DATE":
      control = <Input id={id} type="date" value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...aria} />;
      break;
    case "EMAIL":
      control = <Input id={id} type="email" autoComplete="off" value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...aria} />;
      break;
    case "PHONE":
      control = <Input id={id} type="tel" autoComplete="off" value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...aria} />;
      break;
    case "URL":
      // Text rather than type="url": the browser would refuse "example.com" without its https://, which
      // the server accepts and completes.
      control = <Input id={id} inputMode="url" autoComplete="off" placeholder="example.com" value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...aria} />;
      break;
    case "SELECT": {
      const offered = field.options.filter((o) => !o.archived || o.value === text);
      control = (
        <Select id={id} value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...aria}>
          <option value="">{field.required ? "Choose…" : "—"}</option>
          {offered.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {o.archived ? " (retired)" : ""}
            </option>
          ))}
        </Select>
      );
      break;
    }
    case "USER": {
      const known = people.some((p) => p.id === text);
      control = (
        <Select id={id} value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...aria}>
          <option value="">{field.required ? "Choose a person…" : "—"}</option>
          {text && !known && <option value={text}>Someone no longer here</option>}
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      );
      break;
    }
    default:
      control = <Input id={id} value={text} maxLength={CUSTOM_FIELD_LIMITS.text} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...aria} />;
  }

  return (
    <div className={`space-y-1.5${field.type === "LONG_TEXT" ? " sm:col-span-2" : ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {control}
      {footer}
    </div>
  );
}
