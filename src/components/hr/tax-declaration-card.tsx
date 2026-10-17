"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Receipt } from "lucide-react";
import { saveTaxDeclaration, type TaxDeclarationView } from "@/actions/payroll";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";

const yearLabel = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, "0")}`;

type Field = keyof Omit<TaxDeclarationView, "taxYear" | "regime" | "note" | "updatedAt">;
const OLD_REGIME: { key: Field; label: string; hint?: string }[] = [
  { key: "hraExemption", label: "HRA exemption", hint: "for the year, worked out on their rent receipts" },
  { key: "section80C", label: "80C", hint: "besides their PF — Deskzo adds that; the year's limit is ₹1,50,000" },
  { key: "section80CCD1B", label: "80CCD(1B)", hint: "their own NPS, up to ₹50,000" },
  { key: "section80D", label: "80D", hint: "health insurance" },
  { key: "homeLoanInterest", label: "Home-loan interest", hint: "a home they live in, up to ₹2,00,000" },
  { key: "otherDeductions", label: "Other deductions" },
];
const PREVIOUS: { key: Field; label: string }[] = [
  { key: "previousGross", label: "Salary" },
  { key: "previousTds", label: "TDS deducted" },
  { key: "previousPt", label: "Professional tax" },
  { key: "previousPf", label: "Their PF" },
];

/**
 * Income tax, for working out TDS (owner, 17 Oct 2026): the regime somebody is on this tax year, what
 * they've declared under the old one, and pay this year that didn't go through Deskzo — a previous
 * employer's (Form 122), or the company's own payroll before it moved here. Payroll sets it; the person
 * sees their own.
 */
export function TaxDeclarationCard({ userId, name, years, current, declarations, canEdit }: { userId: string; name: string; years: number[]; current: number; declarations: TaxDeclarationView[]; canEdit: boolean }) {
  const [year, setYear] = useState(current);
  const [editing, setEditing] = useState(false);
  const d = declarations.find((x) => x.taxYear === year) ?? declarations[0];
  if (!d) return null;
  const previous = d.previousGross > 0;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>Income tax</span>
        <span className="flex items-center gap-2">
          {years.length > 1 && (
            <select className="rounded-base border border-line bg-surface px-2 py-1 text-xs" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Tax year">
              {years.map((y) => (
                <option key={y} value={y}>
                  {yearLabel(y)}
                </option>
              ))}
            </select>
          )}
          {canEdit && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              <Receipt className="mr-1 h-3.5 w-3.5" />
              Declaration
            </Button>
          )}
        </span>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-muted">Regime, {yearLabel(d.taxYear)}</span>
          <span className="font-medium text-text">{d.regime === "NEW" ? "New (the default)" : "Old"}</span>
        </div>
        {d.regime === "OLD" &&
          OLD_REGIME.filter((f) => d[f.key] > 0).map((f) => (
            <div key={f.key} className="flex justify-between gap-3">
              <span className="text-muted">{f.label}</span>
              <span className="tabular-nums text-text">{formatCurrency(d[f.key])}</span>
            </div>
          ))}
        {previous && (
          <div className="flex justify-between gap-3">
            <span className="text-muted">Paid outside Deskzo this year</span>
            <span className="tabular-nums text-text">
              {formatCurrency(d.previousGross)}, TDS {formatCurrency(d.previousTds)}
            </span>
          </div>
        )}
        <p className="pt-1 text-xs text-subtle">Each month&apos;s TDS is worked out from this, the year&apos;s payslips so far and the months to come.</p>
      </CardContent>
      {editing && <DeclarationDialog userId={userId} name={name} declaration={d} onClose={() => setEditing(false)} />}
    </Card>
  );
}

function DeclarationDialog({ userId, name, declaration, onClose }: { userId: string; name: string; declaration: TaxDeclarationView; onClose: () => void }) {
  const router = useRouter();
  const [regime, setRegime] = useState(declaration.regime);
  const [values, setValues] = useState<Record<Field, string>>(() => {
    const all = [...OLD_REGIME, ...PREVIOUS, { key: "otherIncome" as Field }, { key: "otherTds" as Field }];
    return Object.fromEntries(all.map((f) => [f.key, declaration[f.key] ? String(declaration[f.key]) : ""])) as Record<Field, string>;
  });
  const [note, setNote] = useState(declaration.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const field = (key: Field, label: string, hint?: string) => (
    <label key={key} className="block space-y-1">
      <span className="text-sm text-text">{label}</span>
      <Input inputMode="decimal" value={values[key]} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} placeholder="0" disabled={pending} />
      {hint && <span className="block text-xs text-subtle">{hint}</span>}
    </label>
  );

  return (
    <Dialog open onClose={onClose} title={`${name} — income tax, ${yearLabel(declaration.taxYear)}`} large>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            setError(null);
            const amounts = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim() === "" ? 0 : Number(v)]));
            const result = await saveTaxDeclaration({ userId, taxYear: declaration.taxYear, regime, note, ...amounts });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            onClose();
            router.refresh();
          });
        }}
      >
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-text">Regime</legend>
          <div className="flex flex-wrap gap-2">
            {(["NEW", "OLD"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRegime(r)}
                className={`rounded-base border px-3 py-1.5 text-sm ${regime === r ? "border-brand bg-brand-soft text-brand" : "border-line text-muted hover:text-text"}`}
                disabled={pending}
              >
                {r === "NEW" ? "New regime" : "Old regime"}
              </button>
            ))}
          </div>
          <p className="text-xs text-subtle">The new regime is the default in law; somebody who hasn&apos;t asked for the old one this year is taxed under it.</p>
        </fieldset>

        {regime === "OLD" && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-text">What they&apos;ve declared for the year, with evidence (Form 124)</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{OLD_REGIME.map((f) => field(f.key, f.label, f.hint))}</div>
          </fieldset>
        )}

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-text">Pay this tax year outside Deskzo</legend>
          <p className="text-xs text-subtle">From a previous employer (their Form 122), or your own payroll before you moved to Deskzo.</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{PREVIOUS.map((f) => field(f.key, f.label))}</div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-text">Other income they&apos;ve asked to be taxed through salary</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {field("otherIncome", "Income")}
            {field("otherTds", "Tax already deducted on it")}
          </div>
        </fieldset>

        <label className="block space-y-1">
          <span className="text-sm text-text">Note</span>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. declaration of 12 Apr, proofs checked 5 Jan" disabled={pending} />
        </label>

        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
