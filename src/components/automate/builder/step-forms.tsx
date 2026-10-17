"use client";

import { Input, Label, Select, Textarea } from "@/components/ui/input";
import type { ApprovalStep, Definition, DelayStep, Duration, ForEachStep, ParallelStep, Schedule, Step, WaitStep } from "@/lib/automate/definition";
import type { Catalog, FieldSpec } from "@/lib/automate/catalog";
import type { DefinitionProblem } from "@/lib/automate/validate";
import { DataPicker, FieldInput, FilterEditor } from "@/components/automate/builder/fields";
import type { DataRef } from "@/components/automate/builder/tree";
import { WebhookPanel } from "@/components/automate/builder/webhook-panel";
import type { WebhookView } from "@/lib/automate/webhooks";

/**
 * The form for whatever is selected in the builder (Deskzo Automate, Phase 3): what starts the
 * workflow, or one step — its inputs from the action's spec, a condition's or branch's rules, a
 * delay's wait, a stop's outcome — with the problems publishing would raise shown beside the field.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const KIND_NAMES: Record<Step["type"], string> = {
  action: "Step",
  condition: "Only carry on if",
  branch: "Branch",
  delay: "Wait",
  stop: "End the run",
  transform: "Set values",
  approval: "Ask for approval",
  waitForEvent: "Wait for something to happen",
  forEach: "For each item",
  parallel: "At the same time",
};

/** A length of time in days and hours — an approval's or a wait's limit. */
function DurationFields({ value, onChange, label, hint }: { value: Duration; onChange: (d: Duration) => void; label: string; hint: string }) {
  const set = (key: "days" | "hours", raw: string) => {
    const next: Duration = { ...value };
    if (raw === "" || Number(raw) <= 0) delete next[key];
    else next[key] = Math.floor(Number(raw));
    onChange(next);
  };
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="flex items-center gap-2 text-sm">
        <Input type="number" min={0} max={30} value={value.days ?? ""} onChange={(e) => set("days", e.target.value)} className="w-20" aria-label="Days" /> days
        <Input type="number" min={0} max={23} value={value.hours ?? ""} onChange={(e) => set("hours", e.target.value)} className="w-20" aria-label="Hours" /> hours
      </div>
      <p className="text-xs text-subtle">{hint}</p>
    </div>
  );
}

const OWNER_OPTION = [{ value: "owner", label: "The workflow's owner" }];

