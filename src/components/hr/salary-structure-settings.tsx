"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteSalaryComponent, saveSalaryComponent, saveSplitRules } from "@/actions/payroll";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/bulk-select";
import { cn, formatCurrency } from "@/lib/utils";
import { splitCtc, type SplitRules } from "@/lib/hr/salary-split";

type Component = { id: string; name: string; mode: "FIXED" | "PERCENT_OF_BASIC"; value: number; active: boolean };
type Message = { ok: boolean; text: string } | null;

/** The split rules, with a worked example, and the company's own components. */
export function SalaryStructureSettings({ rules, components }: { rules: SplitRules; components: Component[] }) {
  return (
    <div className="space-y-6">
      <RulesForm rules={rules} components={components} />
      <ComponentsCard components={components} />
    </div>
  );
}

function RulesForm({ rules, components }: { rules: SplitRules; components: Component[] }) {
  const router = useRouter();
  const [form, setForm] = useState({
    basicPercent: String(rules.basicPercent),
    hraPercent: String(rules.hraPercent),
    conveyance: String(rules.conveyance),
    medical: String(rules.medical),
  });
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message>(null);

  const typed: SplitRules = {
    basicPercent: Number(form.basicPercent) || 0,
    hraPercent: Number(form.hraPercent) || 0,
    conveyance: Number(form.conveyance) || 0,
    medical: Number(form.medical) || 0,
  };
  // A worked example, so the effect of a percentage is seen before it's saved.
  const example = splitCtc(
    600000,
    typed,
    components.filter((c) => c.active),
    { pfApplicable: true, esiApplicable: true },
  ).components;
  const changed = (Object.keys(form) as (keyof typeof form)[]).some((k) => Number(form[k]) !== rules[k]);

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveSplitRules(typed);
      if (!result.ok) {
        setMessage({ ok: false, text: result.error });
        return;
      }
      setMessage({ ok: true, text: "Saved. Salaries set from a CTC are split this way from now on." });
      router.refresh();
    });
  }

  const fields = [
    ["basicPercent", "Basic (% of the CTC)"],
    ["hraPercent", "HRA (% of basic)"],
    ["conveyance", "Conveyance (₹ a month)"],
    ["medical", "Medical (₹ a month)"],
  ] as const;

  return (
    <Card className="max-w-3xl p-5">
      <h2 className="text-sm font-medium text-text">Splitting a CTC</h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {fields.map(([key, label]) => (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={`rule-${key}`}>{label}</Label>
            <Input id={`rule-${key}`} type="number" step="any" min={0} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-base border border-line bg-surface-sunken px-3 py-2.5 text-xs text-muted">
        <span className="font-medium text-text">A CTC of ₹6,00,000 comes out as</span> basic {formatCurrency(example.basic)}, HRA {formatCurrency(example.hra)}
        {example.conveyance > 0 && `, conveyance ${formatCurrency(example.conveyance)}`}
        {example.medical > 0 && `, medical ${formatCurrency(example.medical)}`}
        {(example.custom ?? []).map((l) => `, ${l.name} ${formatCurrency(l.amount)}`).join("")} and special allowance {formatCurrency(example.specialAllowance)} a month —
        with PF and ESI on, it costs exactly the CTC.
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} disabled={pending || !changed}>
          Save
        </Button>
        {message && <span className={cn("text-sm", message.ok ? "text-success" : "text-danger")}>{message.text}</span>}
      </div>
    </Card>
  );
}

function ComponentsCard({ components }: { components: Component[] }) {
  return (
    <Card className="max-w-3xl p-5">
      <h2 className="text-sm font-medium text-text">Your own components</h2>
      <p className="mt-1 text-xs text-muted">
        Earnings besides the built-in basic, HRA, conveyance, medical and allowances — a food allowance, a shift allowance. Each is offered on every salary
        and put in when a CTC is split, at a fixed amount or a percentage of basic. They count towards gross pay, ESI and professional tax, and show on the
        payslip by name. Removing one here doesn&apos;t change anyone&apos;s salary that already has it.
      </p>
      <div className="mt-4 space-y-2">
        {components.map((c) => (
          <ComponentRow key={c.id} component={c} />
        ))}
        <ComponentRow />
      </div>
    </Card>
  );
}

function ComponentRow({ component }: { component?: Component }) {
  const router = useRouter();
  const blank = { name: "", mode: "FIXED" as Component["mode"], value: "0", active: true };
  const [form, setForm] = useState(component ? { name: component.name, mode: component.mode, value: String(component.value), active: component.active } : blank);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message>(null);
  const changed = !component || form.name !== component.name || form.mode !== component.mode || Number(form.value) !== component.value || form.active !== component.active;

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveSalaryComponent({ id: component?.id, name: form.name, mode: form.mode, value: Number(form.value) || 0, active: form.active });
      if (!result.ok) {
        setMessage({ ok: false, text: result.error });
        return;
      }
      if (!component) setForm(blank);
      setMessage(component ? { ok: true, text: "Saved." } : null);
      router.refresh();
    });
  }

  function remove() {
    if (!component || !window.confirm(`Remove ${component.name}? Salaries that have it keep it.`)) return;
    startTransition(async () => {
      const result = await deleteSalaryComponent(component.id);
      if (!result.ok) setMessage({ ok: false, text: result.error });
      else router.refresh();
    });
  }

  const label = component?.name || "new component";
  return (
    <div className={cn("rounded-base border border-line px-3 py-2", !component && "border-dashed")}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={component ? `Name of ${label}` : "New component's name"}
          value={form.name}
          placeholder={component ? undefined : "Add one — Food allowance"}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="h-9 min-w-[10rem] flex-1"
        />
        <Select aria-label={`How ${label} is worked out`} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as Component["mode"] })} className="h-9 w-44">
          <option value="FIXED">₹ a month</option>
          <option value="PERCENT_OF_BASIC">% of basic</option>
        </Select>
        <Input aria-label={`Amount of ${label}`} type="number" step="any" min={0} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} className="h-9 w-28" />
        {component && (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <Checkbox checked={form.active} onChange={() => setForm({ ...form, active: !form.active })} aria-label={`Offer ${label}`} />
            Offered
          </label>
        )}
        <Button size="sm" variant={component ? "secondary" : "primary"} onClick={save} disabled={pending || !changed || !form.name.trim()}>
          {component ? "Save" : "Add"}
        </Button>
        {component && (
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            aria-label={`Remove ${label}`}
            className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-surface-sunken hover:text-danger"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
      {message && <p className={cn("mt-1 text-xs", message.ok ? "text-success" : "text-danger")}>{message.text}</p>}
    </div>
  );
}
