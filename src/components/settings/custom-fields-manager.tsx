"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  archiveCustomFieldDefinition,
  deleteCustomFieldDefinition,
  moveCustomFieldDefinition,
  restoreCustomFieldDefinition,
  saveCustomFieldDefinition,
} from "@/actions/custom-fields";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import {
  CUSTOM_FIELD_ENTITY_LABELS,
  CUSTOM_FIELD_LIMITS,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPE_LABELS,
  hasOptions,
  type CustomFieldEntityKey,
  type CustomFieldOption,
  type CustomFieldTypeKey,
} from "@/lib/custom-fields/rules";

type Field = {
  id: string;
  entity: CustomFieldEntityKey;
  key: string;
  label: string;
  type: CustomFieldTypeKey;
  options: CustomFieldOption[];
  required: boolean;
  helpText: string | null;
  group: string | null;
  restricted: boolean;
  showInList: boolean;
  archived: boolean;
  inUse: number;
};

type Draft = {
  id: string;
  entity: CustomFieldEntityKey;
  label: string;
  type: CustomFieldTypeKey;
  options: { value: string; label: string; archived: boolean }[];
  required: boolean;
  helpText: string;
  group: string;
  restricted: boolean;
  showInList: boolean;
};

/** One line on what a field is, under its name. */
function summary(f: Field) {
  const parts = [CUSTOM_FIELD_TYPE_LABELS[f.type]];
  if (hasOptions(f.type)) {
    const live = f.options.filter((o) => !o.archived);
    parts.push(`${live.length} option${live.length === 1 ? "" : "s"}: ${live.slice(0, 4).map((o) => o.label).join(", ")}${live.length > 4 ? "…" : ""}`);
  }
  if (f.group) parts.push(`under “${f.group}”`);
  return parts.join(" · ");
}

/**
 * The custom fields settings screen (src/actions/custom-fields.ts): a tab for each kind of record,
 * its fields in the order forms show them, and a dialog to add or change one.
 */