function ApprovalFields({ step, onChange, catalog, data }: { step: ApprovalStep; onChange: (s: Step) => void; catalog: Catalog; data: DataRef[] }) {
  const people = step.approvers.filter((a) => !/\{\{/.test(a));
  const fromData = step.approvers.filter((a) => /\{\{/.test(a));
  const field = (name: string, label: string, kind: FieldSpec["kind"], extra: Partial<FieldSpec> = {}): FieldSpec => ({ name, label, kind, required: false, ...extra });
  return (
    <div className="space-y-3">
      <FieldInput field={field("title", "What to approve", "text", { required: true, hint: "The line approvers see: “Discount of {{trigger.lead.value}} for {{trigger.company.name}}”." })} value={step.title} catalog={catalog} data={data} onChange={(v) => onChange({ ...step, title: String(v ?? "") })} />
      <FieldInput field={field("message", "More for them to read", "longText")} value={step.message} catalog={catalog} data={data} onChange={(v) => onChange({ ...step, ...(v ? { message: String(v) } : { message: undefined }) })} />
      <div className="space-y-1">
        <Label>Who approves</Label>
        <FieldInput field={field("approvers", "People", "people", { special: OWNER_OPTION })} value={people} catalog={catalog} data={data} onChange={(v) => onChange({ ...step, approvers: [...(Array.isArray(v) ? v.map(String) : []), ...fromData] })} />
        {fromData.map((ref) => (
          <p key={ref} className="flex items-center justify-between gap-2 text-xs text-muted">
            <span>Whoever the data names: {data.find((d) => `{{${d.ref}}}` === ref)?.label ?? ref}</span>
            <button type="button" className="text-danger hover:underline" onClick={() => onChange({ ...step, approvers: step.approvers.filter((a) => a !== ref) })}>
              Remove
            </button>
          </p>
        ))}
        <DataPicker data={data} onPick={(r) => onChange({ ...step, approvers: [...step.approvers, `{{${r}}}`] })} label="A person from the data" />
        <Select value={step.role ?? ""} onChange={(e) => onChange({ ...step, ...(e.target.value ? { role: e.target.value } : { role: undefined }) })}>
          <option value="">And no role</option>
          {catalog.roles.map((r) => (
            <option key={r.key} value={r.key}>
              Or anybody who is a {r.name}
            </option>
          ))}
        </Select>
        <p className="text-xs text-subtle">The first of them to decide does, in their Approvals. Nobody else may.</p>
      </div>
      <DurationFields value={step.timeout} onChange={(timeout) => onChange({ ...step, timeout })} label="Wait for a decision" hint="At most 30 days." />
      <div className="space-y-1">
        <Label>If nobody decides by then</Label>
        <Select value={step.onTimeout} onChange={(e) => onChange({ ...step, onTimeout: e.target.value as ApprovalStep["onTimeout"] })}>
          <option value="rejected">Take it as rejected</option>
          <option value="approved">Take it as approved</option>
        </Select>
      </div>
      <p className="text-xs text-subtle">Its decision is there for the steps after: approved or rejected, who, and their comment.</p>
    </div>
  );
}

function WaitFields({ step, onChange, catalog, data }: { step: WaitStep; onChange: (s: Step) => void; catalog: Catalog; data: DataRef[] }) {
  const events = catalog.triggers.filter((t) => t.event && t.type !== "webhook");
  const fields = (catalog.triggers.find((t) => t.type === step.event)?.paths ?? []).map((p) => ({ ref: `event.${p.ref.slice("trigger.".length)}`, label: p.label, group: "The event" }));
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Wait until</Label>
        <Select value={step.event} onChange={(e) => onChange({ ...step, event: e.target.value, filter: undefined })}>
          {events.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label>And only when</Label>
        <FilterEditor filter={step.filter} onChange={(f) => onChange({ ...step, ...(f ? { filter: f } : { filter: undefined }) })} data={fields} valueData={data} emptyText="No rules: the first one of these to happen will do." />
        <p className="text-xs text-subtle">Say which one: “the event&apos;s task id is the task made earlier”, from the data.</p>
      </div>
      <DurationFields value={step.timeout} onChange={(timeout) => onChange({ ...step, timeout })} label="Wait at most" hint="At most 30 days." />
      <div className="space-y-1">
        <Label>If it doesn&apos;t happen by then</Label>
        <Select value={step.onTimeout} onChange={(e) => onChange({ ...step, onTimeout: e.target.value as WaitStep["onTimeout"] })}>
          <option value="continue">Carry on anyway</option>
          <option value="stop">End the run here</option>
        </Select>
      </div>
    </div>
  );
}

function ForEachFields({ step, onChange, data }: { step: ForEachStep; onChange: (s: Step) => void; data: DataRef[] }) {
  const typed = Array.isArray(step.items);
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>The list</Label>
        <Select value={typed ? "typed" : "data"} onChange={(e) => onChange({ ...step, items: e.target.value === "typed" ? [] : "" })}>
          <option value="typed">Items I type in</option>
          <option value="data">A list from the data</option>
        </Select>
      </div>
      {typed ? (
        <div className="space-y-1">
          <Textarea
            rows={5}
            value={(step.items as unknown[]).map(String).join("\n")}
            placeholder={"Laptop and email account\nID card\nWelcome kit"}
            onChange={(e) => onChange({ ...step, items: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 100) })}
          />
          <p className="text-xs text-subtle">One a line, up to 100.</p>
        </div>
      ) : (
        <div className="space-y-1">
          <Input value={typeof step.items === "string" ? step.items : ""} readOnly placeholder="Choose a list from the data" />
          <DataPicker data={data} onPick={(r) => onChange({ ...step, items: `{{${r}}}` })} label="Choose the list" />
        </div>
      )}
      <p className="text-xs text-subtle">The steps inside run once per item, in turn; they read the item as “This time round › the item”.</p>
    </div>
  );
}

function ParallelFields({ step, onChange }: { step: ParallelStep; onChange: (s: Step) => void }) {
  return (
    <div className="space-y-2">
      {step.paths.map((path, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input value={path.name} maxLength={80} onChange={(e) => onChange({ ...step, paths: step.paths.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)) })} />
          {step.paths.length > 2 && (
            <button type="button" className="text-xs text-danger hover:underline" onClick={() => onChange({ ...step, paths: step.paths.filter((_, j) => j !== i) })}>
              Remove
            </button>
          )}
        </div>
      ))}
      {step.paths.length < 3 && (
        <button type="button" className="text-xs font-medium text-brand hover:underline" onClick={() => onChange({ ...step, paths: [...step.paths, { name: `Path ${step.paths.length + 1}`, steps: [] }] })}>
          Add a path
        </button>
      )}
      <p className="text-xs text-subtle">The paths run at the same time — one waiting for an approval doesn&apos;t hold up the others — and the run carries on when every one is done.</p>
    </div>
  );
}

