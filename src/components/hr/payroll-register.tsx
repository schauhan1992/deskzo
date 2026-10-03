"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Lock, Unlock, Wallet } from "lucide-react";
import type { getPayrollRun } from "@/actions/payroll";
import { adjustPayslip, setPayrollStatus } from "@/actions/payroll";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { formatCurrency } from "@/lib/utils";
import { monthLabel } from "@/lib/hr/calendar";
import { indiaClock } from "@/lib/time/zone";

type Run = NonNullable<Awaited<ReturnType<typeof getPayrollRun>>>;
type Slip = Run["payslips"][number];

const num = (v: unknown) => Number(v ?? 0);

/**
 * A month's payslips, and the controls that move it from draft to paid.
 *
 * Everything is editable while it is a draft and nothing is afterwards, which is the only rule that
 * matters here: a locked payslip is a statement that has been made to an employee and to the tax
 * authorities, and silently changing one would leave two different documents with the same number.
 */
export function PayrollRegister({
  run,
  totals,
  departments,
}: {
  run: Run;
  /** The whole month, so the header describes the run rather than whatever is filtered on screen. */
  totals: { count: number; gross: number; deductions: number; net: number; cost: number } | null;
  departments: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Slip | null>(null);

  const draft = run.status === "DRAFT";
  const shown = totals ?? { count: run.payslips.length, gross: 0, deductions: 0, net: 0, cost: 0 };
  const filtered = run.payslips.length !== shown.count;
  const withWarnings = run.payslips.filter((s) => s.note).length;

  function move(status: "LOCKED" | "PAID" | "DRAFT") {
    setError(null);
    startTransition(async () => {
      const result = await setPayrollStatus(run.id, status);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/people/payroll" className="text-sm text-muted hover:text-text">
            ← Payroll
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">{monthLabel(run.month, run.year)}</h1>
            <Badge tone={run.status === "PAID" ? "green" : run.status === "LOCKED" ? "blue" : "amber"}>
              {run.status}
            </Badge>
          </div>
          {run.lockedAt && (
            <p className="mt-0.5 text-xs text-subtle">
              {/* Payroll is India's (statutory): its dates are India's in every workspace. */}
              Locked {indiaClock.date(run.lockedAt)}
              {run.lockedBy && ` by ${run.lockedBy.name}`}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {draft && (
            <Button disabled={pending} onClick={() => move("LOCKED")}>
              <Lock className="mr-1.5 h-3.5 w-3.5" />
              Lock the month
            </Button>
          )}
          {run.status === "LOCKED" && (
            <>
              <Button variant="secondary" disabled={pending} onClick={() => move("DRAFT")}>
                <Unlock className="mr-1.5 h-3.5 w-3.5" />
                Unlock
              </Button>
              <Button disabled={pending} onClick={() => move("PAID")}>
                <Wallet className="mr-1.5 h-3.5 w-3.5" />
                Mark paid
              </Button>
            </>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Gross" value={formatCurrency(shown.gross)} hint={`${shown.count} payslip(s)`} />
        <Stat label="Deductions" value={formatCurrency(shown.deductions)} hint="PF, ESI, PT and tax" />
        <Stat label="Net to pay" value={formatCurrency(shown.net)} hint="what leaves the bank" />
        <Stat label="Cost to company" value={formatCurrency(shown.cost)} hint="gross plus employer share" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="search" placeholder="Name or employee code" className="w-56" />
        <SelectParamFilter
          paramName="departmentId"
          label="Team"
          options={departments.map((d) => ({ value: d.id, label: d.name }))}
        />
        <SelectParamFilter
          paramName="flag"
          label="Show"
          allLabel="Everyone"
          options={[
            { value: "lop", label: "Has loss of pay" },
            { value: "flagged", label: "Has a warning" },
          ]}
        />
        <SelectParamFilter
          paramName="sort"
          label="Sort"
          allLabel="By name"
          options={[
            { value: "net", label: "Highest net first" },
            { value: "lop", label: "Most loss of pay first" },
          ]}
        />
        {filtered && (
          <span className="text-xs text-muted">
            Showing {run.payslips.length} of {shown.count} — the totals above are for the whole month.
          </span>
        )}
      </div>

      {withWarnings > 0 && draft && (
        <Card className="border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {withWarnings} payslip(s) have something worth reading before you lock the month — hover the ⚠ on the row.
            </span>
          </span>
        </Card>
      )}

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">Employee</th>
                <th className="px-3 py-2.5 text-right">Paid days</th>
                <th className="px-3 py-2.5 text-right">Basic</th>
                <th className="px-3 py-2.5 text-right">Gross</th>
                <th className="px-3 py-2.5 text-right">PF</th>
                <th className="px-3 py-2.5 text-right">ESI</th>
                <th className="px-3 py-2.5 text-right">PT</th>
                <th className="px-3 py-2.5 text-right">Tax</th>
                <th className="px-3 py-2.5 text-right">Net</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {run.payslips.map((s) => (
                <tr key={s.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-4 py-2.5">
                    <Link href={`/people/${s.user.id}`} className="text-text hover:underline">
                      {s.user.name}
                    </Link>
                    <div className="text-[11px] text-subtle">
                      {s.user.employeeProfile?.employeeCode ?? s.user.employeeProfile?.designation ?? ""}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted">
                    {num(s.paidDays)}/{num(s.monthDays)}
                    {num(s.lopDays) > 0 && <span className="ml-1 text-danger">−{num(s.lopDays)}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted">{formatCurrency(num(s.basic))}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-text">{formatCurrency(num(s.grossEarnings))}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted">{formatCurrency(num(s.pfEmployee))}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted">{formatCurrency(num(s.esiEmployee))}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted">{formatCurrency(num(s.professionalTax))}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted">{formatCurrency(num(s.incomeTax))}</td>
                  <td className="px-3 py-2.5 text-right font-medium tabular-nums text-text">{formatCurrency(num(s.netPay))}</td>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-1.5">
                      {s.note && (
                        <span title={s.note} className="text-warning">
                          <AlertTriangle className="h-3.5 w-3.5" />
                        </span>
                      )}
                      {draft && (
                        <button
                          type="button"
                          onClick={() => setEditing(s)}
                          className="text-xs text-brand hover:underline"
                        >
                          Adjust
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
              {run.payslips.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-subtle">
                    Nothing calculated for this month yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {editing && <AdjustDialog key={editing.id} slip={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AdjustDialog({ slip, onClose }: { slip: Slip; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [incomeTax, setIncomeTax] = useState(String(num(slip.incomeTax)));
  const [otherDeduction, setOtherDeduction] = useState(String(num(slip.otherDeduction)));
  const [otherDeductionNote, setOtherDeductionNote] = useState(slip.otherDeductionNote ?? "");

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await adjustPayslip({
        id: slip.id,
        incomeTax: Number(incomeTax) || 0,
        otherDeduction: Number(otherDeduction) || 0,
        otherDeductionNote,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onClose={onClose} title={`${slip.user.name} — adjustments`}>
      <div className="space-y-4">
        <p className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-xs text-muted">
          PF, ESI and professional tax are computed from the rules and can&apos;t be edited here — change the salary
          structure instead. Income tax is entered, not computed: it depends on the declarations and regime choice this
          app doesn&apos;t hold.
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="incomeTax">Income tax (TDS)</Label>
            <Input id="incomeTax" type="number" value={incomeTax} onChange={(e) => setIncomeTax(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="otherDeduction">Other deduction</Label>
            <Input
              id="otherDeduction"
              type="number"
              value={otherDeduction}
              onChange={(e) => setOtherDeduction(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="otherNote">What the other deduction is for</Label>
          <Input
            id="otherNote"
            value={otherDeductionNote}
            onChange={(e) => setOtherDeductionNote(e.target.value)}
            placeholder="Salary advance, asset recovery…"
          />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button disabled={pending} onClick={submit}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-1 text-lg font-semibold text-text">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