export function CustomFieldsManager({ entities }: { entities: { entity: CustomFieldEntityKey; label: string; fields: Field[] }[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [tab, setTab] = useState<CustomFieldEntityKey>(entities[0]?.entity ?? "COMPANY");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));

  const current = entities.find((e) => e.entity === tab) ?? entities[0];
  const active = current ? current.fields.filter((f) => !f.archived) : [];
  const retired = current ? current.fields.filter((f) => f.archived) : [];
  const groups = [...new Set(active.map((f) => f.group).filter((g): g is string => !!g))];

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      after?.();
      router.refresh();
    });
  }

  function add() {
    setError(null);
    setDraft({ id: "", entity: tab, label: "", type: "TEXT", options: [], required: false, helpText: "", group: "", restricted: false, showInList: false });
  }

  function edit(f: Field) {
    setError(null);
    setDraft({
      id: f.id,
      entity: f.entity,
      label: f.label,
      type: f.type,
      options: f.options.map((o) => ({ value: o.value, label: o.label, archived: !!o.archived })),
      required: f.required,
      helpText: f.helpText ?? "",
      group: f.group ?? "",
      restricted: f.restricted,
      showInList: f.showInList,
    });
  }

  function setOption(index: number, patch: Partial<Draft["options"][number]>) {
    setDraft((d) => (d ? { ...d, options: d.options.map((o, i) => (i === index ? { ...o, ...patch } : o)) } : d));
  }

  function removeOption(index: number) {
    // A saved option is retired, never dropped: records that hold it keep showing what it says.
    setDraft((d) => {
      if (!d) return d;
      const o = d.options[index];
      if (!o) return d;
      return { ...d, options: o.value ? d.options.map((x, i) => (i === index ? { ...x, archived: true } : x)) : d.options.filter((_, i) => i !== index) };
    });
  }

  if (!current) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted">No record types are in this workspace&apos;s plan.</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Kind of record" className="flex flex-wrap gap-1 border-b border-line">
        {entities.map((e) => {
          const count = e.fields.filter((f) => !f.archived).length;
          const selected = e.entity === current.entity;
          return (
            <button
              key={e.entity}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => {
                setTab(e.entity);
                setError(null);
                setShowRetired(false);
              }}
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${selected ? "border-brand text-text" : "border-transparent text-muted hover:text-text"}`}
            >
              {e.label}
              {count > 0 && <span className="ml-1.5 text-xs text-subtle">{count}</span>}
            </button>
          );
        })}
      </div>
      {/* Two tabs on one kind of record: say which companies each is for. */}
      {(current.entity === "COMPANY" || current.entity === "VENDOR") && entities.some((e) => e.entity === "VENDOR") && (
        <p className="text-xs text-subtle">
          {current.entity === "COMPANY"
            ? "Shown on customers, resellers and commission parties. Vendors have their own fields, under Vendors."
            : "Shown on vendors, OEMs, distributors and partners — not on customers, whose fields are under Companies."}
        </p>
      )}

      {error && !draft && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          {active.length === 0
            ? `No fields of your own on ${current.label.toLowerCase()} yet.`
            : `${active.length} field${active.length === 1 ? "" : "s"} on ${current.label.toLowerCase()}, in the order forms show them.`}
        </p>
        <Button type="button" size="sm" onClick={add} disabled={active.length >= CUSTOM_FIELD_LIMITS.fieldsPerEntity}>
          Add a field
        </Button>
      </div>

      {active.length > 0 && (
        <div className="space-y-2">
          {active.map((f, index) => (
            <Card key={f.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-1.5 font-medium text-text">
                    {f.label}
                    {f.required && <Badge tone="blue">Required</Badge>}
                    {f.restricted && <Badge tone="amber">Restricted</Badge>}
                    {f.showInList && <Badge tone="default">In the list</Badge>}
                  </p>
                  <p className="text-muted">{summary(f)}</p>
                  {f.helpText && <p className="text-xs text-subtle">{f.helpText}</p>}
                  <p className="text-xs text-subtle">
                    {f.inUse === 0 ? "No record has a value yet" : `${f.inUse} record${f.inUse === 1 ? " has" : "s have"} a value`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Move ${f.label} up`}
                    disabled={isPending || index === 0}
                    onClick={() => run(() => moveCustomFieldDefinition(f.id, "up"))}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Move ${f.label} down`}
                    disabled={isPending || index === active.length - 1}
                    onClick={() => run(() => moveCustomFieldDefinition(f.id, "down"))}
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => edit(f)}>
                    Change
                  </Button>
                  {f.inUse === 0 ? (
                    <Button type="button" variant="ghost" size="sm" className="text-danger" disabled={isPending} onClick={() => run(() => deleteCustomFieldDefinition(f.id))}>
                      Delete
                    </Button>
                  ) : (
                    <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => archiveCustomFieldDefinition(f.id))}>
                      Retire
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {retired.length > 0 && (
        <div className="space-y-2">
          <button type="button" className="text-sm text-muted underline-offset-2 hover:underline" onClick={() => setShowRetired((s) => !s)} aria-expanded={showRetired}>
            {showRetired ? "Hide" : "Show"} {retired.length} retired field{retired.length === 1 ? "" : "s"}
          </button>
          {showRetired &&
            retired.map((f) => (
              <Card key={f.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="text-text">
                      {f.label} <Badge tone="default">Retired</Badge>
                    </p>
                    <p className="text-xs text-subtle">
                      {summary(f)} · {f.inUse} record{f.inUse === 1 ? "" : "s"} still hold a value
                    </p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => restoreCustomFieldDefinition(f.id))}>
                    Restore
                  </Button>
                </CardContent>
              </Card>
            ))}
        </div>
      )}

      {draft && (
        <Dialog open onClose={() => setDraft(null)} title={draft.id ? `Change “${draft.label || "field"}”` : `Add a field to ${CUSTOM_FIELD_ENTITY_LABELS[draft.entity].toLowerCase()}`}>
          <div className="space-y-3">
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="cf-label" className="text-xs">
                  Name
                </Label>
                <Input id="cf-label" placeholder="Batch no." maxLength={CUSTOM_FIELD_LIMITS.label} value={draft.label} onChange={(e) => set("label", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cf-type" className="text-xs">
                  Type
                </Label>
                <Select
                  id="cf-type"
                  value={draft.type}
                  disabled={!!draft.id}
                  onChange={(e) => {
                    const type = e.target.value as CustomFieldTypeKey;
                    setDraft((d) => (d ? { ...d, type, options: hasOptions(type) && d.options.length === 0 ? [{ value: "", label: "", archived: false }] : d.options } : d));
                  }}
                >
                  {CUSTOM_FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {CUSTOM_FIELD_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
                {draft.id && <p className="text-xs text-subtle">The type is fixed once a field exists.</p>}
              </div>
            </div>

            {hasOptions(draft.type) && (
              <fieldset className="space-y-2 rounded-md border border-line p-3">
                <legend className="px-1 text-xs font-medium text-text">Options</legend>
                {draft.options.map((o, index) =>
                  o.archived ? (
                    <div key={index} className="flex items-center justify-between gap-2 text-sm text-subtle">
                      <span>
                        {o.label} <Badge tone="default">Retired</Badge>
                      </span>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setOption(index, { archived: false })}>
                        Bring back
                      </Button>
                    </div>
                  ) : (
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        aria-label={`Option ${index + 1}`}
                        placeholder={`Option ${index + 1}`}
                        maxLength={CUSTOM_FIELD_LIMITS.optionLabel}
                        value={o.label}
                        onChange={(e) => setOption(index, { label: e.target.value })}
                      />
                      <Button type="button" variant="ghost" size="sm" aria-label={`Remove option ${index + 1}`} onClick={() => removeOption(index)}>
                        Remove
                      </Button>
                    </div>
                  ),
                )}
                {draft.options.length < CUSTOM_FIELD_LIMITS.options && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => set("options", [...draft.options, { value: "", label: "", archived: false }])}>
                    + Add an option
                  </Button>
                )}
                <p className="text-xs text-subtle">A removed option stays on the records that have it, marked retired, and can be brought back.</p>
              </fieldset>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="cf-group" className="text-xs">
                  Heading (optional)
                </Label>
                <Input id="cf-group" list="cf-groups" placeholder="Compliance" maxLength={CUSTOM_FIELD_LIMITS.group} value={draft.group} onChange={(e) => set("group", e.target.value)} />
                <datalist id="cf-groups">
                  {groups.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
                <p className="text-xs text-subtle">Fields with the same heading are shown together.</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="cf-help" className="text-xs">
                  Hint (optional)
                </Label>
                <Input id="cf-help" placeholder="As printed on the box" maxLength={CUSTOM_FIELD_LIMITS.helpText} value={draft.helpText} onChange={(e) => set("helpText", e.target.value)} />
                <p className="text-xs text-subtle">Shown under the field when it is filled in.</p>
              </div>
            </div>

            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm text-text">
                <input type="checkbox" className="mt-0.5" checked={draft.required} onChange={(e) => set("required", e.target.checked)} />
                <span>
                  Required
                  <span className="block text-xs text-subtle">Every form for these records asks for it before saving.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-text">
                <input type="checkbox" className="mt-0.5" checked={draft.restricted} onChange={(e) => set("restricted", e.target.checked)} />
                <span>
                  Restricted
                  <span className="block text-xs text-subtle">Only people allowed to “See restricted custom fields” see or change it — a cost price, a commission rate.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-text">
                <input type="checkbox" className="mt-0.5" checked={draft.showInList} onChange={(e) => set("showInList", e.target.checked)} />
                <span>
                  A column in the list
                  <span className="block text-xs text-subtle">
                    {/* Products and contacts have no column picker, so their columns can't be hidden one person at a time. */}
                    {draft.entity === "ITEM" || draft.entity === "CONTACT"
                      ? `Shown in the ${CUSTOM_FIELD_ENTITY_LABELS[draft.entity].toLowerCase()} list.`
                      : `Shown in the ${CUSTOM_FIELD_ENTITY_LABELS[draft.entity].toLowerCase()} list unless somebody hides it with the column picker; anyone can show the others there.`}
                  </span>
                </span>
              </label>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isPending || !draft.label.trim()}
              onClick={() =>
                run(
                  () =>
                    saveCustomFieldDefinition({
                      ...draft,
                      options: draft.options.filter((o) => o.value || o.label.trim()).map((o) => ({ value: o.value, label: o.label.trim(), archived: o.archived })),
                    }),
                  () => setDraft(null),
                )
              }
            >
              {isPending ? "Saving…" : draft.id ? "Save" : "Add the field"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