function Problems({ problems }: { problems: DefinitionProblem[] }) {
  if (!problems.length) return null;
  return (
    <ul className="space-y-1 rounded-base bg-danger-bg px-3 py-2 text-xs text-danger">
      {problems.map((p, i) => (
        <li key={i}>
          {p.field ? <strong>{p.field}: </strong> : null}
          {p.message}
        </li>
      ))}
    </ul>
  );
}

function ScheduleFields({ schedule, onChange }: { schedule: Schedule | undefined; onChange: (s: Schedule) => void }) {
  const s: Schedule = schedule ?? { every: "day", at: "09:00" };
  const days = s.days ?? [];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label>Every</Label>
          <Select value={s.every} onChange={(e) => onChange({ every: e.target.value as Schedule["every"], ...(e.target.value === "hour" ? { minute: 0 } : { at: s.at ?? "09:00" }) })}>
            <option value="hour">Hour</option>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </Select>
        </div>
        {s.every === "hour" ? (
          <div className="space-y-1">
            <Label>Minutes past</Label>
            <Input type="number" min={0} max={59} value={s.minute ?? 0} onChange={(e) => onChange({ ...s, minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })} />
          </div>
        ) : (
          <div className="space-y-1">
            <Label>At</Label>
            <Input type="time" value={s.at ?? "09:00"} onChange={(e) => onChange({ ...s, at: e.target.value })} />
          </div>
        )}
      </div>
      {s.every === "week" && (
        <div className="space-y-1">
          <Label>On</Label>
          <Select value={s.weekday ?? 1} onChange={(e) => onChange({ ...s, weekday: Number(e.target.value) })}>
            {DAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </Select>
        </div>
      )}
      {s.every === "month" && (
        <div className="space-y-1">
          <Label>On day</Label>
          <Input type="number" min={1} max={28} value={s.dayOfMonth ?? 1} onChange={(e) => onChange({ ...s, dayOfMonth: Math.max(1, Math.min(28, Number(e.target.value) || 1)) })} />
        </div>
      )}
      {(s.every === "hour" || s.every === "day") && (
        <div className="space-y-1">
          <Label>Only on</Label>
          <div className="flex flex-wrap gap-2 text-sm">
            {DAYS.map((d, i) => (
              <label key={d} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={days.length === 0 || days.includes(i)}
                  onChange={(e) => {
                    const all = days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : days;
                    const next = e.target.checked ? [...new Set([...all, i])].sort() : all.filter((x) => x !== i);
                    const { days: _, ...rest } = s;
                    void _;
                    onChange(next.length === 7 || next.length === 0 ? rest : { ...rest, days: next });
                  }}
                />
                {d}
              </label>
            ))}
          </div>
        </div>
      )}
      <p className="text-xs text-subtle">On the workspace&apos;s clock.</p>
    </div>
  );
}

export function TriggerForm({
  draft,
  onChange,
  catalog,
  data,
  problems,
  workflowId,
  webhook,
  demo = false,
}: {
  draft: Definition;
  onChange: (d: Definition) => void;
  catalog: Catalog;
  data: DataRef[];
  problems: DefinitionProblem[];
  workflowId: string;
  webhook: WebhookView | null;
  demo?: boolean;
}) {
  const groups = [...new Set(catalog.triggers.map((t) => t.group))];
  const trigger = draft.trigger;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label>Starts when</Label>
        <Select
          value={trigger.type}
          onChange={(e) => {
            const type = e.target.value;
            onChange({ ...draft, trigger: type === "schedule" ? { type, schedule: { every: "day", at: "09:00" } } : { type } });
          }}
        >
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {catalog.triggers
                .filter((t) => t.group === g)
                .map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
      </div>
      {trigger.type === "webhook" && <WebhookPanel workflowId={workflowId} initial={webhook} demo={demo} />}
      {trigger.type === "schedule" && <ScheduleFields schedule={trigger.schedule} onChange={(schedule) => onChange({ ...draft, trigger: { ...trigger, schedule } })} />}
      {trigger.type !== "schedule" && trigger.type !== "manual" && (
        <div className="space-y-1">
          <Label>Only when</Label>
          <FilterEditor filter={trigger.filter} onChange={(filter) => onChange({ ...draft, trigger: { ...trigger, ...(filter ? { filter } : { filter: undefined }) } })} data={data} emptyText="Every time. Add a rule to narrow it." />
        </div>
      )}
      <div className="space-y-1">
        <Label>When a step fails</Label>
        <Select value={draft.settings?.onError ?? "stop"} onChange={(e) => onChange({ ...draft, settings: e.target.value === "continue" ? { onError: "continue" } : undefined })}>
          <option value="stop">Stop the run there</option>
          <option value="continue">Note it and carry on with the next step</option>
        </Select>
      </div>
      <Problems problems={problems} />
    </div>
  );
}

