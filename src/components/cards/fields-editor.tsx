"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { FIELD_KINDS, kindLabel, kindPlaceholder, type FieldKind } from "@/lib/cards/fields";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";

/** A field while it is being typed: not yet checked, so not yet a CardField. */
export type DraftField = { kind: FieldKind; label: string; value: string };

/**
 * A list of card fields to add to, change, reorder and remove — the holder's own fields on My card,
 * and a template's shared ones. Checked by the server when saved; here only the shape is kept.
 */
export function FieldsEditor({
  fields,
  onChange,
  max,
  idPrefix,
  addLabel = "Add a field",
}: {
  fields: DraftField[];
  onChange: (next: DraftField[]) => void;
  max: number;
  idPrefix: string;
  addLabel?: string;
}) {
  const update = (i: number, patch: Partial<DraftField>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {fields.map((field, i) => (
        <div key={i} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2 rounded-base border border-line p-2 sm:grid-cols-[8rem_8rem_minmax(0,1fr)_auto]">
          <Select
            aria-label="Kind"
            value={field.kind}
            onChange={(e) => {
              const kind = e.target.value as FieldKind;
              // A label still saying the old kind follows the new one; one somebody wrote stays.
              update(i, { kind, label: field.label === kindLabel(field.kind) ? kindLabel(kind) : field.label });
            }}
          >
            {FIELD_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </Select>
          <Input aria-label="Label" maxLength={40} value={field.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Label" />
          <Input
            id={`${idPrefix}-${i}`}
            aria-label={`${field.label || kindLabel(field.kind)} value`}
            className="col-span-2 sm:col-span-1"
            maxLength={300}
            value={field.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={kindPlaceholder(field.kind)}
          />
          <div className="col-span-2 flex justify-end gap-1 sm:col-span-1">
            <Button type="button" variant="ghost" size="sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="sm" aria-label="Move down" disabled={i === fields.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Remove"
              className="text-danger hover:bg-danger-bg hover:text-danger"
              onClick={() => onChange(fields.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ))}
      {fields.length < max && (
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...fields, { kind: "linkedin", label: kindLabel("linkedin"), value: "" }])}>
          <Plus className="h-3.5 w-3.5" />
          {addLabel}
        </Button>
      )}
    </div>
  );
}
