"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
import type { ContactDesignation, ItemType, LeadAssignmentStrategy, LeadSource } from "@prisma/client";
import {
  deleteAssignmentRule,
  moveAssignmentRule,
  previewAssignment,
  saveAssignmentRule,
} from "@/actions/lead-assignment";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Select } from "@/components/ui/input";
import { OptionCombobox } from "@/components/ui/option-combobox";
import { INDIAN_STATES } from "@/lib/geo/india";
import { LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES } from "@/lib/leads/source";

type Rule = {
  id: string;
  name: string;
  priority: number;
  active: boolean;
  brandIds: string[];
  itemTypes: ItemType[];
  designations: ContactDesignation[];
  sources: LeadSource[];
  states: string[];
  strategy: LeadAssignmentStrategy;
  userIds: string[];
  skipOnLeave: boolean;
};
type Person = { id: string; name: string; email: string; role: string };
type Brand = { id: string; name: string };

const STRATEGY: Record<LeadAssignmentStrategy, { label: string; hint: string }> = {
  ROUND_ROBIN: { label: "Round robin", hint: "Each person in turn." },
  LEAST_LOADED: { label: "Fewest open leads", hint: "Whoever is carrying the fewest open leads right now." },
  SPECIFIC_USER: { label: "A named person", hint: "Always the first person chosen who is available." },
  ACCOUNT_MANAGER: { label: "The account manager", hint: "The company's own account manager, if it has one — otherwise the next rule decides." },
};
const ITEM_TYPES: { value: ItemType; label: string }[] = [
  { value: "SUBSCRIPTION", label: "Subscriptions" },
  { value: "GOOD", label: "Hardware" },
  { value: "SERVICE", label: "Services" },
];
const DESIGNATIONS: ContactDesignation[] = ["CEO", "CIO", "DIRECTOR", "IT_HEAD", "IT_MANAGER", "PURCHASE_MANAGER", "HR", "OTHER"];
const words = (s: string) => s.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** A row of toggle chips — "any of these", empty meaning any. */
function Chips<T extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  selected: T[];
  onChange: (next: T[]) => void;
}) {
  const [filter, setFilter] = useState("");
  /**
   * A long list — a catalogue's thousand brands — gets a box to narrow it. What is already chosen
   * stays in view whatever is typed, so narrowing never hides a choice somebody has made.
   */
  const searchable = options.length > 24;
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? options.filter((o) => selected.includes(o.value) || o.label.toLowerCase().includes(needle))
    : options;
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-medium text-muted">
        {label} <span className="font-normal text-subtle">{selected.length ? `— ${selected.length} chosen` : "— any"}</span>
      </legend>
      {searchable && (
        <Input
          aria-label={`Filter ${label.toLowerCase()}`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Type to find a ${label.toLowerCase()}…`}
          className="h-8"
        />
      )}
      <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
        {shown.map((o) => {
          const on = selected.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-brand bg-brand text-brand-contrast" : "border-line-strong text-muted hover:bg-surface-sunken"}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

const EMPTY: Omit<Rule, "id" | "priority"> & { id?: string } = {
  name: "",
  active: true,
  brandIds: [],
  itemTypes: [],
  designations: [],
  sources: [],
  states: [],
  strategy: "ROUND_ROBIN",
  userIds: [],
  skipOnLeave: true,
};

export function LeadAssignmentManager({ rules, brands, people }: { rules: Rule[]; brands: Brand[]; people: Person[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<typeof EMPTY | null>(null);
  const [test, setTest] = useState({ brandId: "", itemType: "", designation: "", source: "WEBSITE", state: "" });
  const [testResult, setTestResult] = useState<string | null>(null);

  const personName = (id: string) => people.find((p) => p.id === id)?.name ?? "someone no longer active";
  const brandName = (id: string) => brands.find((b) => b.id === id)?.name ?? "a removed brand";

  function describe(r: Rule): string {
    const parts = [
      r.brandIds.length && `brand ${r.brandIds.map(brandName).join(" or ")}`,
      r.itemTypes.length && `${r.itemTypes.map((t) => ITEM_TYPES.find((i) => i.value === t)?.label.toLowerCase()).join(" or ")}`,
      r.designations.length && `contact is ${r.designations.map(words).join(" or ")}`,
      r.sources.length && `from ${r.sources.map((s) => LEAD_SOURCE_LABELS[s]).join(" or ")}`,
      r.states.length && `in ${r.states.join(" or ")}`,
    ].filter(Boolean);
    return parts.length ? `When ${parts.join(", ")}` : "Every lead";
  }

  function run(action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      after?.();
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}

      <Card>
        <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
          <span>Rules — tried top to bottom, the first that fits decides</span>
          <Button type="button" size="sm" onClick={() => setEditing({ ...EMPTY })}>
            + Add rule
          </Button>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {rules.length === 0 ? (
            <div className="space-y-2 text-muted">
              <p>No rules yet, so a lead nobody assigns — including every website lead — arrives unassigned.</p>
              <p>
                A good start: an <span className="font-medium text-text">Account manager</span> rule first, so existing customers stay
                with the person who knows them, then a rule with no conditions that round-robins the rest across your sales team.
              </p>
            </div>
          ) : (
            <ol className="space-y-2">
              {rules.map((r, i) => (
                <li key={r.id} className={`rounded-md border border-line p-3 ${r.active ? "" : "opacity-60"}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs tabular-nums text-subtle">{i + 1}.</span>
                        <span className="font-medium text-text">{r.name}</span>
                        {!r.active && <Badge>Off</Badge>}
                      </div>
                      <p className="text-muted">{describe(r)}</p>
                      <p className="text-muted">
                        → <span className="text-text">{STRATEGY[r.strategy].label}</span>
                        {r.strategy !== "ACCOUNT_MANAGER" && <>: {r.userIds.map(personName).join(", ")}</>}
                        {r.skipOnLeave && <span className="text-subtle"> · skipping anyone on leave</span>}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <IconButton icon={ArrowUp} label="Move up" disabled={i === 0 || pending} onClick={() => run(() => moveAssignmentRule(r.id, "up"))} />
                      <IconButton icon={ArrowDown} label="Move down" disabled={i === rules.length - 1 || pending} onClick={() => run(() => moveAssignmentRule(r.id, "down"))} />
                      <IconButton icon={Pencil} label="Edit rule" onClick={() => setEditing({ ...r })} />
                      <IconButton icon={Trash2} label="Delete rule" tone="danger" disabled={pending} onClick={() => run(() => deleteAssignmentRule(r.id))} />
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Test a lead</CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted">Who would a lead like this go to? Nothing is assigned, and nobody&apos;s turn is used up.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
            <OptionCombobox
              listLabel="Brands"
              options={brands.map((b) => ({ id: b.id, name: b.name }))}
              value={test.brandId}
              onSelect={(b) => setTest({ ...test, brandId: b?.id ?? "" })}
              placeholder="Any brand"
            />
            <Select aria-label="Product type" value={test.itemType} onChange={(e) => setTest({ ...test, itemType: e.target.value })}>
              <option value="">Any product type</option>
              {ITEM_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
            <Select aria-label="Designation" value={test.designation} onChange={(e) => setTest({ ...test, designation: e.target.value })}>
              <option value="">No contact</option>
              {DESIGNATIONS.map((d) => (
                <option key={d} value={d}>
                  {words(d)}
                </option>
              ))}
            </Select>
            <Select aria-label="Source" value={test.source} onChange={(e) => setTest({ ...test, source: e.target.value })}>
              {LEAD_SOURCE_VALUES.map((s) => (
                <option key={s} value={s}>
                  {LEAD_SOURCE_LABELS[s]}
                </option>
              ))}
            </Select>
            <Select aria-label="State" value={test.state} onChange={(e) => setTest({ ...test, state: e.target.value })}>
              <option value="">Any state</option>
              {INDIAN_STATES.map((s) => (
                <option key={s.code} value={s.name}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await previewAssignment({
                    brandIds: test.brandId ? [test.brandId] : [],
                    itemTypes: test.itemType ? [test.itemType] : [],
                    designation: test.designation,
                    source: test.source,
                    state: test.state,
                  });
                  setTestResult(
                    !result.ok
                      ? result.error
                      : result.data.person
                        ? `→ ${result.data.person}, by ${result.data.rule}`
                        : "→ Unassigned — no rule fits a lead like this.",
                  );
                })
              }
            >
              Who would get it?
            </Button>
            {testResult && <span className="text-text">{testResult}</span>}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit rule" : "New rule"}>
        {editing && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => saveAssignmentRule(editing), () => setEditing(null));
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="rule-name">Name</Label>
              <Input
                id="rule-name"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="Microsoft leads — north"
                autoComplete="off"
              />
            </div>

            <div className="space-y-3 rounded-md border border-line p-3">
              <p className="text-xs text-subtle">Applies when every chosen condition fits. Leave a condition empty to match anything.</p>
              <Chips label="Brand" options={brands.map((b) => ({ value: b.id, label: b.name }))} selected={editing.brandIds} onChange={(v) => setEditing({ ...editing, brandIds: v })} />
              <Chips label="Product type" options={ITEM_TYPES} selected={editing.itemTypes} onChange={(v) => setEditing({ ...editing, itemTypes: v })} />
              <Chips label="Contact's designation" options={DESIGNATIONS.map((d) => ({ value: d, label: words(d) }))} selected={editing.designations} onChange={(v) => setEditing({ ...editing, designations: v })} />
              <Chips label="Source" options={LEAD_SOURCE_VALUES.map((s) => ({ value: s, label: LEAD_SOURCE_LABELS[s] }))} selected={editing.sources} onChange={(v) => setEditing({ ...editing, sources: v })} />
              <Chips label="State" options={INDIAN_STATES.map((s) => ({ value: s.name, label: s.name }))} selected={editing.states} onChange={(v) => setEditing({ ...editing, states: v })} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rule-strategy">Assign by</Label>
              <Select id="rule-strategy" value={editing.strategy} onChange={(e) => setEditing({ ...editing, strategy: e.target.value as LeadAssignmentStrategy })}>
                {(Object.keys(STRATEGY) as LeadAssignmentStrategy[]).map((s) => (
                  <option key={s} value={s}>
                    {STRATEGY[s].label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-subtle">{STRATEGY[editing.strategy].hint}</p>
            </div>

            {editing.strategy !== "ACCOUNT_MANAGER" && (
              <Chips
                label="Between these people"
                options={people.map((p) => ({ value: p.id, label: p.name }))}
                selected={editing.userIds}
                onChange={(v) => setEditing({ ...editing, userIds: v })}
              />
            )}

            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={editing.skipOnLeave} onChange={(e) => setEditing({ ...editing, skipOnLeave: e.target.checked })} />
                Skip anyone on approved leave that day
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                Rule is on
              </label>
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Saving…" : "Save rule"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