function DelayFields({ step, onChange, data }: { step: DelayStep; onChange: (s: Step) => void; data: DataRef[] }) {
  const mode = step.on ? "on" : step.until ? "until" : "for";
  const base = { id: step.id, ...(step.name ? { name: step.name } : {}), ...(step.note ? { note: step.note } : {}), type: "delay" as const };
  return (
    <div className="space-y-3">
      <Select
        value={mode}
        onChange={(e) =>
          onChange(e.target.value === "until" ? { ...base, until: { at: "09:00" } } : e.target.value === "on" ? { ...base, on: { value: "", before: { hours: 24 } } } : { ...base, for: { hours: 1 } })
        }
      >
        <option value="for">For a while</option>
        <option value="until">Until a time of day</option>
        <option value="on">Until a time in the data</option>
      </Select>
      {mode === "for" && (
        <div className="grid grid-cols-3 gap-2">
          {(["days", "hours", "minutes"] as const).map((unit) => (
            <div key={unit} className="space-y-1">
              <Label className="capitalize">{unit}</Label>
              <Input type="number" min={0} value={step.for?.[unit] ?? ""} onChange={(e) => onChange({ ...base, for: { ...step.for, [unit]: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) } })} />
            </div>
          ))}
        </div>
      )}
      {mode === "until" && (
        <div className="space-y-1">
          <Label>The next</Label>
          <Input type="time" value={step.until?.at ?? "09:00"} onChange={(e) => onChange({ ...base, until: { ...step.until, at: e.target.value } })} />
          <p className="text-xs text-subtle">The next time the clock reads this, on the workspace&apos;s clock.</p>
        </div>
      )}
      {mode === "on" && (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label>The time</Label>
            <div className="flex items-center gap-1">
              <Input value={step.on?.value ?? ""} onChange={(e) => onChange({ ...base, on: { ...step.on, value: e.target.value } })} placeholder="Pick it from the data" />
              <DataPicker data={data} onPick={(r) => onChange({ ...base, on: { ...step.on, value: `{{${r}}}` } })} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Hours before it</Label>
            <Input type="number" min={0} value={step.on?.before?.hours ?? ""} onChange={(e) => onChange({ ...base, on: { value: step.on?.value ?? "", ...(e.target.value ? { before: { hours: Math.max(0, Number(e.target.value)) } } : {}) } })} />
          </div>
          <p className="text-xs text-subtle">A time already gone waits for nothing.</p>
        </div>
      )}
    </div>
  );
}

