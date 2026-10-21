"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IndianRupee, Pencil, X } from "lucide-react";
import type { salaryHistory, salarySplitSetup } from "@/actions/payroll";
import { saveSalaryStructure, updateSalaryStructure } from "@/actions/payroll";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/bulk-select";
import { cn, formatCurrency } from "@/lib/utils";
import { annualCtcOf, monthlyGross, type SalaryComponents, type SalaryCustomLine } from "@/lib/hr/payroll";
import {
  DEFAULT_SPLIT_RULES,
  balanceToCtc,
  componentsOfStructure,
  ctcOfStructure,
  revisedCtc,
  revisionWords,
  scaleToCtc,
  splitCtc,
  type RevisionBasis,
} from "@/lib/hr/salary-split";
import { formatCalendarDay, indiaClock } from "@/lib/time/zone";

type Structure = Awaited<ReturnType<typeof salaryHistory>>[number];
type Setup = NonNullable<Awaited<ReturnType<typeof salarySplitSetup>>>;

const num = (v: unknown) => Number(v ?? 0);

/**
 * What someone is paid, as a dated series.
 *
 * A raise is a new row with a later start date, so that a payslip issued in March is still reproducible
 * after an April increase. The one somebody is on can be corrected in place until a locked month has
 * paid from it (owner, 21 Oct 2026).
 */
