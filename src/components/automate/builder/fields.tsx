"use client";

import { useRef } from "react";
import { Braces, Plus, Trash2 } from "lucide-react";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/menu";
import { RULE_OPS, type Filter, type Rule, type RuleOp } from "@/lib/automate/definition";
import type { Catalog, FieldSpec } from "@/lib/automate/catalog";
import type { DataRef } from "@/components/automate/builder/tree";

/**
 * The builder's fields (Deskzo Automate, Phase 3): each action's inputs drawn from its spec
 * (src/lib/automate/catalog.ts), a data picker that writes `{{…}}` so nobody types one, the person
 * pickers with their special values, and the rule editor that conditions, branches and filters share.
 */

const isTemplate = (v: unknown) => typeof v === "string" && /\{\{[^{}]+\}\}/.test(v);

/** "+ Data": the fields the step may read, grouped; picking one hands back its reference. */
export function DataPicker({ data, onPick, label = "Insert data" }: { data: DataRef[]; onPick: (ref: string) => void; label?: string }) {
  const groups = [...new Set(data.map((d) => d.group))];
  return (
    <Menu label={label} icon={Braces} width={300}>
      {(close) =>
        data.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted">Nothing to read yet: choose what starts the workflow first.</p>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            {groups.map((g) => (
              <div key={g}>
                <MenuLabel>{g}</MenuLabel>
                {data
                  .filter((d) => d.group === g)
                  .map((d) => (
                    <MenuItem
                      key={d.ref}
                      onClick={() => {
                        onPick(d.ref);
                        close();
                      }}
                    >
                      {d.label}
                    </MenuItem>
                  ))}
              </div>
            ))}
          </div>
        )
      }
    </Menu>
  );
}

/** Text with references: typed, or picked into the place the cursor was. */
function TextWithData({ value, onChange, data, long, placeholder }: { value: string; onChange: (v: string) => void; data: DataRef[]; long?: boolean; placeholder?: string }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const insert = (path: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? at;
    onChange(`${value.slice(0, at)}{{${path}}}${value.slice(end)}`);
  };
  return (
    <div className="flex items-start gap-1">
      {long ? (
        <Textarea ref={ref} value={value} onChange={(e) => onChange(e.target.value)} rows={5} placeholder={placeholder} />
      ) : (
        <Input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      )}
      <DataPicker data={data} onPick={insert} />
    </div>
  );
}