export function StepForm({ step, onChange, catalog, data, problems }: { step: Step; onChange: (s: Step) => void; catalog: Catalog; data: DataRef[]; problems: DefinitionProblem[] }) {
  const action = step.type === "action" ? catalog.actions.find((a) => a.key === step.action) : null;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label>Name</Label>
        <Input
          value={step.name ?? ""}
          placeholder={action?.label ?? KIND_NAMES[step.type]}
          maxLength={80}
          onChange={(e) => {
            const { name: _, ...rest } = step;
            void _;
            onChange((e.target.value ? { ...rest, name: e.target.value } : rest) as Step);
          }}
        />
        <p className="text-xs text-subtle">
          Its id, for the steps after: <code>{step.id}</code>
        </p>
      </div>
      <div className="space-y-1">
        <Label>What it is for</Label>
        <Textarea
          rows={2}
          value={step.note ?? ""}
          maxLength={300}
          placeholder="One line, for whoever reads this workflow next."
          onChange={(e) => {
            const { note: _, ...rest } = step;
            void _;
            onChange((e.target.value ? { ...rest, note: e.target.value } : rest) as Step);
          }}
        />
      </div>

      {step.type === "action" &&
        (action ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">{action.description}</p>
            {!action.available && <p className="rounded-base bg-warning-bg px-3 py-2 text-xs text-warning">{action.why}</p>}
            {action.fields
              // A field that only applies to one choice of another — "Contact" when sending to a contact.
              .filter((field) => !field.showWhen || Object.entries(field.showWhen).every(([other, values]) => values.includes(String(step.input[other] ?? action.fields.find((f) => f.name === other)?.default ?? ""))))
              .map((field) => (
                <FieldInput
                  key={field.name}
                  field={field}
                  value={step.input[field.name]}
                  catalog={catalog}
                  data={data}
                  onChange={(v) => {
                    const input = { ...step.input };
                    if (v === undefined) delete input[field.name];
                    else input[field.name] = v;
                    onChange({ ...step, input });
                  }}
                />
              ))}
          </div>
        ) : (
          <p className="text-sm text-danger">&ldquo;{step.action}&rdquo; isn&apos;t an action this workspace can take.</p>
        ))}

      {step.type === "condition" && (
        <div className="space-y-1">
          <Label>Carry on only if</Label>
          <FilterEditor filter={step.if} onChange={(f) => onChange({ ...step, if: f ?? { all: [] } })} data={data} emptyText="No rules yet: it always carries on." />
          <p className="text-xs text-subtle">When the rules don&apos;t hold, the run ends here, as a success.</p>
        </div>
      )}

      {step.type === "branch" && (
        <div className="space-y-3">
          {step.paths.map((path, i) => (
            <div key={i} className="space-y-2 rounded-base border border-line p-3">
              <div className="flex items-center gap-2">
                <Input value={path.name} maxLength={80} onChange={(e) => onChange({ ...step, paths: step.paths.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)) })} />
                {step.paths.length > 1 && (
                  <button type="button" className="text-xs text-danger hover:underline" onClick={() => onChange({ ...step, paths: step.paths.filter((_, j) => j !== i) })}>
                    Remove
                  </button>
                )}
              </div>
              <FilterEditor filter={path.if} onChange={(f) => onChange({ ...step, paths: step.paths.map((p, j) => (j === i ? { ...p, if: f ?? { all: [] } } : p)) })} data={data} emptyText="No rules: this path always matches." />
            </div>
          ))}
          <div className="flex flex-wrap gap-3 text-xs">
            {step.paths.length + (step.else ? 1 : 0) < 5 && (
              <button type="button" className="font-medium text-brand hover:underline" onClick={() => onChange({ ...step, paths: [...step.paths, { name: `Path ${step.paths.length + 1}`, if: { all: [] }, steps: [] }] })}>
                Add a path
              </button>
            )}
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={!!step.else}
                onChange={(e) => {
                  const { else: _, ...rest } = step;
                  void _;
                  onChange(e.target.checked ? { ...rest, else: [] } : rest);
                }}
              />
              Otherwise, another path
            </label>
          </div>
          <p className="text-xs text-subtle">The first path whose rules hold is taken; then the run carries on after the branch.</p>
        </div>
      )}

      {step.type === "delay" && <DelayFields step={step} onChange={onChange} data={data} />}
      {step.type === "approval" && <ApprovalFields step={step} onChange={onChange} catalog={catalog} data={data} />}
      {step.type === "waitForEvent" && <WaitFields step={step} onChange={onChange} catalog={catalog} data={data} />}
      {step.type === "forEach" && <ForEachFields step={step} onChange={onChange} data={data} />}
      {step.type === "parallel" && <ParallelFields step={step} onChange={onChange} />}

      {step.type === "stop" && (
        <div className="space-y-2">
          <Select value={step.outcome} onChange={(e) => onChange({ ...step, outcome: e.target.value as "succeeded" | "failed" })}>
            <option value="succeeded">End the run, as a success</option>
            <option value="failed">End the run, as a failure</option>
          </Select>
          <Textarea value={step.message ?? ""} maxLength={300} rows={2} placeholder="Why — shown on the run" onChange={(e) => onChange({ ...step, ...(e.target.value ? { message: e.target.value } : { message: undefined }) })} />
        </div>
      )}

      {step.type === "transform" && <p className="text-sm text-muted">Sets values for the steps after. Edited in the workflow&apos;s JSON for now.</p>}

      <Problems problems={problems} />
    </div>
  );
}