export function SalaryCard({
  userId,
  name,
  structures,
  canEdit,
  setup = null,
}: {
  userId: string;
  name: string;
  structures: Structure[];
  canEdit: boolean;
  /** How a CTC is split and the company's own components — for whoever sets salaries. */
  setup?: Setup | null;
}) {
  const [dialog, setDialog] = useState<null | "new" | "revise" | "edit">(null);
  const current = structures[0];
  const components = current ? componentsOfStructure(current) : null;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>Salary</span>
        {canEdit && (
          <span className="flex flex-wrap gap-2">
            {current?.editable && (
              <Button size="sm" variant="ghost" onClick={() => setDialog("edit")} title="Correct it — no payroll has been locked from it yet">
                <Pencil className="mr-1 h-3.5 w-3.5" />
                Edit
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setDialog(current ? "revise" : "new")}>
              <IndianRupee className="mr-1 h-3.5 w-3.5" />
              {current ? "Revise" : "Set salary"}
            </Button>
          </span>
        )}
      </CardHeader>

      <CardContent className="space-y-3 text-sm">
        {!current && <p className="text-subtle">No structure on file. Payroll will skip this person.</p>}

        {current && components && (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-muted">Monthly gross</span>
              <span className="font-medium text-text">{formatCurrency(monthlyGross(components))}</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-muted">Annual CTC</span>
              <span className="text-text">{formatCurrency(ctcOfStructure(current))}</span>
            </div>
            <div className="space-y-1 border-t border-line pt-2">
              <Row label="Basic" value={components.basic} />
              <Row label="HRA" value={components.hra} />
              {components.conveyance > 0 && <Row label="Conveyance" value={components.conveyance} />}
              {components.medical > 0 && <Row label="Medical" value={components.medical} />}
              {(components.custom ?? []).map((line) => (
                <Row key={line.name} label={line.name} value={line.amount} />
              ))}
              <Row label="Special allowance" value={components.specialAllowance} />
              {components.otherAllowance > 0 && <Row label="Other" value={components.otherAllowance} />}
            </div>

            <div className="border-t border-line pt-2 text-xs text-subtle">
              Effective {formatCalendarDay(current.effectiveFrom)}
              {current.revisionBasis && current.revisionValue != null && (
                <> · revised {revisionWords(current.revisionBasis, num(current.revisionValue), structures[1] ? ctcOfStructure(structures[1]) : null)}</>
              )}
              {current.createdBy && ` · set by ${current.createdBy.name}`}
              <div className="mt-0.5">
                {current.pfApplicable ? "PF" : "no PF"} · {current.esiApplicable ? "ESI" : "no ESI"} · {current.ptApplicable ? "PT" : "no PT"}
              </div>
            </div>

            {structures.length > 1 && (
              <details className="border-t border-line pt-2">
                <summary className="cursor-pointer text-xs text-muted">History ({structures.length - 1} earlier)</summary>
                <div className="mt-2 space-y-1">
                  {structures.slice(1).map((s) => (
                    <div key={s.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                      <span className="text-muted">{formatCalendarDay(s.effectiveFrom)}</span>
                      <span className="text-text">
                        {formatCurrency(monthlyGross(componentsOfStructure(s)))} a month · {formatCurrency(ctcOfStructure(s))} CTC
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </CardContent>

      {dialog && (
        <StructureDialog
          userId={userId}
          name={name}
          mode={dialog}
          current={current}
          setup={setup}
          onClose={() => setDialog(null)}
        />
      )}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <span className="text-muted">{label}</span>
      <span className="text-text">{formatCurrency(value)}</span>
    </div>
  );
}

const FIXED = [
  ["basic", "Basic"],
  ["hra", "HRA"],
  ["conveyance", "Conveyance"],
  ["medical", "Medical"],
  ["otherAllowance", "Other allowance"],
] as const;
type FixedKey = (typeof FIXED)[number][0];
type Parts = Record<FixedKey | "specialAllowance", string>;
type CustomRow = { name: string; amount: string };

const asText = (v: number) => (v ? String(Math.round(v * 100) / 100) : "0");
const toParts = (c: SalaryComponents): Parts => ({
  basic: asText(c.basic),
  hra: asText(c.hra),
  conveyance: asText(c.conveyance),
  medical: asText(c.medical),
  otherAllowance: asText(c.otherAllowance),
  specialAllowance: asText(c.specialAllowance),
});
const toRows = (lines: readonly SalaryCustomLine[] | undefined): CustomRow[] => (lines ?? []).map((l) => ({ name: l.name, amount: asText(l.amount) }));

/**
 * Setting, revising or correcting a salary (owner, 21 Oct 2026). Type a CTC and it's split as you type —
 * the company's rules and its own components (Settings › People › Salary structure) — and every part
 * stays editable: with "Keep to the CTC" on, the special allowance takes up the difference. A revision
 * is given as a percentage, an amount a year or a new CTC, and keeps the person's breakup, scaled.
 */
function StructureDialog({
  userId,
  name,
  mode,
  current,
  setup,
  onClose,
}: {
  userId: string;
  name: string;
  mode: "new" | "revise" | "edit";
  current?: Structure;
  setup: Setup | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const rules = setup?.rules ?? DEFAULT_SPLIT_RULES;
  const defaults = setup?.components ?? [];

  const start = current ? componentsOfStructure(current) : null;
  const currentCtc = current ? ctcOfStructure(current) : 0;

  const [effectiveFrom, setEffectiveFrom] = useState(
    // Today on payroll's clock, which is India's (statutory) in every workspace; a correction keeps its day.
    mode === "edit" && current ? String(current.effectiveFrom).slice(0, 10) : indiaClock.today(),
  );
  const [flags, setFlags] = useState({
    pfApplicable: current?.pfApplicable ?? true,
    esiApplicable: current?.esiApplicable ?? true,
    ptApplicable: current?.ptApplicable ?? true,
  });
  const [parts, setParts] = useState<Parts>(start && mode !== "new" ? toParts(start) : { basic: "", hra: "", conveyance: "0", medical: "0", otherAllowance: "0", specialAllowance: "" });
  const [custom, setCustom] = useState<CustomRow[]>(start && mode !== "new" ? toRows(start.custom) : []);
  const [ctc, setCtc] = useState(mode === "edit" && current ? String(Math.round(num(current.annualCtc) || currentCtc)) : "");
  const [keepToCtc, setKeepToCtc] = useState(true);
  const [basis, setBasis] = useState<RevisionBasis>("PERCENT");
  const [raise, setRaise] = useState("");
  const [shape, setShape] = useState<"keep" | "rules">("keep");
  const [short, setShort] = useState(0);
  const [note, setNote] = useState("");

  const numbers = (p: Parts = parts, rows: CustomRow[] = custom): SalaryComponents => {
    const lines = rows.map((r) => ({ name: r.name.trim(), amount: Number(r.amount) || 0 })).filter((l) => l.name && l.amount > 0);
    return {
      basic: Number(p.basic) || 0,
      hra: Number(p.hra) || 0,
      conveyance: Number(p.conveyance) || 0,
      medical: Number(p.medical) || 0,
      specialAllowance: Number(p.specialAllowance) || 0,
      otherAllowance: Number(p.otherAllowance) || 0,
      ...(lines.length ? { custom: lines } : {}),
    };
  };
  const components = numbers();
  const gross = monthlyGross(components);
  const annual = annualCtcOf(components, flags);
  const target = Number(ctc) || 0;

  /** Puts a split or a balance on the form. */
  function show(result: { components: SalaryComponents; short: number }) {
    setParts(toParts(result.components));
    setCustom(toRows(result.components.custom));
    setShort(result.short);
  }

  /** The special allowance taking up the difference to the CTC, after any other part changed. */
  function rebalance(p: Parts, rows: CustomRow[], f = flags) {
    if (!keepToCtc || !target) {
      setParts(p);
      setCustom(rows);
      return;
    }
    const { specialAllowance: _special, ...rest } = numbers(p, rows);
    void _special;
    const result = balanceToCtc(rest, target, f);
    setParts({ ...p, specialAllowance: asText(result.components.specialAllowance) });
    setCustom(rows);
    setShort(result.short);
  }

  function typeCtc(value: string) {
    setCtc(value);
    const amount = Number(value) || 0;
    if (amount > 0) {
      setKeepToCtc(true);
      show(splitCtc(amount, rules, defaults, flags));
    }
  }

  function typeRaise(nextBasis: RevisionBasis, value: string, nextShape = shape) {
    setBasis(nextBasis);
    setRaise(value);
    setShape(nextShape);
    const amount = Number(value);
    if (!start || !Number.isFinite(amount) || value.trim() === "") return;
    const next = revisedCtc(currentCtc, nextBasis, amount);
    if (next <= 0) return;
    setCtc(String(next));
    setKeepToCtc(true);
    show(nextShape === "keep" ? scaleToCtc(start, currentCtc, next, flags) : splitCtc(next, rules, defaults, flags));
  }

  function setPart(key: FixedKey, value: string) {
    rebalance({ ...parts, [key]: value }, custom);
  }

  function setSpecial(value: string) {
    // Typing the special allowance itself means the CTC follows the parts, not the other way round.
    setKeepToCtc(false);
    setParts({ ...parts, specialAllowance: value });
  }

  function toggleFlag(key: keyof typeof flags) {
    const next = { ...flags, [key]: !flags[key] };
    setFlags(next);
    rebalance(parts, custom, next);
  }

  const offered = defaults.filter((d) => !custom.some((r) => r.name.trim().toLowerCase() === d.name.toLowerCase()));
  function addCustom(choice: string) {
    if (!choice) return;
    const known = defaults.find((d) => d.id === choice);
    const basic = Number(parts.basic) || 0;
    const amount = known ? (known.mode === "PERCENT_OF_BASIC" ? (basic * known.value) / 100 : known.value) : 0;
    rebalance(parts, [...custom, { name: known?.name ?? "", amount: asText(amount) }]);
  }

  function submit() {
    setError(null);
    const lines = custom.filter((r) => r.name.trim() || Number(r.amount) > 0);
    if (lines.some((r) => !r.name.trim())) {
      setError("Name every component you've added, or remove it.");
      return;
    }
    const payload = {
      userId,
      effectiveFrom,
      ...flags,
      basic: components.basic,
      hra: components.hra,
      conveyance: components.conveyance,
      medical: components.medical,
      specialAllowance: components.specialAllowance,
      otherAllowance: components.otherAllowance,
      customComponents: lines.map((r) => ({ name: r.name.trim(), amount: Number(r.amount) || 0 })),
      note,
      ...(target > 0 ? { annualCtc: target } : {}),
      ...(mode === "revise" && raise.trim() !== "" && Number.isFinite(Number(raise)) ? { revisionBasis: basis, revisionValue: Number(raise) } : {}),
    };
    startTransition(async () => {
      const result = mode === "edit" && current ? await updateSalaryStructure(current.id, payload) : await saveSalaryStructure(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  const title = mode === "revise" ? `Revise ${name}'s salary` : mode === "edit" ? `Correct ${name}'s salary` : `Set ${name}'s salary`;
  const offBy = target > 0 ? Math.round(annual - target) : 0;

  return (
    <Dialog open onClose={onClose} title={title} large>
      <div className="space-y-4">
        {mode === "revise" && start ? (
          <div className="space-y-2 rounded-base border border-line bg-surface-sunken px-3 py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="text-muted">Now</span>
              <span className="text-text">
                {formatCurrency(currentCtc)} CTC · {formatCurrency(monthlyGross(start))} a month
              </span>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="raise-basis">Revise by</Label>
                <Select id="raise-basis" value={basis} onChange={(e) => typeRaise(e.target.value as RevisionBasis, raise)} className="h-9 w-44">
                  <option value="PERCENT">A percentage</option>
                  <option value="AMOUNT">An amount a year (₹)</option>
                  <option value="CTC">A new CTC (₹)</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="raise-value">{basis === "PERCENT" ? "Increase (%)" : basis === "AMOUNT" ? "Increase a year (₹)" : "New annual CTC (₹)"}</Label>
                <Input id="raise-value" type="number" step="any" value={raise} onChange={(e) => typeRaise(basis, e.target.value)} className="h-9 w-40" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="raise-shape">The breakup</Label>
                <Select id="raise-shape" value={shape} onChange={(e) => typeRaise(basis, raise, e.target.value as "keep" | "rules")} className="h-9 w-56">
                  <option value="keep">Keep theirs, scaled up</option>
                  <option value="rules">Split again by the company&apos;s rules</option>
                </Select>
              </div>
            </div>
            {target > 0 && raise.trim() !== "" && (
              <p className="text-xs text-muted">
                New CTC {formatCurrency(target)} — {formatCurrency(target - currentCtc)} a year
                {currentCtc > 0 && ` (${Math.round(((target - currentCtc) / currentCtc) * 1000) / 10}%)`}. Every part below can still be changed.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-1 rounded-base border border-line bg-surface-sunken px-3 py-2.5">
            <Label htmlFor="ctc">Annual CTC (₹)</Label>
            <Input id="ctc" type="number" value={ctc} onChange={(e) => typeCtc(e.target.value)} className="h-9 w-48" placeholder="e.g. 600000" />
            <p className="text-xs text-subtle">
              Split as you type — basic {rules.basicPercent}% of the CTC, HRA {rules.hraPercent}% of basic
              {defaults.length > 0 && `, ${defaults.map((d) => d.name).join(", ")}`}, and the special allowance taking up the rest. Change any part
              below.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="effectiveFrom">Effective from</Label>
            <Input id="effectiveFrom" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-muted">
            <Checkbox checked={keepToCtc} onChange={() => setKeepToCtc((k) => !k)} aria-label="Keep to the CTC" disabled={!target} />
            Keep to the CTC — the special allowance takes up any change
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {FIXED.map(([key, label]) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`part-${key}`}>{label}</Label>
              <Input id={`part-${key}`} type="number" value={parts[key]} onChange={(e) => setPart(key, e.target.value)} />
            </div>
          ))}
          <div className="space-y-1.5">
            <Label htmlFor="part-specialAllowance">Special allowance</Label>
            <Input
              id="part-specialAllowance"
              type="number"
              value={parts.specialAllowance}
              onChange={(e) => setSpecial(e.target.value)}
              className={cn(keepToCtc && target > 0 && "bg-surface-sunken")}
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-text">The company&apos;s own components</span>
            <Select
              aria-label="Add a component"
              value=""
              onChange={(e) => addCustom(e.target.value)}
              className="h-8 w-56 text-xs"
            >
              <option value="">+ Add a component…</option>
              {offered.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
              <option value="other">Another, typed here</option>
            </Select>
          </div>
          {custom.length === 0 && <p className="text-xs text-subtle">None on this structure.</p>}
          {custom.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                aria-label={`Component ${i + 1} name`}
                value={row.name}
                placeholder="Food allowance"
                onChange={(e) => setCustom(custom.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                className="h-9 flex-1"
              />
              <Input
                aria-label={`Component ${i + 1} amount a month`}
                type="number"
                value={row.amount}
                onChange={(e) => rebalance(parts, custom.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)))}
                className="h-9 w-36"
              />
              <button
                type="button"
                aria-label={`Remove ${row.name || "this component"}`}
                onClick={() => rebalance(parts, custom.filter((_, j) => j !== i))}
                className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-surface-sunken hover:text-text"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-4 text-xs text-muted">
          {(
            [
              ["pfApplicable", "Provident fund"],
              ["esiApplicable", "ESI"],
              ["ptApplicable", "Professional tax"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2">
              <Checkbox checked={flags[key]} onChange={() => toggleFlag(key)} aria-label={label} />
              {label}
            </label>
          ))}
        </div>

        <div className="rounded-base border border-line px-3 py-2 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="text-muted">Monthly gross</span>
            <span className="font-medium text-text">{formatCurrency(gross)}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="text-muted">Annual cost to company</span>
            <span className="text-text">{formatCurrency(annual)}</span>
          </div>
          {short > 0 ? (
            <p className="mt-1 text-xs text-warning">
              The other parts already come to {formatCurrency(short)} a year more than the CTC, so there&apos;s no special allowance.
            </p>
          ) : (
            target > 0 &&
            Math.abs(offBy) >= 1 && (
              <p className="mt-1 text-xs text-warning">
                {formatCurrency(Math.abs(offBy))} a year {offBy > 0 ? "over" : "under"} the CTC of {formatCurrency(target)}.
              </p>
            )
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="structure-note">Note (optional)</Label>
          <Input id="structure-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Annual appraisal 2026" />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button disabled={pending || gross <= 0} onClick={submit}>
            {pending ? "Saving…" : mode === "edit" ? "Save correction" : "Save structure"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
