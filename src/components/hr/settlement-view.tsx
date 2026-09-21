"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Calculator, Check, Wallet } from "lucide-react";
import type { getSettlement } from "@/actions/settlement";
import { buildSettlement, setSettlementStatus } from "@/actions/settlement";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/utils";

type Settlement = NonNullable<Awaited<ReturnType<typeof getSettlement>>>;

const num = (v: unknown) => Number(v ?? 0);

/**
 * One person's full and final settlement.
 *
 * Earnings and deductions are shown as two columns that meet at a single net figure, because that
 * figure is the only thing anybody actually argues about and everything above it is the working.
 */
export function SettlementView({
  settlement,
  userId,
  userName,
  canManage,
}: {
  settlement: Settlement | null;
  userId: string;
  userName: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [adjusting, setAdjusting] = useState(false);

  function build() {
    setError(null);
    startTransition(async () => {
      const result = await buildSettlement(userId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setWarnings(result.data.warnings);
      router.refresh();
    });
  }

  function move(status: "APPROVED" | "PAID" | "DRAFT") {
    setError(null);
    startTransition(async () => {
      const result = await setSettlementStatus(userId, status);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  if (!settlement) {
    return (
      <Card className="px-4 py-10 text-center">
        <Calculator className="mx-auto h-6 w-6 text-subtle" />
        <p className="mt-2 text-sm text-muted">No settlement prepared for {userName}.</p>
        {canManage && (
          <>
            <Button className="mt-3" disabled={pending} onClick={build}>
              {pending ? "Calculating…" : "Prepare settlement"}
            </Button>
            {error && <p className="mt-2 text-sm text-danger">{error}</p>}
          </>
        )}
      </Card>
    );
  }

  const draft = settlement.status === "DRAFT";
  const owes = num(settlement.netPayable) < 0;

  const earnings = [
    { label: `Salary for ${num(settlement.salaryDays)} day(s)`, value: num(settlement.salaryAmount) },
    {
      label: `Leave encashment — ${num(settlement.leaveEncashDays)} day(s)`,
      value: num(settlement.leaveEncashAmount),
    },
    { label: "Gratuity", value: num(settlement.gratuityAmount), note: settlement.gratuityNote },
    { label: "Statutory bonus", value: num(settlement.bonusAmount) },
    { label: settlement.otherEarningsNote || "Other earnings", value: num(settlement.otherEarnings) },
  ].filter((r) => r.value > 0 || r.label === "Gratuity");

  const deductions = [
    {
      label: `Notice shortfall — ${num(settlement.noticeShortfallDays)} day(s)`,
      value: num(settlement.noticeRecovery),
    },
    { label: "Provident fund", value: num(settlement.pfDeduction) },
    { label: "Professional tax", value: num(settlement.professionalTax) },
    { label: "Income tax", value: num(settlement.incomeTax) },
    { label: "Advance recovery", value: num(settlement.advanceRecovery) },
    { label: "Asset recovery", value: num(settlement.assetRecovery) },
    { label: settlement.otherDeductionNote || "Other deduction", value: num(settlement.otherDeduction) },
  ].filter((r) => r.value > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-text">Full &amp; final settlement</h2>
            <Badge tone={settlement.status === "PAID" ? "green" : settlement.status === "APPROVED" ? "blue" : "amber"}>
              {settlement.status}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-subtle">
            Last working day {formatDate(settlement.lastWorkingDay)} · {num(settlement.serviceYears)} completed year(s)
            {settlement.approvedBy && ` · approved by ${settlement.approvedBy.name}`}
          </p>
        </div>

        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {draft && (
              <>
                <Button variant="secondary" disabled={pending} onClick={() => setAdjusting(true)}>
                  Adjust
                </Button>
                <Button variant="secondary" disabled={pending} onClick={build}>
                  <Calculator className="mr-1.5 h-3.5 w-3.5" />
                  Recalculate
                </Button>
                <Button disabled={pending} onClick={() => move("APPROVED")}>
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                  Approve
                </Button>
              </>
            )}
            {settlement.status === "APPROVED" && (
              <>
                <Button variant="secondary" disabled={pending} onClick={() => move("DRAFT")}>
                  Reopen
                </Button>
                <Button disabled={pending} onClick={() => move("PAID")}>
                  <Wallet className="mr-1.5 h-3.5 w-3.5" />
                  Mark paid
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {(warnings.length > 0 || settlement.note) && draft && (
        <Card className="border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{warnings.length > 0 ? warnings.join(" ") : settlement.note}</span>
          </span>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="text-sm font-medium text-text">Payable</CardHeader>
          <CardContent className="space-y-2 text-sm">
            {earnings.map((r) => (
              <div key={r.label}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">{r.label}</span>
                  <span className="tabular-nums text-text">{formatCurrency(r.value)}</span>
                </div>
                {r.note && <p className="mt-0.5 text-xs text-subtle">{r.note}</p>}
              </div>
            ))}
            <div className="flex items-baseline justify-between border-t border-line pt-2 font-medium">
              <span className="text-text">Gross payable</span>
              <span className="tabular-nums text-text">{formatCurrency(num(settlement.grossPayable))}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="text-sm font-medium text-text">Recoverable</CardHeader>
          <CardContent className="space-y-2 text-sm">
            {deductions.length === 0 && <p className="text-subtle">Nothing to recover.</p>}
            {deductions.map((r) => (
              <div key={r.label} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">{r.label}</span>
                <span className="tabular-nums text-text">{formatCurrency(r.value)}</span>
              </div>
            ))}
            <div className="flex items-baseline justify-between border-t border-line pt-2 font-medium">
              <span className="text-text">Total deductions</span>
              <span className="tabular-nums text-text">{formatCurrency(num(settlement.totalDeductions))}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className={owes ? "border-danger/50" : "border-success/50"}>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <span className="text-sm font-medium uppercase tracking-wide text-muted">
            {owes ? "Recoverable from the employee" : "Net payable"}
          </span>
          <span className={`text-2xl font-bold tabular-nums ${owes ? "text-danger" : "text-text"}`}>
            {formatCurrency(Math.abs(num(settlement.netPayable)))}
          </span>
        </CardContent>
      </Card>

      {owes && (
        <p className="text-xs text-muted">
          Nothing is paid out. This has to be recovered before a no-dues certificate can be issued.
        </p>
      )}

      {settlement.status !== "DRAFT" && (
        <Link href={`/people/${userId}`} className="inline-block text-sm text-brand hover:underline">
          Issue the relieving and no-dues letters from the personnel file →
        </Link>
      )}

      {adjusting && <AdjustDialog userId={userId} settlement={settlement} onClose={() => setAdjusting(false)} />}
    </div>
  );
}

/**
 * The discretionary figures.
 *
 * Gratuity, encashment and notice recovery are absent from this form on purpose: they are computed
 * from the Acts and the record, and a box to type them in is a box to get them wrong in.
 */
function AdjustDialog({
  userId,
  settlement,
  onClose,
}: {
  userId: string;
  settlement: Settlement;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    bonusAmount: String(num(settlement.bonusAmount)),
    otherEarnings: String(num(settlement.otherEarnings)),
    otherEarningsNote: settlement.otherEarningsNote ?? "",
    advanceRecovery: String(num(settlement.advanceRecovery)),
    assetRecovery: String(num(settlement.assetRecovery)),
    otherDeduction: String(num(settlement.otherDeduction)),
    otherDeductionNote: settlement.otherDeductionNote ?? "",
    incomeTax: String(num(settlement.incomeTax)),
    professionalTax: String(num(settlement.professionalTax)),
    pfDeduction: String(num(settlement.pfDeduction)),
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await buildSettlement(userId, {
        bonusAmount: Number(form.bonusAmount) || 0,
        otherEarnings: Number(form.otherEarnings) || 0,
        otherEarningsNote: form.otherEarningsNote,
        advanceRecovery: Number(form.advanceRecovery) || 0,
        assetRecovery: Number(form.assetRecovery) || 0,
        otherDeduction: Number(form.otherDeduction) || 0,
        otherDeductionNote: form.otherDeductionNote,
        incomeTax: Number(form.incomeTax) || 0,
        professionalTax: Number(form.professionalTax) || 0,
        pfDeduction: Number(form.pfDeduction) || 0,
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
    <Dialog open onClose={onClose} title="Adjust the settlement">
      <div className="space-y-4">
        <p className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-xs text-muted">
          Gratuity, leave encashment and notice recovery aren&apos;t here — they come from the Acts and the record,
          and recalculating picks up any change to those. These are the figures somebody decides.
        </p>

        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ["bonusAmount", "Statutory bonus"],
              ["otherEarnings", "Other earnings"],
              ["advanceRecovery", "Advance recovery"],
              ["assetRecovery", "Asset recovery"],
              ["otherDeduction", "Other deduction"],
              ["incomeTax", "Income tax"],
              ["professionalTax", "Professional tax"],
              ["pfDeduction", "Provident fund"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={key}>{label}</Label>
              <Input id={key} type="number" value={form[key]} onChange={set(key)} />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="oeNote">What the other earning is</Label>
            <Input id="oeNote" value={form.otherEarningsNote} onChange={set("otherEarningsNote")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="odNote">What the other deduction is</Label>
            <Input id="odNote" value={form.otherDeductionNote} onChange={set("otherDeductionNote")} />
          </div>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button disabled={pending} onClick={submit}>
            {pending ? "Recalculating…" : "Save and recalculate"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