/** A person: a special value, somebody by name, or — from the data — whoever a field names. */
function PersonField({ value, onChange, field, catalog, data }: { value: unknown; onChange: (v: unknown) => void; field: FieldSpec; catalog: Catalog; data: DataRef[] }) {
  // Nothing chosen is the field's default — "the workflow's owner" — and shown as that.
  const text = typeof value === "string" ? value : typeof field.default === "string" ? field.default : "";
  if (isTemplate(text)) {
    return (
      <div className="flex items-center gap-1">
        <Input value={text} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="text-xs text-brand hover:underline" onClick={() => onChange(field.default ?? "")}>
          Choose a person
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <Select value={text} onChange={(e) => onChange(e.target.value || undefined)}>
        {!field.required && field.default === undefined && <option value="">—</option>}
        {field.special?.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
        <optgroup label="People">
          {catalog.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </optgroup>
      </Select>
      <DataPicker data={data} onPick={(r) => onChange(`{{${r}}}`)} label="Whoever the data names" />
    </div>
  );
}

function PeopleField({ value, onChange, field, catalog }: { value: unknown; onChange: (v: unknown) => void; field: FieldSpec; catalog: Catalog }) {
  const chosen = Array.isArray(value) ? value.map(String) : [];
  const toggle = (id: string) => onChange(chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id]);
  const options = [...(field.special ?? []), ...catalog.people.map((p) => ({ value: p.id, label: p.name }))];
  return (
    <div className="max-h-40 overflow-y-auto rounded-base border border-line p-2">
      {options.map((o) => (
        <label key={o.value} className="flex items-center gap-2 py-0.5 text-sm">
          <input type="checkbox" checked={chosen.includes(o.value)} onChange={() => toggle(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** One input of an action, by its spec. */
export function FieldInput({ field, value, onChange, catalog, data }: { field: FieldSpec; value: unknown; onChange: (v: unknown) => void; catalog: Catalog; data: DataRef[] }) {
  const text = value === undefined || value === null ? "" : String(value);
  let control: React.ReactNode;
  switch (field.kind) {
    case "boolean":
      control = (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value === undefined ? field.default === true : value === true} onChange={(e) => onChange(e.target.checked)} />
          {field.label}
        </label>
      );
      break;
    case "enum":
      control = (
        <Select value={text || String(field.default ?? "")} onChange={(e) => onChange(e.target.value || undefined)}>
          {!field.required && field.default === undefined && <option value="">—</option>}
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
      break;
    case "number":
      control = isTemplate(value) ? (
        <TextWithData value={text} onChange={onChange} data={data} />
      ) : (
        <div className="flex items-center gap-1">
          <Input
            type="number"
            inputMode="numeric"
            value={text}
            min={field.min}
            max={field.max}
            placeholder={field.default !== undefined ? String(field.default) : undefined}
            onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          />
          <DataPicker data={data} onPick={(r) => onChange(`{{${r}}}`)} />
        </div>
      );
      break;
    case "person":
      control = <PersonField value={value} onChange={onChange} field={field} catalog={catalog} data={data} />;
      break;
    case "people":
      control = <PeopleField value={value} onChange={onChange} field={field} catalog={catalog} />;
      break;
    case "connection": {
      const mine = catalog.connections.filter((c) => !field.provider || c.provider === field.provider);
      control = (
        <div className="space-y-1">
          <Select value={text} onChange={(e) => onChange(e.target.value || undefined)}>
            <option value="">{mine.length ? "Choose…" : "None yet"}</option>
            {mine.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <a href="/automate/connections" target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">
            Add or change connections →
          </a>
        </div>
      );
      break;
    }
    case "stage":
      control = (
        <Select value={text} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">—</option>
          {catalog.pipelines.map((p) => (
            <optgroup key={p.id} label={p.name}>
              {p.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      );
      break;
    case "list":
      control = (
        <TextWithData
          value={Array.isArray(value) ? value.join(", ") : text}
          onChange={(v) => onChange(isTemplate(v) && !v.includes(",") ? v : v.split(",").map((x) => x.trim()).filter(Boolean))}
          data={data}
          placeholder="Comma-separated"
        />
      );
      break;
    case "json":
      control = (
        <Textarea
          defaultValue={value === undefined ? "" : JSON.stringify(value)}
          rows={3}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            if (!raw) return onChange(undefined);
            try {
              onChange(JSON.parse(raw));
            } catch {
              /* left as it was until it reads as JSON */
            }
          }}
        />
      );
      break;
    default:
      control = <TextWithData value={text} onChange={(v) => onChange(v === "" ? undefined : v)} data={data} long={field.kind === "longText"} placeholder={field.default !== undefined ? String(field.default) : undefined} />;
  }
  return (
    <div className="space-y-1">
      {field.kind !== "boolean" && (
        <Label>
          {field.label}
          {field.required && <span className="text-danger"> *</span>}
        </Label>
      )}
      {control}
      {field.hint && <p className="text-xs text-subtle">{field.hint}</p>}
    </div>
  );
}

const OP_LABELS: Record<RuleOp, string> = {
  eq: "is",
  ne: "is not",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  in: "is one of",
  notIn: "is none of",
  contains: "contains",
  notContains: "doesn't contain",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
};

/** Rules: all of them, or any one — on the data the step may read. */
export function FilterEditor({ filter, onChange, data, emptyText }: { filter: Filter | undefined; onChange: (f: Filter | undefined) => void; data: DataRef[]; emptyText: string }) {
  const any = !!filter && "any" in filter;
  const rules: Rule[] = filter ? ("any" in filter ? filter.any : filter.all) : [];
  const set = (next: Rule[], mode = any) => onChange(next.length ? (mode ? { any: next } : { all: next }) : undefined);
  const change = (i: number, rule: Rule) => set(rules.map((r, j) => (j === i ? rule : r)));
  return (
    <div className="space-y-2">
      {rules.length === 0 ? (
        <p className="text-xs text-muted">{emptyText}</p>
      ) : (
        <>
          {rules.length > 1 && (
            <Select value={any ? "any" : "all"} onChange={(e) => set(rules, e.target.value === "any")} className="w-auto">
              <option value="all">All of these</option>
              <option value="any">Any one of these</option>
            </Select>
          )}
          {rules.map((rule, i) => (
            <div key={i} className="space-y-1 rounded-base border border-line p-2">
              <div className="flex items-center gap-1">
                <Select value={rule.ref} onChange={(e) => change(i, { ...rule, ref: e.target.value })}>
                  {!data.some((d) => d.ref === rule.ref) && <option value={rule.ref}>{rule.ref || "Choose…"}</option>}
                  {data.map((d) => (
                    <option key={d.ref} value={d.ref}>
                      {d.label}
                    </option>
                  ))}
                </Select>
                <button type="button" aria-label="Remove this rule" className="p-1 text-subtle hover:text-danger" onClick={() => set(rules.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-center gap-1">
                <Select value={rule.op} onChange={(e) => change(i, { ...rule, op: e.target.value as RuleOp })} className="w-40">
                  {RULE_OPS.map((op) => (
                    <option key={op} value={op}>
                      {OP_LABELS[op]}
                    </option>
                  ))}
                </Select>
                {rule.op !== "isEmpty" && rule.op !== "isNotEmpty" && (
                  <Input
                    value={Array.isArray(rule.value) ? rule.value.join(", ") : rule.value === undefined || rule.value === null ? "" : String(rule.value)}
                    placeholder={rule.op === "in" || rule.op === "notIn" ? "a, b, c" : "Value"}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const value = rule.op === "in" || rule.op === "notIn" ? raw.split(",").map((x) => x.trim()).filter(Boolean).map((x) => (/^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x)) : raw === "true" ? true : raw === "false" ? false : raw;
                      change(i, { ...rule, value });
                    }}
                  />
                )}
              </div>
            </div>
          ))}
        </>
      )}
      <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline" onClick={() => set([...rules, { ref: data[0]?.ref ?? "", op: "eq", value: "" }])}>
        <Plus className="h-3.5 w-3.5" /> Add a rule
      </button>
    </div>
  );
}
