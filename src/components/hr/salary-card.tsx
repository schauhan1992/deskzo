"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IndianRupee } from "lucide-react";
import type { salaryHistory } from "@/actions/payroll";
import { saveSalaryStructure, suggestFromCtc } from "@/actions/payroll";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/bulk-select";
import { formatCurrency, formatDate } from "@/lib/utils";
import { annualCtcOf, monthlyGross } from "@/lib/hr/payroll";

type Structure = Awaited<ReturnType<typeof salaryHistory>>[number];

const num = (v: unknown) => Number(v ?? 0);

/**
 * What someone is paid, as a dated series.
 *
 * Nothing is ever edited — a raise is a new row with a later start date — so that a payslip issued
 * in March is still reproducible after an April increase.
 */
export function SalaryCard({
  userId,
  name,
  structures,
  canEdit,
}: {
  userId: string;
  name: string;
  structures: Structure[];
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = structures[0];

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>Salary</span>
        {canEdit && (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            <IndianRupee className="mr-1 h-3.5 w-3.5" />
            {current ? "Revise" : "Set salary"}
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-3 text-sm">
        {!current && <p className="text-subtle">No structure on file. Payroll will skip this person.</p>}

        {current && (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-muted">Monthly gross</span>
              <span className="font-medium text-text">
                {formatCurrency(
                  monthlyGross({
                    basic: num(current.basic),
                    hra: num(current.hra),
                    conveyance: num(current.conveyance),
                    medical: num(current.medical),
                    specialAllowance: num(current.specialAllowance),
                    otherAllowance: num(current.otherAllowance),
                  }),
                )}
              </span>
            </div>
            <Row label="Basic" value={num(current.basic)} />
            <Row label="HRA" value={num(current.hra)} />
            {num(current.conveyance) > 0 && <Row label="Conveyance" value={num(current.conveyance)} />}
            {num(current.medical) > 0 && <Row label="Medical" value={num(current.medical)} />}
            <Row label="Special allowance" value={num(current.specialAllowance)} />
            {num(current.otherAllowance) > 0 && <Row label="Other" value={num(current.otherAllowance)} />}

            <div className="border-t border-line pt-2 text-xs text-subtle">
              Effective {formatDate(current.effectiveFrom)}
              {current.createdBy && ` · set by ${current.createdBy.name}`}
              <div className="mt-0.5">
                {current.pfApplicable ? "PF" : "no PF"} · {current.esiApplicable ? "ESI" : "no ESI"} ·{" "}
                {current.ptApplicable ? "PT" : "no PT"}
              </div>
            </div>

            {structures.length > 1 && (
              <details className="border-t border-line pt-2">
                <summary className="cursor-pointer text-xs text-muted">History ({structures.length - 1} earlier)</summary>
                <div className="mt-2 space-y-1">
                  {structures.slice(1).map((s) => (
                    <div key={s.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                      <span className="text-muted">{formatDate(s.effectiveFrom)}</span>
                      <span className="text-text">
                        {formatCurrency(
                          monthlyGross({
                            basic: num(s.basic),
                            hra: num(s.hra),
                            conveyance: num(s.conveyance),
                            medical: num(s.medical),
                            specialAllowance: num(s.specialAllowance),
                            otherAllowance: num(s.otherAllowance),
                          }),
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </CardContent>

      {open && <StructureDialog userId={userId} name={name} current={current} onClose={() => setOpen(false)} />}
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

function StructureDialog({
  userId,
  name,
  current,
  onClose,
}: {
  userId: string;
  name: string;
  current?: Structure;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ctc, setCtc] = useState("");

  const [form, setForm] = useState({
    effectiveFrom: new Date().toISOString().slice(0, 10),
    basic: current ? String(num(current.basic)) : "",
    hra: current ? String(num(current.hra)) : "",
    conveyance: current ? String(num(current.conveyance)) : "0",
    medical: current ? String(num(current.medical)) : "0",
    specialAllowance: current ? String(num(current.specialAllowance)) : "",
    otherAllowance: current ? String(num(current.otherAllowance)) : "0",
    pfApplicable: current?.pfApplicable ?? true,
    esiApplicable: current?.esiApplicable ?? true,
    ptApplicable: current?.ptApplicable ?? true,
    note: "",
  });

  const components = {
    basic: Number(form.basic) || 0,
    hra: Number(form.hra) || 0,
    conveyance: Number(form.conveyance) || 0,
    medical: Number(form.medical) || 0,
    specialAllowance: Number(form.specialAllowance) || 0,
    otherAllowance: Number(form.otherAllowance) || 0,
  };
  const gross = monthlyGross(components);
  const annual = annualCtcOf(components, { pfApplicable: form.pfApplicable, esiApplicable: form.esiApplicable });

  function fillFromCtc() {
    const value = Number(ctc);
    if (!value) return;
    startTransition(async () => {
      const suggestion = await suggestFromCtc(value);
      if (!suggestion) return;
      setForm((f) => ({
        ...f,
        basic: String(suggestion.basic),
        hra: String(suggestion.hra),
        specialAllowance: String(suggestion.specialAllowance),
      }));
    });
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await saveSalaryStructure({ userId, ...form, ...components });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <Dialog open onClose={onClose} title={`${current ? "Revise" : "Set"} ${name}'s salary`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-2 rounded-base border border-line bg-surface-sunken px-3 py-2">
          <div className="space-y-1">
            <Label htmlFor="ctc">Annual CTC</Label>
            <Input id="ctc" type="number" value={ctc} onChange={(e) => setCtc(e.target.value)} className="h-8 w-36" />
          </div>
          <Button size="sm" variant="secondary" disabled={pending || !ctc} onClick={fillFromCtc}>
            Split it
          </Button>
          <p className="text-xs text-subtle">
            Basic at 40%, HRA at half of basic — a starting point, not a rule. Edit anything below.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="effectiveFrom">Effective from</Label>
          <Input id="effectiveFrom" type="date" value={form.effectiveFrom} onChange={set("effectiveFrom")} />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {(
            [
              ["basic", "Basic"],
              ["hra", "HRA"],
              ["conveyance", "Conveyance"],
              ["medical", "Medical"],
              ["specialAllowance", "Special allowance"],
              ["otherAllowance", "Other"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={key}>{label}</Label>
              <Input id={key} type="number" value={form[key] as string} onChange={set(key)} />
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
              <Checkbox
                checked={form[key] as boolean}
                onChange={() => setForm((f) => ({ ...f, [key]: !f[key] }))}
                aria-label={label}
              />
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
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button disabled={pending || gross <= 0} onClick={submit}>
            {pending ? "Saving…" : "Save structure"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
